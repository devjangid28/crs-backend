const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { generateInvoicePdf } = require('../services/pdfGenerator');
const { createPdfMessage } = require('../services/messagingService');

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
      ticketId, customerId, customerName, invoiceNumber, issueDate, dueDate,
      paymentTerms, items, subtotal, taxRate, tax, discount, grandTotal,
      amountPaid, status, paymentMethod, billedBy, billedTo, notes
    } = req.body;

    const invId = invoiceNumber || `INV-${10000 + Date.now() % 100000}`;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const bbName = billedBy?.name || null;
    const bbAddr1 = billedBy?.address1 || null;
    const bbAddr2 = billedBy?.address2 || null;
    const btName = billedTo?.name || null;
    const btEmail = billedTo?.email || null;
    const btAddr1 = billedTo?.address1 || null;
    const btAddr2 = billedTo?.address2 || null;

    const result = await query(
      `INSERT INTO invoices (invoice_id, ticket_id, customer_id, customer_name, issue_date, due_date, payment_terms, subtotal, tax_rate, tax_amount, discount, total_amount, amount_paid, balance_due, status, payment_method, billed_by_name, billed_by_address1, billed_by_address2, billed_to_name, billed_to_email, billed_to_address1, billed_to_address2, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [invId, ticketId || null, customerId || null, customerName || 'Unknown Customer', issueDate || null, dueDate || null, paymentTerms || 'Net 14 days',
       subtotal || 0, taxRate || 0, tax || 0, discount || 0, grandTotal || 0, amountPaid || 0, (grandTotal || 0) - (amountPaid || 0),
       status || 'Unpaid', paymentMethod || null, bbName, bbAddr1, bbAddr2, btName, btEmail, btAddr1, btAddr2,
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
