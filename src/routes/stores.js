const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

// GET /api/stores - Get all active stores
router.get('/', async (req, res, next) => {
  try {
    const { all } = req.query;
    let sql = 'SELECT * FROM stores';
    if (all !== 'true') sql += ' WHERE is_active = true';
    sql += ' ORDER BY is_default DESC, store_name ASC';
    const result = await query(sql);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// GET /api/stores/default - Get default store
router.get('/default', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM stores WHERE is_default = true AND is_active = true LIMIT 1');
    if (result.rows.length === 0) {
      const fallback = await query('SELECT * FROM stores WHERE is_active = true LIMIT 1');
      return res.json({ success: true, data: fallback.rows[0] || null });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/stores/:id - Get single store
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM stores WHERE id = ?', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/stores - Create store
router.post('/', authenticate, async (req, res, next) => {
  try {
    const {
      storeName, store_name, ownerName, owner_name,
      gstNumber, gst_number, address, city, state, pincode,
      phone, mobile, whatsappNumber, whatsapp_number,
      email, logo, website, termsConditions, terms_conditions,
      notes, isDefault, is_default, isActive, is_active
    } = req.body;

    const name = storeName || store_name;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Store name is required' });
    }

    // If setting as default, unset other defaults first
    const defaultVal = isDefault || is_default ? true : false;
    if (defaultVal) {
      await query('UPDATE stores SET is_default = false WHERE is_default = true');
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await query(
      `INSERT INTO stores (store_name, owner_name, gst_number, address, city, state, pincode,
        phone, mobile, whatsapp_number, email, logo, website, terms_conditions, notes,
        is_default, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [name, ownerName || owner_name || null, gstNumber || gst_number || null,
       address || null, city || null, state || null, pincode || null,
       phone || null, mobile || null, whatsappNumber || whatsapp_number || null,
       email || null, logo || null, website || null,
       termsConditions || terms_conditions || null, notes || null,
       defaultVal, isActive !== undefined ? isActive : (is_active !== undefined ? is_active : true),
       now, now]
    );

    res.status(201).json({ success: true, message: 'Store created successfully', data: result.rows[0] });
  } catch (err) { next(err); }
});

// PUT /api/stores/:id - Update store
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await query('SELECT * FROM stores WHERE id = ?', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }

    const updates = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // If setting as default, unset other defaults
    if (updates.isDefault || updates.is_default) {
      await query('UPDATE stores SET is_default = false WHERE is_default = true AND id != ?', [req.params.id]);
    }

    const fieldMapping = {
      storeName: 'store_name', store_name: 'store_name',
      ownerName: 'owner_name', owner_name: 'owner_name',
      gstNumber: 'gst_number', gst_number: 'gst_number',
      address: 'address', city: 'city', state: 'state',
      pincode: 'pincode', phone: 'phone', mobile: 'mobile',
      whatsappNumber: 'whatsapp_number', whatsapp_number: 'whatsapp_number',
      email: 'email', logo: 'logo', website: 'website',
      termsConditions: 'terms_conditions', terms_conditions: 'terms_conditions',
      notes: 'notes', isDefault: 'is_default', is_default: 'is_default',
      isActive: 'is_active', is_active: 'is_active'
    };

    const setClauses = ['updated_at = $1'];
    const values = [now];
    const seenCols = new Set(['updated_at']);

    for (const [front, db] of Object.entries(fieldMapping)) {
      if (updates[front] !== undefined && !seenCols.has(db)) {
        seenCols.add(db);
        setClauses.push(`${db} = $${setClauses.length + 1}`);
        values.push(updates[front]);
      }
    }

    values.push(req.params.id);
    await query(`UPDATE stores SET ${setClauses.join(', ')} WHERE id = $${setClauses.length + 1}`, values);

    const updated = await query('SELECT * FROM stores WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Store updated successfully', data: updated.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/stores/:id - Delete store
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query('DELETE FROM stores WHERE id = ?', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    res.json({ success: true, message: 'Store deleted successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
