const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const demoModelService = require('../services/demoModelService');
const notificationService = require('../services/notificationService');

// ════════════════════════════════════════════════════════════
// GET /api/demo-models - List demo models (with 60-day/1-year timeline)
// ════════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { store_id, status, search, page, limit } = req.query;
    const result = await demoModelService.listDemoModels({
      storeId: store_id,
      status,
      search,
      page,
      limit,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// GET /api/demo-models/eligible - Demo units that can be sold NOW
// (60-day lock period has passed). Used by mobile app polling.
// ════════════════════════════════════════════════════════════
router.get('/eligible', authenticate, async (req, res, next) => {
  try {
    const rows = await demoModelService.findSellableDemoModels();
    res.json({
      success: true,
      data: rows.map(row => ({ ...row, ...demoModelService.computeDemoDates(row), status_text: demoModelService.demoStatusText(row) })),
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// GET /api/demo-models/lookup?serial=XXX - Look up a serial number
// in the main inventory so demo details can be auto-filled.
// Demo items are first added to inventory, so their details
// (product name, brand, color, store, purchase date, ASUS purchase
// info) are already stored and can be fetched by serial number.
// ════════════════════════════════════════════════════════════
router.get('/lookup', authenticate, async (req, res, next) => {
  try {
    const serial = String(req.query.serial || '').trim().toUpperCase();
    if (!serial) return res.status(400).json({ success: false, message: 'Serial number is required' });

    const inv = await query(
      `SELECT id, product_name, brand, model, color, category, store_id, serial_number,
              purchase_date, purchase_price, selling_price, warranty,
              gst_rate, check_no, part_no, purchase_place, invoice_date,
              basic_amount, gst_amount, amount_with_gst
       FROM inventory_items
       WHERE UPPER(serial_number) = $1 AND is_active = true
       LIMIT 1`,
      [serial]
    );

    const demo = await query(
      `SELECT id, status FROM demo_models WHERE UPPER(serial_number) = $1 AND is_active = true LIMIT 1`,
      [serial]
    );

    if (inv.rows.length === 0) {
      return res.json({
        success: true,
        found: false,
        alreadyDemo: demo.rows.length > 0,
        data: null,
      });
    }

    const row = inv.rows[0];
    // DATE columns come back as local-midnight Date objects; format with local
    // components so the displayed date matches what was stored (toISOString would
    // shift to UTC and can be off by one day).
    const dateStr = (d) => {
      if (!d) return null;
      const dt = d instanceof Date ? d : new Date(`${String(d).slice(0, 10)}T00:00:00`);
      if (isNaN(dt.getTime())) return null;
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    res.json({
      success: true,
      found: true,
      alreadyDemo: demo.rows.length > 0,
      data: {
        serialNumber: row.serial_number,
        productName: row.product_name,
        model: row.model,
        brand: row.brand,
        color: row.color,
        category: row.category,
        storeId: row.store_id,
        purchaseDate: dateStr(row.purchase_date),
        invoiceDate: dateStr(row.invoice_date),
        purchasePrice: row.purchase_price,
        sellingPrice: row.selling_price,
        warranty: row.warranty,
        gstRate: row.gst_rate,
        checkNo: row.check_no,
        partNo: row.part_no,
        purchasePlace: row.purchase_place,
        basicAmount: row.basic_amount,
        gstAmount: row.gst_amount,
        amountWithGst: row.amount_with_gst,
      },
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// GET /api/demo-models/:id - Single demo model
// ════════════════════════════════════════════════════════════
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const row = await demoModelService.getDemoById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Demo model not found' });
    res.json({ success: true, data: { ...row, ...demoModelService.computeDemoDates(row), status_text: demoModelService.demoStatusText(row) } });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// POST /api/demo-models - Add a demo model
// Base date auto-fills: purchase_date if provided, else today.
// Warranty defaults to 12 months.
// ════════════════════════════════════════════════════════════
router.post('/', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const {
      modelName, brand, serialNumber, color,
      storeId, purchaseDate, warrantyMonths, status, remarks,
    } = req.body;

    if (!modelName || !modelName.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Model No is required' });
    }
    if (!serialNumber || !serialNumber.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Serial No is required' });
    }
    if (!storeId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Please select a store' });
    }

    const storeCheck = await client.query('SELECT id, store_name FROM stores WHERE id = $1 AND is_active = true', [storeId]);
    if (storeCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Invalid store selected' });
    }

    const dup = await client.query('SELECT id FROM demo_models WHERE serial_number = $1 AND is_active = true', [serialNumber.trim()]);
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'A demo product with this serial number already exists' });
    }

    // Base date rule: purchase date if provided, else today (when added to inventory)
    const effectivePurchaseDate = purchaseDate || null;
    const addedDate = new Date().toISOString().slice(0, 10);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const insertResult = await client.query(
      `INSERT INTO demo_models (
        model_name, brand, serial_number, color, store_id,
        purchase_date, added_date, warranty_months, status, remarks,
        created_by, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        modelName.trim(), brand || null, serialNumber.trim(), color || null, storeId,
        effectivePurchaseDate, addedDate, parseInt(warrantyMonths, 10) || 12,
        status || 'Available', remarks || null,
        req.user.id, now, now,
      ]
    );

    await client.query('COMMIT');

    const row = insertResult.rows[0];
    res.status(201).json({
      success: true,
      message: 'Demo model added successfully',
      data: { ...row, ...demoModelService.computeDemoDates(row), status_text: demoModelService.demoStatusText(row) },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Serial number already exists' });
    }
    next(err);
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════
// PUT /api/demo-models/:id - Update a demo model
// ════════════════════════════════════════════════════════════
router.put('/:id', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM demo_models WHERE id = $1 AND is_active = true', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Demo model not found' });
    }

    const updates = req.body;
    const fieldMapping = {
      modelName: 'model_name', brand: 'brand', serialNumber: 'serial_number',
      color: 'color', storeId: 'store_id', purchaseDate: 'purchase_date',
      warrantyMonths: 'warranty_months', status: 'status', remarks: 'remarks',
    };

    if (updates.serialNumber && updates.serialNumber.trim() !== existing.rows[0].serial_number) {
      const dup = await client.query(
        'SELECT id FROM demo_models WHERE serial_number = $1 AND is_active = true AND id != $2',
        [updates.serialNumber.trim(), req.params.id]
      );
      if (dup.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Serial number already in use' });
      }
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const setClauses = ['updated_at = $1'];
    const values = [now];

    for (const [front, db] of Object.entries(fieldMapping)) {
      if (updates[front] !== undefined) {
        values.push(updates[front] || null);
        setClauses.push(`${db} = $${values.length}`);
      }
    }

    values.push(req.params.id);
    await client.query(`UPDATE demo_models SET ${setClauses.join(', ')} WHERE id = $${values.length}`, values);

    await client.query('COMMIT');

    const row = await demoModelService.getDemoById(req.params.id);
    res.json({ success: true, message: 'Demo model updated', data: row ? { ...row, ...demoModelService.computeDemoDates(row), status_text: demoModelService.demoStatusText(row) } : null });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'Serial number already exists' });
    next(err);
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════
// PUT /api/demo-models/:id/status - Change status (e.g. mark Sold)
// ════════════════════════════════════════════════════════════
router.put('/:id/status', authenticate, async (req, res, next) => {
  try {
    const { status, remarks } = req.body;
    if (!status) return res.status(400).json({ success: false, message: 'Status is required' });

    const existing = await query('SELECT * FROM demo_models WHERE id = $1 AND is_active = true', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, message: 'Demo model not found' });

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await query('UPDATE demo_models SET status = $1, remarks = COALESCE($2, remarks), updated_at = $3 WHERE id = $4',
      [status, remarks || null, now, req.params.id]);

    const row = await demoModelService.getDemoById(req.params.id);
    res.json({ success: true, message: 'Demo model status updated', data: row ? { ...row, ...demoModelService.computeDemoDates(row), status_text: demoModelService.demoStatusText(row) } : null });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// DELETE /api/demo-models/:id - Soft delete
// ════════════════════════════════════════════════════════════
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await query('UPDATE demo_models SET is_active = false, updated_at = $1 WHERE id = $2 AND is_active = true', [now, req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Demo model not found' });
    res.json({ success: true, message: 'Demo model removed' });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// POST /api/demo-models/check-sellable - Owner-only manual trigger
// Runs the 60-day check now and notifies owners. Useful for testing.
// ════════════════════════════════════════════════════════════
router.post('/check-sellable', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ success: false, message: 'Only the owner can run this check' });
    const result = await notificationService.runSellableCheck(req.io);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

module.exports = router;
