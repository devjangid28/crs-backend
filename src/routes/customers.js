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
    const result = await query('SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC', [req.params.id]);
    res.json({ success: true, data: result.rows });
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
