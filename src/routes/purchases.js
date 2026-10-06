const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { query, getConnection } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const purchaseStock = require('../services/purchaseStockService');
const invoiceOcr = require('../services/invoiceOcr');

// ─────────────────────────────────────────────────────────────────────────────
//  Purchases (Tally-style purchase voucher)
//  A purchase records everything Tally asks for while entering a Purchase
//  voucher: the party (supplier) details with GSTIN, the invoice reference, the
//  line items with their stock category / GST, the serial numbers behind a
//  quantity, HSN, and a free-text remark.
//  Nothing here talks to Tally — the voucher is stored in this app's own
//  database and only ever mirrors Tally's layout and field set.
// ─────────────────────────────────────────────────────────────────────────────

// Tally's default stock category for a purchase is a single GST bucket. Only
// 18% GST is used for now; the column stays free-text so more can be added
// later without a migration.
const DEFAULT_TAX_CATEGORY = '18% GST';

async function buildVoucherPrefix() {
  const today = new Date();
  const y = today.getFullYear();
  // Financial year in India runs April to March.
  const fyStart = today.getMonth() >= 3 ? y : y - 1;
  const fyEnd = (fyStart + 1) % 100;
  return `PUR-BCCS-${fyStart}-${String(fyEnd).padStart(2, '0')}`;
}

async function generateVoucherNo(client) {
  const prefix = await buildVoucherPrefix();
  const q = client ? client.query.bind(client) : query;
  const result = await q(
    `SELECT voucher_no FROM purchases WHERE voucher_no LIKE $1 ORDER BY voucher_no DESC LIMIT 1`,
    [prefix + '%']
  );
  let nextSeq = 1;
  if (result.rows.length > 0) {
    const m = String(result.rows[0].voucher_no).match(/(\d+)$/);
    nextSeq = (m ? parseInt(m[1], 10) : 0) + 1;
  }
  return `${prefix}/${String(nextSeq).padStart(3, '0')}`;
}

async function ensureTables(client) {
  const q = client ? client.query.bind(client) : query;
  await q(`
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      voucher_no VARCHAR(60) NOT NULL UNIQUE,
      purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
      -- Party / supplier (Tally: Party A ledger + details)
      party_name VARCHAR(200) NOT NULL,
      party_gstin VARCHAR(20) DEFAULT NULL,
      party_address TEXT DEFAULT NULL,
      party_city VARCHAR(100) DEFAULT NULL,
      party_state VARCHAR(100) DEFAULT NULL,
      party_pincode VARCHAR(10) DEFAULT NULL,
      party_phone VARCHAR(20) DEFAULT NULL,
      party_email VARCHAR(191) DEFAULT NULL,
      contact_person VARCHAR(150) DEFAULT NULL,
      -- Supplier invoice reference
      invoice_no VARCHAR(80) DEFAULT NULL,
      invoice_date DATE DEFAULT NULL,
      -- Amounts
      subtotal DECIMAL(12,2) DEFAULT 0.00,
      tax_rate DECIMAL(5,2) DEFAULT 18.00,
      tax_amount DECIMAL(12,2) DEFAULT 0.00,
      total_amount DECIMAL(12,2) DEFAULT 0.00,
      remark TEXT DEFAULT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Completed',
      created_by VARCHAR(100) DEFAULT 'System',
      store_id INTEGER DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await q(`
    CREATE TABLE IF NOT EXISTS purchase_items (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL DEFAULT 1,
      item_name VARCHAR(255) NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT '18% GST',
      quantity INTEGER NOT NULL DEFAULT 1,
      rate DECIMAL(12,2) DEFAULT 0.00,
      amount DECIMAL(12,2) DEFAULT 0.00,
      hsn_code VARCHAR(20) DEFAULT '',
      serials JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_purchases_store_id ON purchases(store_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_purchases_party_name ON purchases(LOWER(party_name))`);
  await q(`CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items(purchase_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_purchase_items_item_name ON purchase_items(LOWER(item_name))`);
  // Invoice-import audit trail. Every column is optional, so a purchase entered
  // by hand is byte-for-byte what it always was; only a purchase created from a
  // scanned invoice fills these in, which is what makes it possible to answer
  // "where did this voucher come from?" during an audit.
  await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS source VARCHAR(40) DEFAULT NULL`);
  await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS ocr_processed BOOLEAN NOT NULL DEFAULT FALSE`);
  await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS ocr_processed_at TIMESTAMP DEFAULT NULL`);
  await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS ocr_confidence DECIMAL(4,3) DEFAULT NULL`);
  await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS invoice_document_name VARCHAR(255) DEFAULT NULL`);
  await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS invoice_document_type VARCHAR(60) DEFAULT NULL`);
  await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS invoice_document_path VARCHAR(400) DEFAULT NULL`);
  // Store separation: existing purchases stay with the default (Blue Chip) store.
  await q(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS store_id INTEGER DEFAULT NULL`);
  await q(`
    UPDATE purchases SET store_id = COALESCE(
      (SELECT id FROM stores WHERE is_default = true AND is_active = true ORDER BY id LIMIT 1),
      (SELECT id FROM stores ORDER BY id LIMIT 1)
    ) WHERE store_id IS NULL
  `);
}

// Normalises the raw line items posted by the web / mobile forms.
function parseItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      lineNo: parseInt(item.lineNo) || index + 1,
      itemName: String(item.itemName || item.item_name || '').trim(),
      // One GST category for now, but an existing value is always honoured.
      category: String(item.category || DEFAULT_TAX_CATEGORY).trim() || DEFAULT_TAX_CATEGORY,
      quantity: Math.max(1, parseInt(item.quantity, 10) || 1),
      rate: parseFloat(item.rate) || 0,
      amount: parseFloat(item.amount),
      hsnCode: item.hsnCode != null ? String(item.hsnCode).trim() : (item.hsn_code != null ? String(item.hsn_code).trim() : ''),
      // Serial numbers: one entry per unit. A blank unit is dropped, matching
      // Tally where a serial is only needed for tracked stock.
      serials: (Array.isArray(item.serials) ? item.serials : [])
        .map(s => String(s == null ? '' : s).trim())
        .filter(Boolean),
    }))
    .filter(item => item.itemName);
}

const sumAmounts = (items) => items.reduce((sum, i) => sum + (parseFloat(i.amount) || 0), 0);

function computeTotals(items, taxRate) {
  const subtotal = sumAmounts(items);
  const rate = parseFloat(taxRate) || 0;
  const taxAmount = subtotal * rate / 100;
  return { subtotal, taxAmount, totalAmount: subtotal + taxAmount };
}

// GET /api/purchases - list purchases (store scoped)
router.get('/', authenticate, async (req, res, next) => {
  try {
    await ensureTables();
    const { search, store_id, from, to, page = 1, limit = 50 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (store_id) {
      where += ` AND p.store_id = $${params.length + 1}`;
      params.push(parseInt(store_id));
    }
    if (from) {
      where += ` AND p.purchase_date >= $${params.length + 1}`;
      params.push(from);
    }
    if (to) {
      where += ` AND p.purchase_date <= $${params.length + 1}`;
      params.push(to);
    }
    if (search) {
      where += ` AND (p.voucher_no ILIKE $${params.length + 1} OR p.party_name ILIKE $${params.length + 2} OR p.invoice_no ILIKE $${params.length + 3} OR p.party_gstin ILIKE $${params.length + 4})`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const limitNum = Math.max(1, parseInt(limit, 10) || 50);
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const offset = (pageNum - 1) * limitNum;

    const countResult = await query(`SELECT COUNT(*) as total FROM purchases p ${where}`, params);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    const dataResult = await query(
      `SELECT p.*,
              COALESCE(SUM(pi.quantity), 0) AS total_qty,
              COALESCE(json_agg(json_build_object(
                'id', pi.id,
                'lineNo', pi.line_no,
                'itemName', pi.item_name,
                'category', pi.category,
                'quantity', pi.quantity,
                'rate', pi.rate,
                'amount', pi.amount,
                'hsnCode', pi.hsn_code,
                'serials', pi.serials
              )) FILTER (WHERE pi.id IS NOT NULL), '[]'::json) AS items
       FROM purchases p
       LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
       ${where}
       GROUP BY p.id
       ORDER BY p.purchase_date DESC, p.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limitNum, offset]
    );

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/purchases/next-number - next voucher number
router.get('/next-number', authenticate, async (_req, res, next) => {
  try {
    await ensureTables();
    const number = await generateVoucherNo();
    res.json({ success: true, data: { number, date: new Date().toISOString().slice(0, 10) } });
  } catch (err) {
    next(err);
  }
});

// GET /api/purchases/party-suggestions - Tally style party autocomplete.
// Typing the first letters of a party used in an earlier purchase returns it
// together with its saved GSTIN and address, so the details do not have to be
// typed again.
router.get('/party-suggestions', authenticate, async (req, res, next) => {
  try {
    await ensureTables();
    const { q = '', store_id } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (store_id) {
      where += ` AND store_id = $${params.length + 1}`;
      params.push(parseInt(store_id));
    }
    const term = String(q || '').trim();
    if (term) {
      where += ` AND party_name ILIKE $${params.length + 1}`;
      params.push(`%${term}%`);
    }
    params.push(`${term}%`);
    const prefixParam = `$${params.length}`;
    const result = await query(
      `SELECT party_name, party_gstin, party_address, party_city, party_state,
              party_pincode, party_phone, party_email, contact_person
       FROM purchases ${where}
       ORDER BY party_name ILIKE ${prefixParam} ASC, party_name ASC
       LIMIT 20`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/purchases/item-suggestions - Tally style stock item autocomplete.
// Every item bought before is offered by name so only the first few letters
// have to be typed. The last used category / rate / HSN comes back with it.
router.get('/item-suggestions', authenticate, async (req, res, next) => {
  try {
    await ensureTables();
    const { q = '', store_id } = req.query;
    const params = [];
    let storeClause = '';
    if (store_id) {
      params.push(parseInt(store_id));
      storeClause = ` AND p.store_id = $${params.length}`;
    }
    const term = String(q || '').trim();
    let searchClause = '';
    if (term) {
      // Numbered from the current length so the store filter and the search
      // term can never collide on the same $n.
      searchClause = ` AND pi.item_name ILIKE $${params.length + 1}`;
      params.push(`%${term}%`);
    }
    params.push(`${term}%`);
    const prefixParam = `$${params.length}`;
    const result = await query(
      `SELECT pi.item_name,
              MAX(pi.category) AS category,
              MAX(pi.rate) AS last_rate,
              MAX(pi.hsn_code) AS hsn_code,
              MAX(pi.created_at) AS last_used
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       WHERE 1=1 ${storeClause} ${searchClause}
       GROUP BY pi.item_name
       ORDER BY pi.item_name ILIKE ${prefixParam} ASC, pi.item_name ASC
       LIMIT 20`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/purchases/stock/search - stock lookup for the ticket's
// "Service Items & Price" box. Typing the first few letters of an item that was
// bought before brings it back with how many units are still in hand.
//
// No rate is returned on purpose: the price on a service item is always typed
// by hand, so nothing here can pre-fill it.
router.get('/stock/search', authenticate, async (req, res, next) => {
  try {
    const { q = '', store_id, limit } = req.query;
    const data = await purchaseStock.searchPurchasedItems({
      term: q,
      storeId: store_id,
      limit,
    });
    // `availableQty` is echoed back on every row so a client can tell "no such
    // item" apart from "all of it has already been used".
    res.json({ success: true, data, count: data.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/purchases/consumptions - the "sold items" view: what each ticket has
// drawn out of purchases, with the serials of the units taken. This is the only
// screen where a consumed serial number is shown.
router.get('/consumptions', authenticate, async (req, res, next) => {
  try {
    const { store_id, ticket_id, item_name, search, page = 1, limit = 50 } = req.query;
    const limitNum = Math.max(1, parseInt(limit, 10) || 50);
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const { rows, total } = await purchaseStock.listConsumptions({
      storeId: store_id,
      ticketId: ticket_id,
      itemName: item_name,
      search,
      limit: limitNum,
      offset: (pageNum - 1) * limitNum,
    });
    res.json({
      success: true,
      data: rows,
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Invoice import (Scan / Upload)
//
//  Reads a photographed or uploaded supplier invoice and returns everything it
//  could understand — supplier, GSTIN, invoice number and date, every line item
//  with its HSN, quantity, pre-tax rate and serial numbers, the GST that was
//  actually charged, and the totals — each field carrying a confidence value.
//
//  This route deliberately writes nothing. It returns a *draft* that the New
//  Purchase form is filled from, and the user then reviews and saves it through
//  the ordinary purchase endpoints. An OCR result is never allowed to reach the
//  database on its own, because OCR gets 0 and O and 1 and I wrong, and a wrong
//  GSTIN, serial number or rate is expensive to discover later.
//
//  Everything is processed in-process with open-source tools; the invoice is
//  never sent to a third party and nothing is written to disk here.
// ─────────────────────────────────────────────────────────────────────────────

const INVOICE_DOC_DIR = path.join(__dirname, '..', '..', 'uploads', 'purchase-invoices');

// GET /api/purchases/invoice-ocr/status - is the reader ready, and can this
// build enhance photos? The UI uses it to explain itself before a user tries.
router.get('/invoice-ocr/status', authenticate, async (_req, res, next) => {
  try {
    const engine = await invoiceOcr.warmUp();
    res.json({
      success: true,
      data: {
        available: Boolean(engine.ready),
        error: engine.error || null,
        offline: Boolean(engine.localLanguageData),
        imageEnhancement: invoiceOcr.preprocessAvailable(),
        acceptedFormats: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
        maxFileBytes: invoiceOcr.MAX_FILE_BYTES,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases/invoice-ocr/extract - read an invoice and return a draft.
//
// The file arrives the same way every other upload in this app does: base64 in
// the JSON body. That keeps the endpoint free of any new multipart handling and
// works identically from the web app and from the mobile app.
router.post('/invoice-ocr/extract', authenticate, async (req, res, next) => {
  try {
    const {
      fileName = '', fileType = '', fileData = '',
      ownCompany = {}, storeId = null, checkDuplicates = true, dpi = null,
    } = req.body || {};

    if (!fileData) {
      return res.status(400).json({ success: false, message: 'No invoice file was received.' });
    }

    let buffer;
    try {
      buffer = Buffer.from(String(fileData), 'base64');
    } catch (err) {
      buffer = null;
    }
    if (!buffer || !buffer.length) {
      return res.status(400).json({ success: false, message: 'The invoice file could not be read.' });
    }

    const result = await invoiceOcr.extractInvoice({
      buffer,
      fileName,
      mimeType: fileType,
      // Who "we" are. This is what lets the reader tell a purchase invoice from
      // one of our own sales invoices — the difference between a supplier and a
      // customer, and the single most expensive mistake this feature could make.
      ownCompany: {
        name: ownCompany.name || ownCompany.companyName || '',
        gstin: ownCompany.gstin || ownCompany.partyGstin || '',
      },
      storeId: storeId != null && storeId !== '' ? parseInt(storeId, 10) : null,
      checkDuplicates: checkDuplicates !== false,
      dpi: Number(dpi) > 0 ? Number(dpi) : null,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    if (err && err.code && err.status) {
      // A problem with the file itself (unsupported format, too large, empty) —
      // reported as-is so the user gets a message they can act on.
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    console.error('[InvoiceOCR] extraction failed:', err && err.message);
    res.status(500).json({
      success: false,
      message: 'We could not read this invoice. Please try a clearer image or enter the purchase manually.',
    });
  }
});

// POST /api/purchases/invoice-ocr/check-duplicate - has this supplier invoice
// already been entered? Run again after the user edits the party or invoice
// number, and always before an OCR-sourced purchase is saved.
router.post('/invoice-ocr/check-duplicate', authenticate, async (req, res, next) => {
  try {
    const { partyName, invoiceNo, gstin, storeId, excludePurchaseId } = req.body || {};
    const result = await invoiceOcr.duplicateCheck({
      partyName,
      invoiceNo,
      gstin,
      storeId: storeId != null && storeId !== '' ? parseInt(storeId, 10) : null,
      excludePurchaseId: excludePurchaseId != null && excludePurchaseId !== '' ? parseInt(excludePurchaseId, 10) : null,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases/invoice-ocr/check-serials - do these serial numbers
// already exist in purchased stock? A serial that is already recorded belongs to
// a unit physically in the shop, so entering it twice would put two stock
// records behind one device.
router.post('/invoice-ocr/check-serials', authenticate, async (req, res, next) => {
  try {
    const { serials = [], storeId, excludePurchaseId } = req.body || {};
    const result = await invoiceOcr.serialCheck({
      serials: Array.isArray(serials) ? serials : [],
      storeId: storeId != null && storeId !== '' ? parseInt(storeId, 10) : null,
      excludePurchaseId: excludePurchaseId != null && excludePurchaseId !== '' ? parseInt(excludePurchaseId, 10) : null,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * Saves the invoice file the user confirmed, and links it to the purchase.
 * Only called from the purchase endpoints, i.e. after the user has already
 * reviewed the entry — so nothing about an invoice is retained before that.
 *
 * Returns `{ path, previousPath }`. The previous file is reported rather than
 * deleted here, so it can be removed once the transaction has actually
 * committed: losing an attachment must never leave a purchase pointing at a file
 * that is no longer there.
 */
async function attachInvoiceDocument(client, purchaseId, document) {
  const q = client ? client.query.bind(client) : query;
  const raw = document && typeof document === 'object' ? document : null;
  if (!raw || raw.keep === false) return null;
  if (!raw.data) return null;

  const fileName = String(raw.fileName || 'invoice').replace(/[^\w.\-]+/g, '_').slice(-120);
  const fileType = String(raw.fileType || '').slice(0, 60);
  let buffer;
  try {
    buffer = Buffer.from(String(raw.data), 'base64');
  } catch (err) {
    buffer = null;
  }
  if (!buffer || !buffer.length) return null;

  const existing = await q('SELECT invoice_document_path FROM purchases WHERE id = $1', [purchaseId]);
  const storedName = `${purchaseId}_${fileName}`;
  const relative = path.join('purchase-invoices', storedName);
  const absolute = path.join(INVOICE_DOC_DIR, storedName);

  try {
    fs.mkdirSync(INVOICE_DOC_DIR, { recursive: true });
    fs.writeFileSync(absolute, buffer);
  } catch (err) {
    console.error('[InvoiceOCR] could not store the invoice file:', err.message);
    return null;
  }

  await q(
    `UPDATE purchases
        SET invoice_document_name = $2,
            invoice_document_type = $3,
            invoice_document_path = $4,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [purchaseId, fileName, fileType, relative]
  );

  const previous = existing.rows[0]?.invoice_document_path;
  return {
    path: `/uploads/${relative.split(path.sep).join('/')}`,
    previousPath: previous && previous !== relative
      ? path.join(path.join(__dirname, '..', '..', 'uploads'), previous)
      : null,
  };
}

/** Removes a replaced invoice file, once the purchase itself is safely saved. */
function removeStaleInvoiceFile(previousPath) {
  if (!previousPath) return;
  try {
    // Only ever inside the purchase-invoices folder.
    if (!previousPath.startsWith(INVOICE_DOC_DIR + path.sep)) return;
    if (fs.existsSync(previousPath)) fs.unlinkSync(previousPath);
  } catch (err) {
    console.error('[InvoiceOCR] could not remove the replaced invoice file:', err.message);
  }
}

/** Fills the invoice-import audit columns. Optional in every request. */
function ocrAuditFields(body) {
  const ocr = body && body.ocr ? body.ocr : null;
  if (!ocr || ocr.processed !== true) return null;
  const confidence = parseFloat(ocr.confidence);
  return {
    source: 'OCR Invoice Import',
    ocrProcessed: true,
    ocrProcessedAt: new Date().toISOString(),
    ocrConfidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
  };
}

// GET /api/purchases/:id - one purchase with its items
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    // Guard the id: without this a request for a mistyped path such as
    // /api/purchases/consumptions reaches this route when it is running against
    // an older build, and "consumptions" is handed to Postgres as an integer.
    if (!/^\d+$/.test(String(req.params.id))) {
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }
    await ensureTables();
    const result = await query('SELECT * FROM purchases WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }
    const items = await query(
      'SELECT id, line_no, item_name, category, quantity, rate, amount, hsn_code, serials FROM purchase_items WHERE purchase_id = $1 ORDER BY line_no ASC, id ASC',
      [req.params.id]
    );
    res.json({
      success: true,
      data: {
        ...result.rows[0],
        items: items.rows.map(i => ({
          id: i.id,
          line_no: i.line_no,
          item_name: i.item_name,
          category: i.category,
          quantity: i.quantity,
          rate: i.rate,
          amount: i.amount,
          hsn_code: i.hsn_code,
          serials: i.serials,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases - create a purchase voucher
router.post('/', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');
    await ensureTables(client);

    const {
      voucherNo, purchaseDate, partyName, partyGstin, partyAddress, partyCity,
      partyState, partyPincode, partyPhone, partyEmail, contactPerson,
      invoiceNo, invoiceDate, taxRate = 18, remark, status = 'Completed', storeId,
      items = [], invoiceDocument = null
    } = req.body;

    if (!partyName || !String(partyName).trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Party name is required' });
    }

    const parsedItems = parseItems(items);
    if (parsedItems.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Add at least one item to the purchase' });
    }

    let number = String(voucherNo || '').trim() || await generateVoucherNo(client);
    if (voucherNo) {
      const dup = await client.query('SELECT id FROM purchases WHERE voucher_no = $1', [number]);
      if (dup.rows.length > 0) number = await generateVoucherNo(client);
    }

    const { subtotal, taxAmount, totalAmount } = computeTotals(parsedItems, taxRate);

    // Invoice-import provenance. Absent for a purchase typed by hand, which
    // keeps those vouchers exactly as they were before this feature existed.
    const audit = ocrAuditFields(req.body);

    const inserted = await client.query(
      `INSERT INTO purchases (
        voucher_no, purchase_date, party_name, party_gstin, party_address, party_city,
        party_state, party_pincode, party_phone, party_email, contact_person,
        invoice_no, invoice_date, subtotal, tax_rate, tax_amount, total_amount,
        remark, status, created_by, store_id,
        source, ocr_processed, ocr_processed_at, ocr_confidence
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      RETURNING *`,
      [
        number, purchaseDate || new Date().toISOString().slice(0, 10), String(partyName).trim(),
        partyGstin || null, partyAddress || null, partyCity || null, partyState || null,
        partyPincode || null, partyPhone || null, partyEmail || null, contactPerson || null,
        invoiceNo || null, invoiceDate || null, subtotal, parseFloat(taxRate) || 0,
        taxAmount, totalAmount, remark || null, status,
        (req.user && (req.user.full_name || req.user.name)) || 'System',
        storeId != null && storeId !== '' ? parseInt(storeId) : null,
        audit ? audit.source : null,
        audit ? audit.ocrProcessed : false,
        audit ? audit.ocrProcessedAt : null,
        audit ? audit.ocrConfidence : null,
      ]
    );

    const purchaseId = inserted.rows[0].id;
    for (const item of parsedItems) {
      const amount = isNaN(parseFloat(item.amount))
        ? item.quantity * (parseFloat(item.rate) || 0)
        : parseFloat(item.amount);
      await client.query(
        `INSERT INTO purchase_items (purchase_id, line_no, item_name, category, quantity, rate, amount, hsn_code, serials)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          purchaseId, item.lineNo, item.itemName, item.category, item.quantity,
          item.rate, amount, item.hsnCode, JSON.stringify(item.serials)
        ]
      );
    }

    // The scanned invoice is kept only now — after the user has confirmed the
    // entry — and only if they asked for it to be kept.
    const document = await attachInvoiceDocument(client, purchaseId, invoiceDocument);

    await client.query('COMMIT');
    removeStaleInvoiceFile(document?.previousPath);
    res.status(201).json({
      success: true,
      message: 'Purchase saved successfully',
      data: { ...inserted.rows[0], invoice_document_path: document?.path || null },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/purchases/:id - update a purchase voucher (items are replaced)
router.put('/:id', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    // Same guard as GET /:id — a non-numeric id is never handed to Postgres.
    if (!/^\d+$/.test(String(req.params.id))) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }
    await client.query('BEGIN');
    await ensureTables(client);

    const existing = await client.query('SELECT * FROM purchases WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }

    const {
      voucherNo, purchaseDate, partyName, partyGstin, partyAddress, partyCity,
      partyState, partyPincode, partyPhone, partyEmail, contactPerson,
      invoiceNo, invoiceDate, taxRate, remark, status, items, invoiceDocument = null
    } = req.body;

    const hasItems = Array.isArray(items);
    const parsedItems = hasItems ? parseItems(items) : null;
    if (hasItems && parsedItems.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Add at least one item to the purchase' });
    }

    const fieldMapping = {
      voucherNo: 'voucher_no',
      purchaseDate: 'purchase_date',
      partyName: 'party_name',
      partyGstin: 'party_gstin',
      partyAddress: 'party_address',
      partyCity: 'party_city',
      partyState: 'party_state',
      partyPincode: 'party_pincode',
      partyPhone: 'party_phone',
      partyEmail: 'party_email',
      contactPerson: 'contact_person',
      invoiceNo: 'invoice_no',
      invoiceDate: 'invoice_date',
      remark: 'remark',
      status: 'status',
    };

    const setClauses = [];
    const values = [];
    let idx = 1;
    for (const [front, db] of Object.entries(fieldMapping)) {
      if (req.body[front] !== undefined) {
        setClauses.push(`${db} = $${idx++}`);
        values.push(req.body[front]);
      }
    }

    const effectiveTaxRate = parseFloat(taxRate ?? existing.rows[0].tax_rate) || 0;
    if (parsedItems) {
      const { subtotal, taxAmount, totalAmount } = computeTotals(parsedItems, effectiveTaxRate);
      setClauses.push(`subtotal = $${idx++}`, `tax_rate = $${idx++}`, `tax_amount = $${idx++}`, `total_amount = $${idx++}`);
      values.push(subtotal, effectiveTaxRate, taxAmount, totalAmount);
    }

    if (setClauses.length > 0) {
      values.push(req.params.id);
      await client.query(
        `UPDATE purchases SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`,
        values
      );
    }

    // Re-saving an OCR-sourced voucher keeps its provenance current.
    const audit = ocrAuditFields(req.body);
    if (audit) {
      await client.query(
        `UPDATE purchases
            SET source = $2, ocr_processed = $3, ocr_processed_at = $4, ocr_confidence = $5,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [req.params.id, audit.source, audit.ocrProcessed, audit.ocrProcessedAt, audit.ocrConfidence]
      );
    }

    if (parsedItems) {
      await client.query('DELETE FROM purchase_items WHERE purchase_id = $1', [req.params.id]);
      for (const item of parsedItems) {
        const amount = isNaN(parseFloat(item.amount))
          ? item.quantity * (parseFloat(item.rate) || 0)
          : parseFloat(item.amount);
        await client.query(
          `INSERT INTO purchase_items (purchase_id, line_no, item_name, category, quantity, rate, amount, hsn_code, serials)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            req.params.id, item.lineNo, item.itemName, item.category, item.quantity,
            item.rate, amount, item.hsnCode, JSON.stringify(item.serials)
          ]
        );
      }
    }

    const document = await attachInvoiceDocument(client, parseInt(req.params.id, 10), invoiceDocument);

    await client.query('COMMIT');
    removeStaleInvoiceFile(document?.previousPath);
    const updated = await query('SELECT * FROM purchases WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Purchase updated successfully', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/purchases/:id - removes the voucher and its items
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    // Same guard as GET /:id — a non-numeric id is never handed to Postgres.
    if (!/^\d+$/.test(String(req.params.id))) {
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }
    await ensureTables();
    await query('DELETE FROM purchases WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Purchase deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;