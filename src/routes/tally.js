const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const tallyService = require('../services/tallyService');

router.use(authenticate);

// GET /api/tally/debug - Full diagnostic trace
router.get('/debug', async (req, res) => {
  try {
    console.log('\n[TallyRoute] ======================= DEBUG START =======================');
    const result = await tallyService.debug();
    console.log('[TallyRoute] ======================= DEBUG END =======================\n');
    res.json(result);
  } catch (err) {
    console.error('[TallyRoute] Debug error:', err.message);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// GET /api/tally/status
router.get('/status', async (req, res) => {
  try {
    const cfg = tallyService.getTallyConfig();
    const logResult = await pool.query(`SELECT sync_status, COUNT(*) as count FROM tally_sync_log GROUP BY sync_status`);
    const statusCounts = {};
    logResult.rows.forEach(r => { statusCounts[r.sync_status] = parseInt(r.count, 10); });
    const lastSync = await pool.query(`SELECT synced_at FROM tally_sync_log ORDER BY synced_at DESC LIMIT 1`);
    const totalItems = await pool.query('SELECT COUNT(*) as total FROM inventory_items');
    const soldItems = await pool.query(`SELECT COUNT(*) as total FROM inventory_items WHERE status = 'Sold'`);

    res.json({
      configured: true,
      host: cfg.host,
      port: cfg.port,
      company: cfg.company || '(auto-detect)',
      pollIntervalMs: cfg.pollIntervalMs,
      statusCounts,
      lastSyncAt: lastSync.rows[0]?.synced_at || null,
      inventoryStats: { total: parseInt(totalItems.rows[0].total, 10), sold: parseInt(soldItems.rows[0].total, 10) },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/tally/test - Test connection
router.post('/test', async (req, res) => {
  try {
    console.log('\n[TallyRoute] ======================= TEST START =======================');
    const result = await tallyService.testConnection();
    console.log('[TallyRoute] Test result:', JSON.stringify(result, null, 2));
    console.log('[TallyRoute] ======================= TEST END =======================\n');
    res.json(result);
  } catch (err) {
    console.error('[TallyRoute] Test error:', err.message);
    res.status(200).json({ reachable: false, error: err.message, errorDetail: { code: err.code, errno: err.errno, syscall: err.syscall, address: err.address, port: err.port } });
  }
});

// POST /api/tally/sync
router.post('/sync', async (req, res) => {
  try {
    console.log('\n[TallyRoute] ======================= SYNC START =======================');
    const result = await tallyService.syncSales(pool);
    console.log('[TallyRoute] ======================= SYNC END =======================\n');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TallyRoute] Sync error:', err.message);
    res.status(500).json({ success: false, message: err.message, synced: 0, skipped: 0, errors: 1 });
  }
});

// GET /api/tally/logs
router.get('/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const offset = (page - 1) * limit;
    const status = req.query.status || null;
    let where = '';
    const params = [];
    if (status) { where = 'WHERE sync_status = $1'; params.push(status); }

    const countResult = await pool.query(`SELECT COUNT(*) as total FROM tally_sync_log ${where}`, params);
    const paramOffset = params.length;
    const dataResult = await pool.query(
      `SELECT l.*, i.serial_number as inv_serial, i.brand, i.model FROM tally_sync_log l LEFT JOIN inventory_items i ON l.matched_inventory_id = i.id ${where} ORDER BY l.synced_at DESC LIMIT $${paramOffset + 1} OFFSET $${paramOffset + 2}`,
      [...params, limit, offset]
    );

    res.json({ data: dataResult.rows, pagination: { page, limit, total: parseInt(countResult.rows[0].total, 10), totalPages: Math.ceil(parseInt(countResult.rows[0].total, 10) / limit) } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/tally/mark-sold
router.post('/mark-sold', async (req, res) => {
  try {
    const { serialNumber, voucherNumber, remarks } = req.body;
    if (!serialNumber) return res.status(400).json({ message: 'serialNumber is required' });
    const invResult = await pool.query('SELECT id, status FROM inventory_items WHERE serial_number = $1', [serialNumber]);
    if (!invResult.rows.length) return res.status(404).json({ message: 'Inventory item not found' });
    const inv = invResult.rows[0];
    if (inv.status === 'Sold') return res.status(400).json({ message: 'Item already marked as Sold' });

    await pool.query(`UPDATE inventory_items SET status = 'Sold', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [inv.id]);
    await pool.query(`INSERT INTO inventory_history (item_id, action, performed_by, remarks) VALUES ($1, 'status_change', $2, $3)`, [inv.id, req.user?.username || 'manual', remarks || `Marked as Sold. Voucher: ${voucherNumber || 'N/A'}`]);
    await pool.query(`INSERT INTO tally_sync_log (voucher_number, stock_item_name, serial_number, matched_inventory_id, sync_status, raw_data) VALUES ($1, 'Manual', $2, $3, 'synced', $4)`, [voucherNumber || null, serialNumber, inv.id, JSON.stringify({ manual: true, voucherNumber, remarks })]);
    res.json({ success: true, message: `Serial ${serialNumber} marked as Sold`, itemId: inv.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/tally/config
router.put('/config', async (req, res) => {
  try {
    const { host, port, pollIntervalMs, company } = req.body;
    const envUpdates = {};
    if (host !== undefined) { process.env.TALLY_HOST = host; envUpdates.TALLY_HOST = host; }
    if (port !== undefined) { process.env.TALLY_PORT = String(port); envUpdates.TALLY_PORT = String(port); }
    if (pollIntervalMs !== undefined) { process.env.TALLY_POLL_INTERVAL_MS = String(pollIntervalMs); envUpdates.TALLY_POLL_INTERVAL_MS = String(pollIntervalMs); }
    if (company !== undefined) { process.env.TALLY_COMPANY = company; envUpdates.TALLY_COMPANY = company; }
    tallyService.persistConfig(envUpdates);
    const cfg = tallyService.getTallyConfig();
    res.json({ success: true, message: 'Config saved.', host: cfg.host, port: cfg.port, pollIntervalMs: cfg.pollIntervalMs, company: cfg.company });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/tally/lookup/:serial
router.get('/lookup/:serial', async (req, res) => {
  try {
    const serials = await tallyService.fetchRecentSales();
    const match = serials.find(s => s.serial_number === req.params.serial);
    res.json(match ? { found: true, data: match } : { found: false, message: 'Serial not found in recent Tally sales' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/tally/ping
router.post('/ping', async (req, res) => {
  try {
    const cfg = tallyService.getTallyConfig();
    const url = `http://${cfg.host}:${cfg.port}`;
    const result = await tallyService.rawHttpRequest ? await tallyService.rawHttpRequest(url, 'GET', { 'User-Agent': 'CRS-Ping' }) : null;
    res.json({ reachable: true, status: result?.statusCode, body: result?.body?.substring(0, 200) });
  } catch (err) {
    res.status(200).json({ reachable: false, error: err.message, code: err.code, syscall: err.syscall, address: err.address, port: err.port });
  }
});

module.exports = router;
