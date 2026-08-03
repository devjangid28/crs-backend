const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const tallyService = require('../services/tallyService');

router.use(authenticate);

// GET /api/suppliers?search= - List suppliers (optional search by name)
router.get('/', async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    let sql = 'SELECT id, name, gst_no, address, phone, email, created_at FROM suppliers';
    const params = [];
    if (search) {
      sql += ' WHERE name ILIKE $1 OR gst_no ILIKE $1';
      params.push(`%${search}%`);
    }
    sql += ' ORDER BY name ASC LIMIT 100';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/suppliers - Create supplier (or return existing one with same name)
router.post('/', async (req, res) => {
  try {
    const { name, gstNo, address, phone, email } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Supplier name is required' });
    }
    const trimmedName = name.trim();

    const existing = await query('SELECT id, name, gst_no, address, phone, email FROM suppliers WHERE LOWER(name) = LOWER($1)', [trimmedName]);
    if (existing.rows.length > 0) {
      let tally = null;
      try {
        tally = await tallyService.pushLedgerToTally(existing.rows[0].name, null, {
          parent: 'Sundry Creditors',
          gstNo: existing.rows[0].gst_no || '',
        });
      } catch (e) {
        tally = { success: false, message: e.message };
      }
      return res.json({ success: true, data: existing.rows[0], reused: true, tally });
    }

    const result = await query(
      `INSERT INTO suppliers (name, gst_no, address, phone, email, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, gst_no, address, phone, email`,
      [trimmedName, gstNo || null, address || null, phone || null, email || null, req.user.id]
    );
    const supplier = result.rows[0];

    // Push the supplier to Tally as a Sundry Creditors ledger (best-effort; DB save
    // succeeds even if Tally is unreachable, and the result is reported in the response).
    let tally = null;
    try {
      tally = await tallyService.pushLedgerToTally(supplier.name, null, {
        parent: 'Sundry Creditors',
        gstNo: supplier.gst_no || '',
      });
    } catch (e) {
      tally = { success: false, message: e.message };
    }
    console.log(`[Suppliers] Tally ledger push for "${supplier.name}": ${tally.success ? 'OK' : 'FAILED'} - ${tally.message}`);
    res.status(201).json({ success: true, data: supplier, tally });
  } catch (err) {
    if (err.code === '23505') {
      const existing = await query('SELECT id, name, gst_no, address, phone, email FROM suppliers WHERE LOWER(name) = LOWER($1)', [String(req.body.name || '').trim()]);
      if (existing.rows.length > 0) {
        let tally = null;
        try {
          tally = await tallyService.pushLedgerToTally(existing.rows[0].name, null, {
            parent: 'Sundry Creditors',
            gstNo: existing.rows[0].gst_no || '',
          });
        } catch (e) {
          tally = { success: false, message: e.message };
        }
        return res.json({ success: true, data: existing.rows[0], reused: true, tally });
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/suppliers/:id - Update supplier
router.put('/:id', async (req, res) => {
  try {
    const { name, gstNo, address, phone, email } = req.body;
    const result = await query(
      `UPDATE suppliers SET
         name = COALESCE($1, name),
         gst_no = COALESCE($2, gst_no),
         address = COALESCE($3, address),
         phone = COALESCE($4, phone),
         email = COALESCE($5, email),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING id, name, gst_no, address, phone, email`,
      [name || null, gstNo || null, address || null, phone || null, email || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Supplier not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
