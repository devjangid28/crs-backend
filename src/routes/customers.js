const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { validateCustomer } = require('../middleware/validation');

// GET /api/customers - Get all customers
router.get('/', async (req, res, next) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    let sql = 'SELECT * FROM customers WHERE 1=1';
    const params = [];

    if (search) {
      sql += ` AND (name ILIKE ? OR phone ILIKE ? OR email ILIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    sql += ' ORDER BY created_at DESC';

    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const customersResult = await query(sql, params);

    const countSql = search
      ? `SELECT COUNT(*) as total FROM customers WHERE name ILIKE ? OR phone ILIKE ? OR email ILIKE ?`
      : `SELECT COUNT(*) as total FROM customers`;
    const countParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
    const countResult = await query(countSql, countParams);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    res.json({
      success: true,
      data: customersResult.rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id - Get single customer
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/tickets - Get customer's tickets
router.get('/:id/tickets', async (req, res, next) => {
  try {
    const custResult = await query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    const customer = custResult.rows[0];
    if (customer) {
      const result = await query(
        `SELECT * FROM tickets
         WHERE customer_id = ?
            OR customer_phone = ?
            OR customer_phone = ?
            OR customer_name ILIKE ?
         ORDER BY created_at DESC`,
        [req.params.id, customer.phone, customer.phone2, `%${customer.name}%`]
      );
      return res.json({ success: true, data: result.rows });
    }
    const result = await query('SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC', [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/details - Customer profile with tickets AND orders
router.get('/:id/details', async (req, res, next) => {
  try {
    const customerResult = await query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    const customer = customerResult.rows[0];

    // Match tickets/orders/invoices not only by the linked customer_id but also
    // by phone and name so records created before a customer was synced from
    // Tally (or that only carry a name/phone) still show up on the customer's
    // profile. Null phones simply never match in Postgres, which is fine.
    const customerNameLike = `%${customer.name}%`;
    const [ticketsResult, ordersResult, invoicesResult, purchasesResult] = await Promise.all([
      query(
        `SELECT * FROM tickets
         WHERE customer_id = ?
            OR customer_phone = ?
            OR customer_phone = ?
            OR customer_email = ?
            OR customer_name ILIKE ?
         ORDER BY created_at DESC`,
        [req.params.id, customer.phone, customer.phone2, customer.email, customerNameLike]
      ),
      query(
        `SELECT * FROM orders
         WHERE mobile_number = ?
            OR mobile_number = ?
            OR customer_name ILIKE ?
         ORDER BY created_at DESC`,
        [customer.phone, customer.phone2, customerNameLike]
      ),
      query(
        `SELECT * FROM invoices
         WHERE customer_id = ?
            OR customer_phone = ?
            OR customer_phone = ?
            OR customer_email = ?
            OR customer_name ILIKE ?
         ORDER BY created_at DESC`,
        [req.params.id, customer.phone, customer.phone2, customer.email, customerNameLike]
      ),
      query(
        `SELECT * FROM tally_sales
         WHERE customer_id = ?
            OR party_name ILIKE ?
            OR REPLACE(party_name, ' ', '') = REPLACE(?, ' ', '')
         ORDER BY voucher_date DESC, id DESC`,
        [req.params.id, customerNameLike, customer.name]
      ),
    ]);

    // Many Tally-synced customers have no phone in their ledger master, but the
    // mobile is carried on their tickets/orders. Backfill it on the response so
    // the UI can always show a contact number when a customer is tapped.
    const firstPhone = (rows, keys) => {
      for (const row of rows) {
        for (const key of keys) {
          const v = row && row[key];
          if (v && String(v).trim()) return String(v).trim();
        }
      }
      return null;
    };
    if (!customer.phone) {
      customer.phone = firstPhone(ticketsResult.rows, ['customer_phone'])
        || firstPhone(ordersResult.rows, ['mobile_number'])
        || firstPhone(purchasesResult.rows, ['party_phone'])
        || null;
    }
    if (!customer.phone2) {
      customer.phone2 = firstPhone(ordersResult.rows, ['mobile_number'])
        || null;
    }

    res.json({
      success: true,
      data: {
        customer,
        tickets: ticketsResult.rows,
        orders: ordersResult.rows,
        invoices: invoicesResult.rows,
        purchases: purchasesResult.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/sync-from-tally - Pull all customers from Tally into the DB
router.post('/sync-from-tally', async (req, res, next) => {
  try {
    const tallyService = require('../services/tallyService');
    const { pool } = require('../config/database');
    const result = await tallyService.syncCustomersFromTally(pool, req.body?.company);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// POST /api/customers - Create customer
router.post('/', validateCustomer, async (req, res, next) => {
  try {
    const { name, company, phone, phone2, email, address, addressLine2, city, state, pincode, postcode, country } = req.body;
    const pc = pincode || postcode;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const result = await query(
      `INSERT INTO customers (name, company, phone, phone2, email, address, address_line2, city, state, postcode, country, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [name, company || null, phone, phone2 || null, email || null, address || null, addressLine2 || null, city || null, state || null, pc || null, country || 'India', now, now]
    );

    const insertId = result.rows[0].id;
    const customerResult = await query('SELECT * FROM customers WHERE id = ?', [insertId]);
    res.status(201).json({ success: true, message: 'Customer created successfully', data: customerResult.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/customers/:id - Update customer
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const updates = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const fieldMapping = {
      name: 'name', company: 'company', phone: 'phone', phone2: 'phone2',
      email: 'email', address: 'address', addressLine2: 'address_line2',
      city: 'city', state: 'state', pincode: 'postcode', postcode: 'postcode', country: 'country'
    };

    const setClauses = [];
    const values = [];
    const seenCols = new Set();
    for (const [front, db] of Object.entries(fieldMapping)) {
      if (updates[front] !== undefined && !seenCols.has(db)) {
        seenCols.add(db);
        setClauses.push(`${db} = ?`);
        values.push(updates[front]);
      }
    }

    if (setClauses.length > 0) {
      setClauses.push('updated_at = ?');
      values.push(now);
      values.push(req.params.id);
      await query(`UPDATE customers SET ${setClauses.join(', ')} WHERE id = ?`, values);
    }

    const updatedResult = await query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Customer updated successfully', data: updatedResult.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customers/:id - Delete customer
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await query('DELETE FROM customers WHERE id = ?', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    res.json({ success: true, message: 'Customer deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
