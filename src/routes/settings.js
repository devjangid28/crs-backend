const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

router.get('/', async (req, res, next) => {
  try {
    const rows = await query('SELECT * FROM store_settings LIMIT 1');
    const settings = rows.rows[0] || {};
    res.json({ success: true, data: { company_info: settings } });
  } catch (err) { next(err); }
});

router.put('/', async (req, res, next) => {
  try {
    const {
      companyName, company_name, address, phone, email, website,
      gstVat, gst_vat, taxId, tax_id, currency, logo, timezone
    } = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const rows = await query('SELECT COUNT(*) as cnt FROM store_settings');
    if (parseInt(rows.rows[0].cnt) === 0) {
      await query(
        `INSERT INTO store_settings (company_name, address, phone, email, website, gst_vat, tax_id, currency, logo, timezone, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [companyName || company_name || 'CRS Repair Shop', address || null, phone || null, email || null,
         website || null, gstVat || gst_vat || null, taxId || tax_id || null,
         currency || 'INR', logo || null, timezone || 'Asia/Kolkata', now]
      );
    } else {
      const setClauses = ['updated_at = ?'];
      const values = [now];
      const mapping = {
        companyName: 'company_name', company_name: 'company_name',
        address: 'address', phone: 'phone', email: 'email',
        website: 'website', gstVat: 'gst_vat', gst_vat: 'gst_vat',
        taxId: 'tax_id', tax_id: 'tax_id', currency: 'currency',
        logo: 'logo', timezone: 'timezone'
      };
      const seenCols = new Set(['updated_at']);
      for (const [front, db] of Object.entries(mapping)) {
        if (req.body[front] !== undefined && !seenCols.has(db)) {
          seenCols.add(db);
          setClauses.push(`${db} = ?`);
          values.push(req.body[front]);
        }
      }
      values.push(1);
      await query(`UPDATE store_settings SET ${setClauses.join(', ')} WHERE id = ?`, values);
    }

    const updatedResult = await query('SELECT * FROM store_settings LIMIT 1');
    res.json({ success: true, message: 'Settings updated', data: { company_info: updatedResult.rows[0] } });
  } catch (err) { next(err); }
});

module.exports = router;
