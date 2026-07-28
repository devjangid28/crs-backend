const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');

// ════════════════════════════════════════════════════════════════
// HELPER: Get user's accessible store IDs
// ════════════════════════════════════════════════════════════════
async function getUserStoreIds(user) {
  if (user.role === 'owner') {
    const stores = await query('SELECT id FROM stores WHERE is_active = true');
    return stores.rows.map(s => s.id);
  }
  if (user.store_id) return [user.store_id];
  return [];
}

function formatHistory(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// ════════════════════════════════════════════════════════════════
// GET /api/inventory/dashboard - Inventory dashboard stats
// ════════════════════════════════════════════════════════════════
router.get('/dashboard', authenticate, async (req, res, next) => {
  try {
    const storeIds = await getUserStoreIds(req.user);
    if (storeIds.length === 0) {
      return res.json({ success: true, data: { totalProducts: 0, availableStock: 0, soldProducts: 0, reservedProducts: 0, lowStock: 0, outOfStock: 0, storeWise: [], recentActivity: [], monthlySales: [], categoryDistribution: [] } });
    }

    const storeFilter = `AND ii.store_id IN (${storeIds.join(',')})`;

    const [statsRes, storeWiseRes, recentRes, monthlyRes, categoryRes, statusRes] = await Promise.all([
      query(`SELECT
        COUNT(*) as total_products,
        COUNT(*) FILTER (WHERE ii.status = 'Available') as available,
        COUNT(*) FILTER (WHERE ii.status = 'Sold') as sold,
        COUNT(*) FILTER (WHERE ii.status = 'Reserved') as reserved,
        COUNT(*) FILTER (WHERE ii.status = 'Damaged') as damaged,
        COUNT(*) FILTER (WHERE ii.status = 'In Repair') as in_repair,
        COUNT(*) FILTER (WHERE ii.status = 'Returned') as returned,
        COUNT(*) FILTER (WHERE ii.status = 'Disposed') as disposed,
        COALESCE(SUM(ii.selling_price) FILTER (WHERE ii.status = 'Available'), 0) as stock_value
      FROM inventory_items ii WHERE ii.is_active = true ${storeFilter}`, []),

      query(`SELECT s.id, s.store_name,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE ii.status = 'Available') as available,
        COUNT(*) FILTER (WHERE ii.status = 'Sold') as sold
      FROM stores s
      LEFT JOIN inventory_items ii ON ii.store_id = s.id AND ii.is_active = true
      WHERE s.is_active = true
      GROUP BY s.id, s.store_name
      ORDER BY s.store_name`, []),

      query(`SELECT ih.*, ii.product_name, ii.serial_number, ii.brand, ii.model
      FROM inventory_history ih
      JOIN inventory_items ii ON ii.id = ih.inventory_item_id
      WHERE ii.store_id IN (${storeIds.join(',')})
      ORDER BY ih.created_at DESC LIMIT 20`, []),

      query(`SELECT
        TO_CHAR(ii.created_at, 'YYYY-MM') as month,
        COUNT(*) FILTER (WHERE ih.action = 'Added') as added,
        COUNT(*) FILTER (WHERE ih.action = 'Sold') as sold
      FROM inventory_items ii
      LEFT JOIN inventory_history ih ON ih.inventory_item_id = ii.id
      WHERE ii.created_at >= NOW() - INTERVAL '12 months'
        AND ii.store_id IN (${storeIds.join(',')})
      GROUP BY TO_CHAR(ii.created_at, 'YYYY-MM')
      ORDER BY month ASC`, []),

      query(`SELECT ii.category,
        COUNT(*) as count
      FROM inventory_items ii
      WHERE ii.is_active = true AND ii.store_id IN (${storeIds.join(',')})
      GROUP BY ii.category
      ORDER BY count DESC`, []),

      query(`SELECT ii.status,
        COUNT(*) as count
      FROM inventory_items ii
      WHERE ii.is_active = true AND ii.store_id IN (${storeIds.join(',')})
      GROUP BY ii.status
      ORDER BY count DESC`, [])
    ]);

    const row = statsRes.rows[0] || {};
    res.json({
      success: true,
      data: {
        totalProducts: parseInt(row.total_products) || 0,
        availableStock: parseInt(row.available) || 0,
        soldProducts: parseInt(row.sold) || 0,
        reservedProducts: parseInt(row.reserved) || 0,
        damagedProducts: parseInt(row.damaged) || 0,
        inRepairProducts: parseInt(row.in_repair) || 0,
        returnedProducts: parseInt(row.returned) || 0,
        disposedProducts: parseInt(row.disposed) || 0,
        totalStockValue: parseFloat(row.stock_value) || 0,
        storeWise: storeWiseRes.rows,
        recentActivity: recentRes.rows,
        monthlySales: monthlyRes.rows,
        categoryDistribution: categoryRes.rows,
        statusDistribution: statusRes.rows,
      }
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// GET /api/inventory/lookup/:serialNumber - Lookup by serial number
// ════════════════════════════════════════════════════════════════
router.get('/lookup/:serialNumber', authenticate, async (req, res, next) => {
  try {
    const sn = req.params.serialNumber.trim();
    if (!sn) return res.status(400).json({ success: false, message: 'Serial number is required' });

    const storeIds = await getUserStoreIds(req.user);
    if (storeIds.length === 0) return res.status(404).json({ success: false, message: 'No stores assigned' });

    const result = await query(
      `SELECT ii.*, s.store_name
       FROM inventory_items ii
       JOIN stores s ON s.id = ii.store_id
       WHERE ii.serial_number ILIKE $1 AND ii.is_active = true AND ii.store_id IN (${storeIds.join(',')})`,
      [`%${sn}%`]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No inventory item found with this serial number' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// GET /api/inventory/search - Search inventory items
// ════════════════════════════════════════════════════════════════
router.get('/search', authenticate, async (req, res, next) => {
  try {
    const { q, status, store_id, brand, category, page = 1, limit = 50 } = req.query;
    const storeIds = await getUserStoreIds(req.user);
    if (storeIds.length === 0) return res.json({ success: true, data: [], pagination: { total: 0, page: 1, limit: 50 } });

    let where = 'WHERE ii.is_active = true';
    const params = [];

    // Store filter
    const effectiveStoreIds = store_id ? storeIds.filter(id => id === parseInt(store_id)) : storeIds;
    if (effectiveStoreIds.length > 0) {
      where += ` AND ii.store_id IN (${effectiveStoreIds.join(',')})`;
    }

    if (q) {
      where += ` AND (ii.product_name ILIKE $1 OR ii.serial_number ILIKE $1 OR ii.sku ILIKE $1 OR ii.brand ILIKE $1 OR ii.model ILIKE $1 OR ii.barcode ILIKE $1)`;
      params.push(`%${q}%`);
    }
    if (status) { params.push(status); where += ` AND ii.status = $${params.length}`; }
    if (brand) { params.push(brand); where += ` AND ii.brand ILIKE $${params.length}`; }
    if (category) { params.push(category); where += ` AND ii.category = $${params.length}`; }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit));
    params.push(offset);

    const [dataRes, countRes] = await Promise.all([
      query(`SELECT ii.*, s.store_name FROM inventory_items ii
             JOIN stores s ON s.id = ii.store_id
             ${where} ORDER BY ii.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params.slice(0, -2).concat([parseInt(limit), offset])),
      query(`SELECT COUNT(*) as total FROM inventory_items ii ${where}`, params.slice(0, -2))
    ]);

    res.json({
      success: true,
      data: dataRes.rows,
      pagination: {
        total: parseInt(countRes.rows[0]?.total) || 0,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil((parseInt(countRes.rows[0]?.total) || 0) / parseInt(limit)),
      }
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// GET /api/inventory - Get all inventory items (main listing)
// ════════════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { search, status, store_id, brand, category, serial_number, page = 1, limit = 50 } = req.query;
    const storeIds = await getUserStoreIds(req.user);
    if (storeIds.length === 0) return res.json({ success: true, data: [], pagination: { total: 0, page: 1, limit: 50, totalPages: 0 } });

    let where = 'WHERE ii.is_active = true';
    const params = [];

    const effectiveStoreIds = store_id ? storeIds.filter(id => id === parseInt(store_id)) : storeIds;
    if (effectiveStoreIds.length > 0) {
      where += ` AND ii.store_id IN (${effectiveStoreIds.join(',')})`;
    }

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (ii.product_name ILIKE $${params.length} OR ii.serial_number ILIKE $${params.length} OR ii.sku ILIKE $${params.length} OR ii.brand ILIKE $${params.length} OR ii.model ILIKE $${params.length})`;
    }
    if (status) { params.push(status); where += ` AND ii.status = $${params.length}`; }
    if (brand) { params.push(brand); where += ` AND ii.brand ILIKE $${params.length}`; }
    if (category) { params.push(category); where += ` AND ii.category = $${params.length}`; }
    if (serial_number) { params.push(`%${serial_number}%`); where += ` AND ii.serial_number ILIKE $${params.length}`; }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countParams = [...params];

    params.push(parseInt(limit));
    params.push(offset);

    const [dataResult, countResult] = await Promise.all([
      query(`SELECT ii.*, s.store_name FROM inventory_items ii
             JOIN stores s ON s.id = ii.store_id
             ${where} ORDER BY ii.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
      query(`SELECT COUNT(*) as total FROM inventory_items ii ${where}`, countParams)
    ]);

    const total = parseInt(countResult.rows[0]?.total) || 0;
    res.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      }
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// GET /api/inventory/history/:itemId - Get history for an item
// ════════════════════════════════════════════════════════════════
router.get('/history/:itemId', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT ih.*, u.full_name as user_full_name
       FROM inventory_history ih
       LEFT JOIN users u ON u.id = ih.user_id
       WHERE ih.inventory_item_id = $1
       ORDER BY ih.created_at DESC`,
      [req.params.itemId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// GET /api/inventory/history - Get all history (filtered)
// ════════════════════════════════════════════════════════════════
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const { store_id, action, page = 1, limit = 50 } = req.query;
    const storeIds = await getUserStoreIds(req.user);
    if (storeIds.length === 0) return res.json({ success: true, data: [], pagination: { total: 0, page: 1, limit: 50, totalPages: 0 } });

    let where = 'WHERE 1=1';
    const params = [];

    const effectiveStoreIds = store_id ? storeIds.filter(id => id === parseInt(store_id)) : storeIds;
    if (effectiveStoreIds.length > 0) {
      where += ` AND ih.inventory_item_id IN (SELECT id FROM inventory_items WHERE store_id IN (${effectiveStoreIds.join(',')}))`;
    }

    if (action) { params.push(action); where += ` AND ih.action = $${params.length}`; }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countParams = [...params];
    params.push(parseInt(limit));
    params.push(offset);

    const [dataRes, countRes] = await Promise.all([
      query(`SELECT ih.*, ii.product_name, ii.serial_number, ii.brand, ii.model, u.full_name as user_full_name
             FROM inventory_history ih
             JOIN inventory_items ii ON ii.id = ih.inventory_item_id
             LEFT JOIN users u ON u.id = ih.user_id
             ${where} ORDER BY ih.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
      query(`SELECT COUNT(*) as total FROM inventory_history ih ${where}`, countParams)
    ]);

    res.json({
      success: true,
      data: dataRes.rows,
      pagination: {
        total: parseInt(countRes.rows[0]?.total) || 0,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil((parseInt(countRes.rows[0]?.total) || 0) / parseInt(limit)),
      }
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// GET /api/inventory/:id - Get single inventory item
// ════════════════════════════════════════════════════════════════
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT ii.*, s.store_name FROM inventory_items ii
       JOIN stores s ON s.id = ii.store_id
       WHERE ii.id = $1 AND ii.is_active = true`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Inventory item not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// POST /api/inventory - Create new inventory item
// ════════════════════════════════════════════════════════════════
router.post('/', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const {
      productName, brand, model, processor, ram, storage, graphicsCard,
      displaySize, displayResolution, operatingSystem, batteryCondition,
      chargerIncluded, color, generation, otherSpecifications,
      warranty, purchaseDate, supplier,
      purchasePrice, sellingPrice, serialNumber, barcode, sku,
      storeId, status, remarks, category
    } = req.body;

    if (!serialNumber || !serialNumber.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Serial number is mandatory' });
    }

    // Check for duplicate serial number
    const existingSerial = await client.query(
      'SELECT id FROM inventory_items WHERE serial_number = $1 AND is_active = true',
      [serialNumber.trim()]
    );
    if (existingSerial.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'A product with this serial number already exists' });
    }

    // Validate store
    const storeCheck = await client.query('SELECT id, store_name FROM stores WHERE id = $1 AND is_active = true', [storeId]);
    if (storeCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Invalid store selected' });
    }

    // Check RBAC - staff can only add to their assigned store
    if (req.user.role !== 'owner' && req.user.store_id && req.user.store_id !== parseInt(storeId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'You can only add inventory to your assigned store' });
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const insertResult = await client.query(
      `INSERT INTO inventory_items (
        product_name, brand, model, processor, ram, storage, graphics_card,
        display_size, display_resolution, operating_system, battery_condition,
        charger_included, color, generation, other_specifications,
        warranty, purchase_date, supplier,
        purchase_price, selling_price, serial_number, barcode, sku,
        store_id, status, remarks, category, created_by, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
      RETURNING *`,
      [
        productName, brand || null, model || null, processor || null, ram || null,
        storage || null, graphicsCard || null, displaySize || null,
        displayResolution || null, operatingSystem || null, batteryCondition || null,
        chargerIncluded || null, color || null, generation || null, otherSpecifications || null,
        warranty || null, purchaseDate || null, supplier || null,
        purchasePrice || 0, sellingPrice || 0, serialNumber.trim(),
        barcode || null, sku || null, storeId,
        status || 'Available', remarks || null, category || 'Laptop',
        req.user.id, now, now
      ]
    );

    const newItem = insertResult.rows[0];

    // Record history
    await client.query(
      `INSERT INTO inventory_history (inventory_item_id, action, user_id, user_name, new_value, remarks, created_at)
       VALUES ($1, 'Added', $2, $3, $4, $5, $6)`,
      [newItem.id, req.user.id, req.user.full_name || 'Admin',
       JSON.stringify({ product_name: productName, serial_number: serialNumber }),
       'Product added to inventory', now]
    );

    await client.query('COMMIT');

    // Fetch with store_name
    const fullItem = await query(
      `SELECT ii.*, s.store_name FROM inventory_items ii
       JOIN stores s ON s.id = ii.store_id WHERE ii.id = $1`,
      [newItem.id]
    );

    res.status(201).json({ success: true, message: 'Inventory item created successfully', data: fullItem.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Serial number already exists (duplicate constraint)' });
    }
    next(err);
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════
// PUT /api/inventory/:id - Update inventory item
// ════════════════════════════════════════════════════════════════
router.put('/:id', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM inventory_items WHERE id = $1 AND is_active = true', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Inventory item not found' });
    }

    const old = existing.rows[0];
    const updates = req.body;

    // RBAC: staff can only update their assigned store's items
    if (req.user.role !== 'owner' && req.user.store_id && req.user.store_id !== old.store_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'You cannot modify inventory from another store' });
    }

    // Check serial number uniqueness if changed
    if (updates.serialNumber && updates.serialNumber.trim() !== old.serial_number) {
      const dup = await client.query(
        'SELECT id FROM inventory_items WHERE serial_number = $1 AND is_active = true AND id != $2',
        [updates.serialNumber.trim(), req.params.id]
      );
      if (dup.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Serial number already in use by another item' });
      }
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const fieldMapping = {
      productName: 'product_name', brand: 'brand', model: 'model',
      processor: 'processor', ram: 'ram', storage: 'storage',
      graphicsCard: 'graphics_card', displaySize: 'display_size',
      displayResolution: 'display_resolution', operatingSystem: 'operating_system',
      batteryCondition: 'battery_condition', chargerIncluded: 'charger_included',
      color: 'color', generation: 'generation', otherSpecifications: 'other_specifications',
      warranty: 'warranty', purchaseDate: 'purchase_date', supplier: 'supplier',
      purchasePrice: 'purchase_price', sellingPrice: 'selling_price',
      serialNumber: 'serial_number', barcode: 'barcode', sku: 'sku',
      storeId: 'store_id', status: 'status', remarks: 'remarks', category: 'category'
    };

    const setClauses = ['updated_at = $1'];
    const values = [now];
    const changes = {};

    for (const [frontField, dbField] of Object.entries(fieldMapping)) {
      if (updates[frontField] !== undefined && String(updates[frontField]) !== String(old[dbField] || '')) {
        changes[dbField] = { old: formatHistory(old[dbField]), new: formatHistory(updates[frontField]) };
        values.push(updates[frontField] || null);
        setClauses.push(`${dbField} = $${values.length}`);
      }
    }

    if (values.length > 1) {
      values.push(req.params.id);
      await client.query(`UPDATE inventory_items SET ${setClauses.join(', ')} WHERE id = $${values.length}`, values);

      // Record history for changes
      if (Object.keys(changes).length > 0) {
        await client.query(
          `INSERT INTO inventory_history (inventory_item_id, action, user_id, user_name, previous_value, new_value, remarks, created_at)
           VALUES ($1, 'Updated', $2, $3, $4, $5, $6, $7)`,
          [req.params.id, req.user.id, req.user.full_name || 'Admin',
           JSON.stringify(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.old]))),
           JSON.stringify(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.new]))),
           `Updated fields: ${Object.keys(changes).join(', ')}`, now]
        );
      }
    }

    await client.query('COMMIT');

    const updated = await client.query(
      `SELECT ii.*, s.store_name FROM inventory_items ii
       JOIN stores s ON s.id = ii.store_id WHERE ii.id = $1`,
      [req.params.id]
    );

    res.json({ success: true, message: 'Inventory item updated', data: updated.rows[0] });
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

// ════════════════════════════════════════════════════════════════
// PUT /api/inventory/:id/status - Update item status
// ════════════════════════════════════════════════════════════════
router.put('/:id/status', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const { status, remarks } = req.body;
    if (!status) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Status is required' });
    }

    const existing = await client.query('SELECT * FROM inventory_items WHERE id = $1 AND is_active = true', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const old = existing.rows[0];
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await client.query(
      'UPDATE inventory_items SET status = $1, updated_at = $2 WHERE id = $3',
      [status, now, req.params.id]
    );

    await client.query(
      `INSERT INTO inventory_history (inventory_item_id, action, user_id, user_name, previous_value, new_value, remarks, created_at)
       VALUES ($1, 'Status Changed', $2, $3, $4, $5, $6, $7)`,
      [req.params.id, req.user.id, req.user.full_name || 'Admin',
       old.status, status, remarks || `Status changed from ${old.status} to ${status}`, now]
    );

    await client.query('COMMIT');

    const updated = await client.query(
      `SELECT ii.*, s.store_name FROM inventory_items ii
       JOIN stores s ON s.id = ii.store_id WHERE ii.id = $1`,
      [req.params.id]
    );

    res.json({ success: true, message: 'Status updated', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/inventory/:id - Soft delete inventory item
// ════════════════════════════════════════════════════════════════
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await client_query_check(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await query('UPDATE inventory_items SET is_active = false, updated_at = $1 WHERE id = $2', [now, req.params.id]);

    await query(
      `INSERT INTO inventory_history (inventory_item_id, action, user_id, user_name, remarks, created_at)
       VALUES ($1, 'Disposed', $2, $3, $4, $5)`,
      [req.params.id, req.user.id, req.user.full_name || 'Admin', 'Item removed from inventory', now]
    );

    res.json({ success: true, message: 'Item deleted' });
  } catch (err) { next(err); }
});

// Helper for delete route
async function client_query_check(id) {
  const result = await query('SELECT id FROM inventory_items WHERE id = $1 AND is_active = true', [id]);
  return result.rows.length > 0;
}

// ════════════════════════════════════════════════════════════════
// POST /api/inventory/transfer - Transfer stock between stores
// ════════════════════════════════════════════════════════════════
router.post('/transfer', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const { itemId, toStoreId, remarks } = req.body;
    if (!itemId || !toStoreId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Item ID and target store are required' });
    }

    // Only owner can transfer
    if (req.user.role !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'Only admin can transfer inventory between stores' });
    }

    const existing = await client.query('SELECT * FROM inventory_items WHERE id = $1 AND is_active = true', [itemId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    const old = existing.rows[0];
    if (old.store_id === parseInt(toStoreId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Item is already in the target store' });
    }

    const targetStore = await client.query('SELECT store_name FROM stores WHERE id = $1 AND is_active = true', [toStoreId]);
    if (targetStore.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Target store not found' });
    }

    const sourceStore = await client.query('SELECT store_name FROM stores WHERE id = $1', [old.store_id]);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await client.query('UPDATE inventory_items SET store_id = $1, updated_at = $2 WHERE id = $3', [toStoreId, now, itemId]);

    await client.query(
      `INSERT INTO inventory_history (inventory_item_id, action, user_id, user_name, previous_value, new_value, remarks, created_at)
       VALUES ($1, 'Transferred', $2, $3, $4, $5, $6, $7)`,
      [itemId, req.user.id, req.user.full_name || 'Admin',
       sourceStore.rows[0]?.store_name || 'Unknown',
       targetStore.rows[0]?.store_name || 'Unknown',
       remarks || `Transferred from ${sourceStore.rows[0]?.store_name} to ${targetStore.rows[0]?.store_name}`, now]
    );

    await client.query('COMMIT');

    const updated = await client.query(
      `SELECT ii.*, s.store_name FROM inventory_items ii
       JOIN stores s ON s.id = ii.store_id WHERE ii.id = $1`,
      [itemId]
    );

    res.json({ success: true, message: 'Item transferred successfully', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════
// POST /api/inventory/mark-sold - Mark item as sold (called from orders)
// ════════════════════════════════════════════════════════════════
router.post('/mark-sold', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const { serialNumber, orderId, remarks } = req.body;
    if (!serialNumber) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Serial number is required' });
    }

    const existing = await client.query(
      'SELECT * FROM inventory_items WHERE serial_number = $1 AND is_active = true',
      [serialNumber.trim()]
    );

    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'No available item found with this serial number' });
    }

    const item = existing.rows[0];
    if (item.status !== 'Available') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Item is already ${item.status} and cannot be sold` });
    }

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await client.query(
      'UPDATE inventory_items SET status = $1, updated_at = $2 WHERE id = $3',
      ['Sold', now, item.id]
    );

    await client.query(
      `INSERT INTO inventory_history (inventory_item_id, action, user_id, user_name, previous_value, new_value, remarks, metadata, created_at)
       VALUES ($1, 'Sold', $2, $3, $4, $5, $6, $7, $8)`,
      [item.id, req.user.id, req.user.full_name || 'System',
       'Available', 'Sold',
       remarks || `Sold via order ${orderId || ''}`,
       JSON.stringify({ order_id: orderId || null, serial_number: serialNumber }),
       now]
    );

    await client.query('COMMIT');

    res.json({ success: true, message: 'Item marked as sold', data: { ...item, status: 'Sold' } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
