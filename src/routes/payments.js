const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

router.get('/', async (req, res, next) => {
  try {
    const { invoiceId, ticketId } = req.query;
    let sql = 'SELECT * FROM payment_history WHERE 1=1';
    const params = [];
    if (invoiceId) { sql += ' AND invoice_id = ?'; params.push(invoiceId); }
    if (ticketId) { sql += ' AND ticket_id = ?'; params.push(ticketId); }
    sql += ' ORDER BY payment_date DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { invoiceId, ticketId, amount, paymentMethod, transactionId, notes, paidBy } = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await query(
      `INSERT INTO payment_history (invoice_id, ticket_id, amount, payment_method, reference_number, notes, received_by, payment_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [invoiceId || null, ticketId || null, amount || 0, paymentMethod || 'Cash', transactionId || '', notes || '', paidBy || 'Admin', now]
    );

    if (invoiceId) {
      await query('UPDATE invoices SET amount_paid = amount_paid + ?, balance_due = total_amount - (amount_paid + ?) WHERE id = ?',
        [amount || 0, amount || 0, invoiceId]);
    }

    const insertId = result.rows[0].id;
    const paymentResult = await query('SELECT * FROM payment_history WHERE id = ?', [insertId]);
    res.status(201).json({ success: true, data: paymentResult.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
