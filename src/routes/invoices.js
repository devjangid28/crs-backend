const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { generateInvoicePdf } = require('../services/pdfGenerator');
const { createPdfMessage } = require('../services/messagingService');
const tallyService = require('../services/tallyService');

// GET /api/invoices - Get all invoices
router.get('/', async (req, res, next) => {
  try {
    const { search, status, page = 1, limit = 50 } = req.query;
    let sql = 'SELECT * FROM invoices WHERE 1=1';
    const params = [];

    if (search) {
      sql += ` AND (customer_name ILIKE ? OR invoice_id ILIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s);
    }
    if (status && status !== 'all') {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const invoicesResult = await query(sql, params);
    const countResult = await query('SELECT COUNT(*) as total FROM invoices', []);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    res.json({ success: true, data: invoicesResult.rows, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/:id
router.get('/:id', async (req, res, next) => {
  try {
    const invoicesResult = await query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    if (invoicesResult.rows.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found' });
    const invoice = invoicesResult.rows[0];
    const itemsResult = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
    invoice.items = itemsResult.rows;
    res.json({ success: true, data: invoice });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices - Create invoice
router.post('/', async (req, res, next) => {
  try {
    const {
      ticketId, orderId, customerId, customerName, invoiceNumber, issueDate, dueDate,
      paymentTerms, items, subtotal, taxRate, tax, discount, grandTotal,
      amountPaid, status, paymentMethod, billedBy, billedTo, notes,
      financeDownPayment, financeEmi, financeDuration
    } = req.body;

    const invId = invoiceNumber || `INV-${10000 + Date.now() % 100000}`;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Validate FK references before insert so a bad reference (e.g. a frontend
    // sending ticketId = order.id when no such ticket row exists) cannot abort
    // the whole invoice creation. Invalid refs are stored as NULL.
    const resolveRef = async (table, id) => {
      if (!id) return null;
      try {
        const ref = await query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
        return ref.rows.length > 0 ? id : null;
      } catch {
        return null;
      }
    };
    const ticketRef = await resolveRef('tickets', ticketId);
    const orderRef = await resolveRef('orders', orderId);
    const customerRef = await resolveRef('customers', customerId);

    const bbName = billedBy?.name || null;
    const bbAddr1 = billedBy?.address1 || null;
    const bbAddr2 = billedBy?.address2 || null;
    const btName = billedTo?.name || null;
    const btEmail = billedTo?.email || null;
    const btAddr1 = billedTo?.address1 || null;
    const btAddr2 = billedTo?.address2 || null;

    const result = await query(
      `INSERT INTO invoices (invoice_id, ticket_id, order_id, customer_id, customer_name, issue_date, due_date, payment_terms, subtotal, tax_rate, tax_amount, discount, total_amount, amount_paid, balance_due, status, payment_method, finance_down_payment, finance_emi, finance_duration, billed_by_name, billed_by_address1, billed_by_address2, billed_to_name, billed_to_email, billed_to_address1, billed_to_address2, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [invId, ticketRef, orderRef, customerRef, customerName || 'Unknown Customer', issueDate || null, dueDate || null, paymentTerms || paymentMethod || 'Cash',
       subtotal || 0, taxRate || 0, tax || 0, discount || 0, grandTotal || 0, amountPaid || 0, (grandTotal || 0) - (amountPaid || 0),
       status || 'Unpaid', paymentMethod || null, parseFloat(financeDownPayment) || null, parseFloat(financeEmi) || null,
       parseInt(financeDuration, 10) || null, bbName, bbAddr1, bbAddr2, btName, btEmail, btAddr1, btAddr2,
       notes || null, now, now]
    );

    const insertId = result.rows[0].id;

    if (items && Array.isArray(items)) {
      for (const item of items) {
        await query(
          `INSERT INTO invoice_items (invoice_id, name, description, sku, quantity, unit_price, total, tax_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [insertId, item.name || item.description || '', item.description || '', item.sku || '', item.qty || item.quantity || 1, item.unitPrice || item.price || 0, item.total || 0, item.taxRate || 0]
        );
      }
    }

    const invoiceResult = await query('SELECT * FROM invoices WHERE id = ?', [insertId]);
    const invoice = invoiceResult.rows[0];
    invoice.items = items || [];

    // Auto-mark inventory items as Sold and push Sales Voucher to Tally (fire-and-forget)
    if (items && Array.isArray(items) && items.length > 0) {
      setImmediate(async () => {
        try {
          // 1. Mark inventory items with serial numbers as Sold
          for (const item of items) {
            if (item.serialNumber || item.serial_number || item.inventoryItemId) {
              const serialNo = item.serialNumber || item.serial_number;
              const invItemId = item.inventoryItemId || item.inventory_item_id;
              try {
                if (invItemId) {
                  await query(
                    `UPDATE inventory_items SET status = 'Sold', updated_at = NOW() WHERE id = $1`,
                    [invItemId]
                  );
                } else if (serialNo) {
                  await query(
                    `UPDATE inventory_items SET status = 'Sold', updated_at = NOW() WHERE serial_number = $1 AND status != 'Sold'`,
                    [serialNo]
                  );
                }
                console.log(`[Invoice] Marked inventory item Sold: ${serialNo || invItemId}`);
              } catch (markErr) {
                console.error(`[Invoice] Failed to mark inventory Sold: ${serialNo || invItemId}:`, markErr.message);
              }
            }
          }

          // 2. Push Sales Voucher to Tally (with retry)
          try {
            // Look up correct Tally stock item names by serial number
            // Priority: 1) Tally serial map (actual stock items in Tally)  2) CRS inventory product_name  3) invoice item name
            const tallyItems = [];
            for (const item of items) {
              const serialNo = item.serialNumber || item.serial_number || '';
              let tallyName = item.name || item.description || 'Service';

              if (serialNo) {
                try {
                  const tallyStockName = await tallyService.lookupStockItemBySerial(serialNo);
                  if (tallyStockName) {
                    tallyName = tallyStockName;
                    console.log(`[Invoice] Tally serial lookup: "${serialNo}" -> "${tallyName}"`);
                  } else {
                    // Fallback 1: reuse the Tally stock item name that actually holds the
                    // stock for this serial (the per-serial "{product} [{serial}]" item pushed
                    // on add, or the purchase-push name). This matches where the quantity
                    // lives even if the CRS product_name was renamed afterwards.
                    const syncLookup = await query(
                      `SELECT stock_item_name FROM tally_sync_log
                       WHERE serial_number = $1 AND sync_status = 'stock_pushed'
                       ORDER BY id DESC LIMIT 1`,
                      [serialNo]
                    );
                    if (syncLookup.rows.length > 0 && syncLookup.rows[0].stock_item_name) {
                      tallyName = syncLookup.rows[0].stock_item_name;
                      console.log(`[Invoice] Tally sync-log fallback: "${serialNo}" -> "${tallyName}"`);
                    } else {
                      const invLookup = await query(
                        `SELECT product_name FROM inventory_items WHERE serial_number = $1`,
                        [serialNo]
                      );
                      if (invLookup.rows.length > 0) {
                        tallyName = invLookup.rows[0].product_name;
                        console.log(`[Invoice] CRS fallback: "${serialNo}" -> "${tallyName}"`);
                      }
                    }
                  }
                } catch (lookupErr) {
                  console.error(`[Invoice] Stock item lookup failed for serial ${serialNo}:`, lookupErr.message);
                }
              }

              // Always use 'Primary' batch (no explicit BATCHALLOCATIONS.LIST) so Tally
              // auto-allocates the stock from its available batch. This is the same XML
              // structure as the working push method and is what makes the quantity
              // decrease in Tally. Passing the serial as a batch name creates a voucher
              // that shows as synced but does NOT reduce stock.
              const batch = 'Primary';

              tallyItems.push({
                name: tallyName,
                description: item.description || '',
                serialNumber: serialNo,
                qty: item.qty || item.quantity || 1,
                price: item.unitPrice || item.price || 0,
                discount: item.discount || 0,
                batch: batch,
                skipInventory: !serialNo,
              });
            }

            let vchDate = null;
            if (issueDate) {
              const d = new Date(issueDate);
              if (!isNaN(d.getTime())) vchDate = d.toISOString().slice(0, 10).replace(/-/g, '');
            }

            // Party billing/shipping details from the customer master (or the invoice's
            // billedTo block). These populate the Tally-printed invoice's party header.
            let partyState = '';
            let partyPincode = '';
            let partyPlace = '';
            let partyAddress = null;
            try {
              if (customerRef) {
                const cust = await query(
                  `SELECT name, company, address, address_line2, city, state, postcode FROM customers WHERE id = $1`,
                  [customerRef]
                );
                const c = cust.rows[0];
                if (c) {
                  partyState = c.state || '';
                  partyPincode = c.postcode || c.postcode || '';
                  partyPlace = c.city || '';
                  partyAddress = [c.address, c.address_line2].filter(Boolean);
                }
              }
              if (!partyAddress || partyAddress.length === 0) {
                const cand = [billedTo?.address1, billedTo?.address2].filter(Boolean);
                partyAddress = cand.length ? cand : null;
              }
              if (!partyPlace && billedTo?.place) partyPlace = billedTo.place;
              if (!partyState && billedTo?.state) partyState = billedTo.state;
              if (!partyPincode && billedTo?.pincode) partyPincode = billedTo.pincode;
            } catch (custErr) {
              console.error('[Invoice] Customer details lookup failed:', custErr.message);
            }

            // CRS company (dispatch-from / our GSTIN) - resolved from Tally and cached
            let company = null;
            try {
              const ci = await tallyService.fetchCompanyInfo(false);
              if (ci && ci.company) company = ci.company;
            } catch (_) { /* leave null - builder falls back to .env */ }

            const tallyResult = await tallyService.pushSalesVoucherWithRetry({
              partyName: customerName || billedTo?.name || 'Walk-in Customer',
              voucherNumber: invId,
              items: tallyItems,
              taxRate: taxRate || 18,
              narration: `Invoice ${invId} - ${customerName || 'Customer'}`,
              date: vchDate,
              roundOff: true,
              partyState: partyState || null,
              partyPincode: partyPincode || null,
              partyPlace: partyPlace || null,
              partyAddress: partyAddress || null,
              company,
            }, 3);

            const syncStatus = tallyResult.synced ? 'synced' : (tallyResult.success ? 'pushed' : 'error');
            console.log(`[Invoice] Tally push result for ${invId}: ${syncStatus}, created: ${tallyResult.created}, msg: ${tallyResult.message}`);
            for (const item of tallyItems) {
              if (item.serialNumber) {
                try {
                  await query(
                    `INSERT INTO tally_sync_log (voucher_number, stock_item_name, serial_number, sync_status, raw_data) VALUES ($1, $2, $3, $4, $5)`,
                    [invId, item.name, item.serialNumber, syncStatus, JSON.stringify({
                      pushedAt: new Date().toISOString(),
                      created: tallyResult.created,
                      success: tallyResult.success,
                      message: tallyResult.message
                    })]
                  );
                } catch (logErr) {
                  console.error('[Invoice] Failed to log push to tally_sync_log:', logErr.message);
                }
              }
            }
            if (!tallyResult.success) {
              console.error(`[Invoice] Tally push failed for ${invId} after retries:`, tallyResult.message);
            }
          } catch (tallyErr) {
            console.error(`[Invoice] Tally push error for ${invId}:`, tallyErr.message);
          }
        } catch (err) {
          console.error('[Invoice] Post-creation hook error:', err.message);
        }
      });
    }

    // Auto-generate Invoice PDF and send as message (fire-and-forget)
    // DISABLED: Invoice PDF and WhatsApp message generation removed to prevent automatic invoice sending.
    // if (ticketId) {
    //   setImmediate(async () => {
    //     try {
    //       const pdf = await generateInvoicePdf(insertId);
    //       await createPdfMessage({
    //         conversationId: String(ticketId),
    //         ticketId,
    //         customerId: null,
    //         sender: 'System',
    //         fileName: pdf.fileName,
    //         fileSize: pdf.fileSize,
    //         documentType: 'invoice',
    //         event: 'Invoice generated',
    //       });
    //     } catch (e) {
    //       console.error('Auto-generate invoice PDF failed:', e.message);
    //     }
    //   });
    // }

    res.status(201).json({ success: true, message: 'Invoice created successfully', data: invoice });
  } catch (err) {
    next(err);
  }
});

// PUT /api/invoices/:id - Update invoice
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const updates = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const allowed = ['status', 'payment_method', 'payment_status', 'amount_paid', 'balance_due', 'notes', 'discount', 'tax', 'total_amount', 'subtotal'];
    const setClauses = ['updated_at = ?'];
    const values = [now];

    for (const field of allowed) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    values.push(req.params.id);
    await query(`UPDATE invoices SET ${setClauses.join(', ')} WHERE id = ?`, values);

    const updatedResult = await query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Invoice updated successfully', data: updatedResult.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/invoices/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await query('DELETE FROM invoices WHERE id = ?', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Invoice not found' });
    res.json({ success: true, message: 'Invoice deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
