const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

router.get('/', async (req, res, next) => {
  try {
    const { search, category, page = 1, limit = 50 } = req.query;
    let sql = 'SELECT * FROM inventory WHERE 1=1';
    const params = [];

    if (search) {
      sql += ` AND (name ILIKE ? OR sku ILIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s);
    }
    if (category) {
      sql += ` AND category = ?`;
      params.push(category);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const items = await query(sql, params);
    const countResult = await query('SELECT COUNT(*) as total FROM inventory', []);
    res.json({ success: true, data: items.rows, pagination: { total: parseInt(countResult.rows[0]?.total) || 0, page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, sku, category, description, quantity, unitPrice, sellingPrice, reorderLevel, supplier, location, notes } = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const result = await query(
      `INSERT INTO inventory (name, sku, category, description, quantity, unit_price, selling_price, min_stock_level, supplier, location, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [name, sku || '', category || '', description || '', quantity || 0, unitPrice || 0, sellingPrice || 0, reorderLevel || 10, supplier || '', location || '', notes || '', now, now]
    );

    const insertId = result.rows[0].id;
    const itemResult = await query('SELECT * FROM inventory WHERE id = ?', [insertId]);
    res.status(201).json({ success: true, data: itemResult.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const updates = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const setClauses = ['updated_at = ?'];
    const values = [now];

    const mapping = { name: 'name', sku: 'sku', category: 'category', description: 'description', quantity: 'quantity', unitPrice: 'unit_price', sellingPrice: 'selling_price', reorderLevel: 'min_stock_level', supplier: 'supplier', location: 'location', notes: 'notes' };
    for (const [front, db] of Object.entries(mapping)) {
      if (updates[front] !== undefined) { setClauses.push(`${db} = ?`); values.push(updates[front]); }
    }

    values.push(req.params.id);
    await query(`UPDATE inventory SET ${setClauses.join(', ')} WHERE id = ?`, values);
    const itemResult = await query('SELECT * FROM inventory WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: itemResult.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM inventory WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
