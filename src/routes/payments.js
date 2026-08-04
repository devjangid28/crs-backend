const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const tallyService = require('../services/tallyService');

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

    // Push a Receipt voucher to Tally (fire-and-forget): the bank ledger configured in
    // Tally settings is debited, the customer is credited against the sales invoice.
    if (invoiceId && (parseFloat(amount) || 0) > 0) {
      setImmediate(async () => {
        try {
          const invResult = await query(
            `SELECT id, invoice_id, customer_name, customer_id FROM invoices WHERE id = ?`,
            [invoiceId]
          );
          const inv = invResult.rows[0];
          if (!inv) return;
          let partyName = inv.customer_name || 'Walk-in Customer';
          if (inv.customer_id) {
            try {
              const cust = await query('SELECT name FROM customers WHERE id = ?', [inv.customer_id]);
              if (cust.rows[0]?.name) partyName = cust.rows[0].name;
            } catch (_) { /* fall through */ }
          }
          const cfg = tallyService.getTallyConfig();
          if (!cfg.bankLedger) {
            console.warn('[Payment] No TALLY_BANK_LEDGER configured - skipping Receipt voucher push.');
            return;
          }
          const receiptResult = await tallyService.pushReceiptVoucherWithRetry({
            partyName,
            refVoucherNumber: inv.invoice_id,
            amount: parseFloat(amount),
            bankLedger: cfg.bankLedger,
            narration: `Payment received against ${inv.invoice_id} - ${partyName}`,
          }, 2);
          console.log(`[Payment] Receipt voucher push for ${inv.invoice_id}: ${receiptResult.success ? 'ok' : 'failed'} - ${receiptResult.message}`);
        } catch (e) {
          console.error('[Payment] Receipt voucher push error:', e.message);
        }
      });
    }

    const insertId = result.rows[0].id;
    const paymentResult = await query('SELECT * FROM payment_history WHERE id = ?', [insertId]);
    res.status(201).json({ success: true, data: paymentResult.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
