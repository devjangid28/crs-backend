// ─────────────────────────────────────────────────────────────────────────────
//  Purchase stock
//
//  Purchased quantity becomes usable stock that a repair ticket can draw from.
//  When a ticket uses N units of an item, N units are deducted from the oldest
//  purchases first (FIFO) and the serial numbers of exactly those units are
//  recorded here.
//
//  Serial numbers are deliberately kept OUT of tickets.line_items: the service
//  invoice, inward receipt and every other print read that column, so this is
//  the only place a consumed serial is stored and the only place it is shown.
// ─────────────────────────────────────────────────────────────────────────────

async function ensureStockTables(client) {
  const q = client ? client.query.bind(client) : require('../config/database').query;
  await q(`
    CREATE TABLE IF NOT EXISTS purchase_item_consumptions (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER DEFAULT NULL,
      ticket_ref VARCHAR(40) DEFAULT NULL,
      purchase_id INTEGER NOT NULL,
      purchase_item_id INTEGER NOT NULL,
      voucher_no VARCHAR(60) DEFAULT NULL,
      item_name VARCHAR(255) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      serials JSONB DEFAULT '[]'::jsonb,
      rate DECIMAL(12,2) DEFAULT 0.00,
      store_id INTEGER DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_pic_ticket_id ON purchase_item_consumptions(ticket_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_pic_purchase_item_id ON purchase_item_consumptions(purchase_item_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_pic_item_name ON purchase_item_consumptions(LOWER(item_name))`);
}

// Candidate purchase lines for an item, oldest purchase first (FIFO).
async function candidateLines(client, itemName, storeId) {
  const params = [itemName.toLowerCase()];
  let storeClause = '';
  if (storeId) {
    params.push(parseInt(storeId));
    storeClause = ` AND p.store_id = $${params.length}`;
  }
  const res = await client.query(
    `SELECT pi.id AS purchase_item_id, pi.item_name, pi.quantity, pi.rate, pi.serials,
            p.id AS purchase_id, p.voucher_no, p.purchase_date,
            COALESCE((SELECT SUM(c.quantity) FROM purchase_item_consumptions c
                      WHERE c.purchase_item_id = pi.id), 0) AS used_qty,
            COALESCE((SELECT json_agg(c.serials) FROM purchase_item_consumptions c
                      WHERE c.purchase_item_id = pi.id AND c.serials IS NOT NULL), '[]'::json) AS used_serials
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     WHERE LOWER(pi.item_name) = $1 ${storeClause}
     ORDER BY p.purchase_date ASC, pi.id ASC`,
    params
  );
  return res.rows;
}

// Serials already handed out for a purchase line, flattened.
function usedSerialSet(usedSerials) {
  const set = new Set();
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(v => {
        // json_agg of jsonb arrays nests one level deeper than expected.
        if (Array.isArray(v)) v.forEach(inner => typeof inner === 'string' && inner.trim() && set.add(inner.trim()));
        else if (typeof v === 'string' && v.trim()) set.add(v.trim());
      });
    } else if (typeof value === 'string' && value.trim()) {
      set.add(value.trim());
    }
  };
  visit(usedSerials);
  return set;
}

/**
 * Purchased items available to draw from, matched on the first letters of the
 * name. Returns the available quantity only — deliberately no rate, so the
 * caller cannot accidentally pre-fill a price.
 */
async function searchPurchasedItems({ term, storeId, limit = 20, client = null }) {
  const q = client ? client.query.bind(client) : require('../config/database').query;
  await ensureStockTables(client);
  const text = String(term || '').trim();
  if (text.length < 3) return [];

  // Placeholders are numbered in the order the values are pushed, so the store
  // filter, the ORDER BY prefix and the LIMIT can never claim the same $n.
  // $1 is the search term wrapped in wildcards — without them ILIKE would only
  // ever match an item whose name is exactly the typed text, which is why the
  // suggestion list came back empty.
  const params = [`%${text.toLowerCase()}%`];
  let storeClause = '';
  if (storeId) {
    params.push(parseInt(storeId));
    storeClause = ` AND p.store_id = $${params.length}`;
  }
  params.push(`${text.toLowerCase()}%`); // prefix match, puts the closest name first
  const prefixParam = `$${params.length}`;
  params.push(Math.max(1, Math.min(100, parseInt(limit, 10) || 20)));
  const limitParam = `$${params.length}`;

  const res = await q(
    `SELECT pi.item_name,
            SUM(pi.quantity) AS purchased_qty,
            SUM(pi.quantity) - COALESCE(SUM(used.used_qty), 0) AS available_qty,
            MAX(pi.created_at) AS last_purchased
     FROM purchase_items pi
     JOIN purchases p ON p.id = pi.purchase_id
     LEFT JOIN LATERAL (
       SELECT c.purchase_item_id, SUM(c.quantity) AS used_qty
       FROM purchase_item_consumptions c
       GROUP BY c.purchase_item_id
     ) used ON used.purchase_item_id = pi.id
     WHERE LOWER(pi.item_name) ILIKE $1 ${storeClause}
     GROUP BY pi.item_name
     HAVING SUM(pi.quantity) - COALESCE(SUM(used.used_qty), 0) > 0
     ORDER BY pi.item_name ILIKE ${prefixParam} ASC, pi.item_name ASC
     LIMIT ${limitParam}`,
    params
  );

  return res.rows.map(r => ({
    itemName: r.item_name,
    purchasedQty: parseInt(r.purchased_qty, 10) || 0,
    availableQty: Math.max(0, parseInt(r.available_qty, 10) || 0),
    lastPurchased: r.last_purchased,
  }));
}

// Lines of a ticket that were picked from purchased stock.
function stockLinesFromTicketItems(rawItems) {
  let items = rawItems;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = null; }
  }
  if (!Array.isArray(items)) return [];
  return items
    .filter(it => it && (it.purchaseItemName || it.purchase_item_name))
    .map(it => {
      const qty = parseFloat(it.qty ?? it.quantity ?? 1) || 0;
      return {
        itemName: String(it.purchaseItemName || it.purchase_item_name).trim(),
        qty: qty > 0 ? Math.round(qty) : 0,
      };
    })
    .filter(l => l.itemName && l.qty > 0);
}

/**
 * Deducts the ticket's stock lines from the purchases, oldest first, and records
 * the serials of the units taken. Runs inside the caller's transaction so a
 * ticket can never exist without its stock movement.
 *
 * Never throws for insufficient stock: whatever is available is taken and the
 * shortfall is reported back, so a ticket is never blocked by stock.
 */
async function consumeForTicket({ client, ticketId, ticketRef, storeId, lineItems }) {
  await ensureStockTables(client);
  const lines = stockLinesFromTicketItems(lineItems);
  if (lines.length === 0) return { allocations: [], shortfalls: [] };

  const allocations = [];
  const shortfalls = [];

  for (const line of lines) {
    let remaining = line.qty;
    const candidates = await candidateLines(client, line.itemName, storeId);
    for (const cand of candidates) {
      if (remaining <= 0) break;
      const purchased = parseInt(cand.quantity, 10) || 0;
      const alreadyUsed = parseInt(cand.used_qty, 10) || 0;
      const available = purchased - alreadyUsed;
      if (available <= 0) continue;

      const take = Math.min(remaining, available);
      // Take the serials this line still holds free. A line may have fewer
      // serials than units (serial tracking is optional), so the rest simply
      // goes without one.
      const used = usedSerialSet(cand.used_serials);
      const pool = Array.isArray(cand.serials) ? cand.serials : [];
      const takenSerials = [];
      for (const s of pool) {
        if (takenSerials.length >= take) break;
        const value = String(s == null ? '' : s).trim();
        if (!value || used.has(value)) continue;
        takenSerials.push(value);
      }

      await client.query(
        `INSERT INTO purchase_item_consumptions
           (ticket_id, ticket_ref, purchase_id, purchase_item_id, voucher_no, item_name, quantity, serials, rate, store_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ticketId || null, ticketRef || null, cand.purchase_id, cand.purchase_item_id,
          cand.voucher_no || null, cand.item_name, take,
          JSON.stringify(takenSerials), parseFloat(cand.rate) || 0,
          storeId != null ? parseInt(storeId) : null,
        ]
      );

      allocations.push({
        itemName: cand.item_name,
        quantity: take,
        voucherNo: cand.voucher_no,
        purchaseId: cand.purchase_id,
        serials: takenSerials,
      });
      remaining -= take;
    }

    if (remaining > 0) {
      shortfalls.push({ itemName: line.itemName, requested: line.qty, shortBy: remaining });
    }
  }

  return { allocations, shortfalls };
}

/** Everything a ticket has drawn from purchases — the serial trail. */
async function listConsumptions({ storeId, ticketId, itemName, search, limit = 50, offset = 0, client = null }) {
  const q = client ? client.query.bind(client) : require('../config/database').query;
  await ensureStockTables(client);

  let where = 'WHERE 1=1';
  const params = [];
  if (storeId) {
    where += ` AND c.store_id = $${params.length + 1}`;
    params.push(parseInt(storeId));
  }
  if (ticketId) {
    where += ` AND c.ticket_id = $${params.length + 1}`;
    params.push(parseInt(ticketId));
  }
  if (itemName) {
    where += ` AND LOWER(c.item_name) = $${params.length + 1}`;
    params.push(String(itemName).toLowerCase());
  }
  if (search) {
    where += ` AND (LOWER(c.item_name) ILIKE $${params.length + 1} OR c.ticket_ref ILIKE $${params.length + 2} OR c.voucher_no ILIKE $${params.length + 3})`;
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  const countRes = await q(
    `SELECT COUNT(*) AS total FROM purchase_item_consumptions c ${where}`,
    params
  );

  const dataRes = await q(
    `SELECT c.*,
            COALESCE(t.ticket_id, c.ticket_ref) AS ticket_number,
            t.customer_name, t.device_type, t.brand, t.model, t.status AS ticket_status
     FROM purchase_item_consumptions c
     LEFT JOIN tickets t ON t.id = c.ticket_id
     ${where}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, Math.max(1, parseInt(limit, 10) || 50), Math.max(0, parseInt(offset, 10) || 0)]
  );

  return {
    rows: dataRes.rows,
    total: parseInt(countRes.rows[0]?.total, 10) || 0,
  };
}

/** Undoes a ticket's stock movements, so an edited ticket can be re-drawn. */
async function releaseForTicket({ client, ticketId }) {
  await ensureStockTables(client);
  if (!ticketId) return 0;
  const res = await client.query(
    'DELETE FROM purchase_item_consumptions WHERE ticket_id = $1',
    [ticketId]
  );
  return res.rowCount || 0;
}

module.exports = {
  ensureStockTables,
  searchPurchasedItems,
  consumeForTicket,
  listConsumptions,
  releaseForTicket,
};