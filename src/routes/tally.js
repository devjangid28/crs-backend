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
      salesVoucherType: cfg.salesVoucherType,
      salesLedger: cfg.salesLedger,
      cgstLedger: cfg.cgstLedger,
      sgstLedger: cfg.sgstLedger,
      igstLedger: cfg.igstLedger,
      bankLedger: cfg.bankLedger,
      taxUnit: cfg.taxUnit,
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
    await pool.query(`INSERT INTO inventory_history (inventory_item_id, action, performed_by, remarks) VALUES ($1, 'status_change', $2, $3)`, [inv.id, req.user?.username || 'manual', remarks || `Marked as Sold. Voucher: ${voucherNumber || 'N/A'}`]);
    await pool.query(`INSERT INTO tally_sync_log (voucher_number, stock_item_name, serial_number, matched_inventory_id, sync_status, raw_data) VALUES ($1, 'Manual', $2, $3, 'synced', $4)`, [voucherNumber || null, serialNumber, inv.id, JSON.stringify({ manual: true, voucherNumber, remarks })]);
    res.json({ success: true, message: `Serial ${serialNumber} marked as Sold`, itemId: inv.id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/tally/config
router.put('/config', async (req, res) => {
  try {
    const { host, port, pollIntervalMs, company, salesVoucherType, salesLedger, cgstLedger, sgstLedger, igstLedger, bankLedger, taxUnit } = req.body;
    const envUpdates = {};
    if (host !== undefined) { process.env.TALLY_HOST = host; envUpdates.TALLY_HOST = host; }
    if (port !== undefined) { process.env.TALLY_PORT = String(port); envUpdates.TALLY_PORT = String(port); }
    if (pollIntervalMs !== undefined) { process.env.TALLY_POLL_INTERVAL_MS = String(pollIntervalMs); envUpdates.TALLY_POLL_INTERVAL_MS = String(pollIntervalMs); }
    if (company !== undefined) { process.env.TALLY_COMPANY = company; envUpdates.TALLY_COMPANY = company; }
    if (salesVoucherType !== undefined) { process.env.TALLY_SALES_VOUCHER_TYPE = salesVoucherType; envUpdates.TALLY_SALES_VOUCHER_TYPE = salesVoucherType; }
    if (salesLedger !== undefined) { process.env.TALLY_SALES_LEDGER = salesLedger; envUpdates.TALLY_SALES_LEDGER = salesLedger; }
    if (cgstLedger !== undefined) { process.env.TALLY_CGST_LEDGER = cgstLedger; envUpdates.TALLY_CGST_LEDGER = cgstLedger; }
    if (sgstLedger !== undefined) { process.env.TALLY_SGST_LEDGER = sgstLedger; envUpdates.TALLY_SGST_LEDGER = sgstLedger; }
    if (igstLedger !== undefined) { process.env.TALLY_IGST_LEDGER = igstLedger; envUpdates.TALLY_IGST_LEDGER = igstLedger; }
    if (bankLedger !== undefined) { process.env.TALLY_BANK_LEDGER = bankLedger; envUpdates.TALLY_BANK_LEDGER = bankLedger; }
    if (taxUnit !== undefined) { process.env.TALLY_TAX_UNIT = taxUnit; envUpdates.TALLY_TAX_UNIT = taxUnit; }
    tallyService.persistConfig(envUpdates);
    const cfg = tallyService.getTallyConfig();
    res.json({ success: true, message: 'Config saved.', host: cfg.host, port: cfg.port, pollIntervalMs: cfg.pollIntervalMs, company: cfg.company, salesVoucherType: cfg.salesVoucherType, salesLedger: cfg.salesLedger, cgstLedger: cfg.cgstLedger, sgstLedger: cfg.sgstLedger, igstLedger: cfg.igstLedger, bankLedger: cfg.bankLedger, taxUnit: cfg.taxUnit });
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

// POST /api/tally/push-sales - Push a sales voucher to Tally
router.post('/push-sales', async (req, res) => {
  try {
    const { partyName, voucherNumber, items, taxRate, narration, date, invoiceId, partyGstin, partyState, partyPincode, partyPlace, partyAddress, company } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items array is required with at least one item' });
    }

    // Company / dispatch-from details come from Tally itself (cached in .env)
    let companyInfo = null;
    if (company) {
      companyInfo = company;
    } else {
      try {
        const ci = await tallyService.fetchCompanyInfo(false);
        if (ci && ci.company) companyInfo = ci.company;
      } catch (_) { /* fall through to env-cached values */ }
    }

    const result = await tallyService.pushSalesVoucherWithRetry({
      partyName: partyName || 'Walk-in Customer',
      voucherNumber: voucherNumber || null,
      items,
      taxRate: taxRate || 18,
      narration: narration || `Invoice ${invoiceId || ''} via CRS`,
      date: date || null,
      roundOff: true,
      partyGstin: partyGstin || null,
      partyState: partyState || null,
      partyPincode: partyPincode || null,
      partyPlace: partyPlace || null,
      partyAddress: partyAddress || null,
      company: companyInfo || null,
    }, 3);

    // Log to tally_sync_log
    if (result.success && result.created > 0) {
      for (const item of items) {
        if (item.serialNumber) {
          await pool.query(
            `INSERT INTO tally_sync_log (voucher_number, stock_item_name, serial_number, sync_status, raw_data)
             VALUES ($1, $2, $3, $4, $5)`,
            [result.lastVchId || voucherNumber || null, item.name || '', item.serialNumber,
             result.synced ? 'synced' : 'pushed',
             JSON.stringify({ invoiceId, pushedAt: new Date().toISOString() })]
          ).catch(e => console.error('[TallyRoute] sync_log insert error:', e.message));
        }
      }
    }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TallyRoute] Push sales error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/tally/bank-ledgers - Ledgers under "Bank Accounts" for Receipt/Payment vouchers
router.get('/bank-ledgers', async (req, res) => {
  try {
    const result = await tallyService.fetchBankLedgers();
    res.json(result);
  } catch (err) {
    console.error('[TallyRoute] Fetch bank ledgers error:', err.message);
    res.status(500).json({ success: false, bankLedgers: [], count: 0, message: err.message });
  }
});

// GET /api/tally/company-info - CRS company details resolved from Tally
router.get('/company-info', async (req, res) => {
  try {
    const force = req.query.force === 'true' || req.query.force === '1';
    const result = await tallyService.fetchCompanyInfo(force);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TallyRoute] Fetch company info error:', err.message);
    res.status(500).json({ success: false, company: null, message: err.message });
  }
});

// POST /api/tally/push-receipt - Push a Receipt voucher (payment against an invoice)
router.post('/push-receipt', async (req, res) => {
  try {
    const { partyName, partyLedger, voucherNumber, refVoucherNumber, amount, bankLedger, narration, date } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number' });
    }
    const result = await tallyService.pushReceiptVoucherWithRetry({
      partyName: partyName || partyLedger || 'Walk-in Customer',
      partyLedger: partyLedger || partyName || null,
      voucherNumber: voucherNumber || null,
      refVoucherNumber: refVoucherNumber || null,
      amount: amt,
      bankLedger: bankLedger || null,
      narration: narration || `Payment received against ${refVoucherNumber || 'invoice'}`,
      date: date || null,
    }, 3);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TallyRoute] Push receipt error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/tally/validate-push - Pre-push validation before sending a voucher
router.post('/validate-push', async (req, res) => {
  try {
    const result = await tallyService.validatePrePush(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TallyRoute] Validate push error:', err.message);
    res.status(500).json({ success: false, ok: false, message: err.message });
  }
});

// GET /api/tally/stock-categories - Fetch stock categories & groups from Tally
router.get('/stock-categories', async (req, res) => {
  try {
    const result = await tallyService.fetchStockCategories();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TallyRoute] Fetch stock categories error:', err.message);
    res.status(500).json({ success: false, categories: [], groups: [], message: err.message });
  }
});

// GET /api/tally/ledgers - Fetch all ledgers from Tally
router.get('/ledgers', async (req, res) => {
  try {
    const result = await tallyService.fetchLedgers();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TallyRoute] Fetch ledgers error:', err.message);
    res.status(500).json({ success: false, ledgers: [], count: 0, message: err.message });
  }
});

// GET /api/tally/purchase-orders - Fetch Purchase Order numbers from Tally
router.get('/purchase-orders', async (req, res) => {
  try {
    const result = await tallyService.fetchPurchaseOrders();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TallyRoute] Fetch purchase orders error:', err.message);
    res.status(500).json({ success: false, purchaseOrders: [], count: 0, message: err.message });
  }
});

// GET /api/tally/purchase-ledgers - Fetch ledgers under Purchase Accounts (PURCHASE @ 18% etc.)
router.get('/purchase-ledgers', async (req, res) => {
  try {
    const result = await tallyService.fetchLedgers();
    const purchaseLedgers = (result.ledgers || [])
      .filter(l => /purchase accounts/i.test(l.parent))
      .map(l => l.name)
      .filter((v, i, a) => a.indexOf(v) === i);
    res.json({ success: true, purchaseLedgers, count: purchaseLedgers.length });
  } catch (err) {
    console.error('[TallyRoute] Fetch purchase ledgers error:', err.message);
    res.status(500).json({ success: false, purchaseLedgers: [], count: 0, message: err.message });
  }
});

// GET /api/tally/ledger-balance?name=... - Current balance for one ledger (e.g. supplier AC)
router.get('/ledger-balance', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'name query param is required' });
    const bal = await tallyService.getLedgerBalance(name);
    res.json({ success: true, name, balance: bal ? bal.closing : null, parent: bal ? bal.parent : null });
  } catch (err) {
    console.error('[TallyRoute] Fetch ledger balance error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/tally/push-purchase - Push a purchase voucher to Tally (item lands in stock under category)
router.post('/push-purchase', async (req, res) => {
  try {
    const { partyLedger, voucherNumber, refNumber, narration, date, entries, purchaseLedger } = req.body;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ success: false, message: 'entries array is required with at least one item' });
    }
    if (!partyLedger) {
      return res.status(400).json({ success: false, message: 'partyLedger (supplier AC) is required' });
    }
    const result = await tallyService.pushPurchaseVoucherWithRetry({
      partyLedger,
      voucherNumber: voucherNumber || null,
      refNumber: refNumber || null,
      narration: narration || 'Purchase via CRS',
      date: date || null,
      entries,
      purchaseLedger: purchaseLedger || 'PURCHASE @ 18%',
      roundOff: true,
    }, 2);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TallyRoute] Push purchase error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


// POST /api/tally/sync-inventory - Bulk push inventory items (Available, not yet pushed) to Tally as stock masters
router.post('/sync-inventory', async (req, res) => {
  try {
    const { storeId, limit = 100 } = req.body;

    // Find Available inventory items whose serials are NOT yet pushed to Tally.
    // Excludes 'stock_pushed' (already done), 'stock_pending' (in-flight, avoids
    // racing the background push on inventory add) and 'stock_skipped' (permanent
    // conflict - item already exists in Tally with incompatible config).
    // 'stock_error' items are picked up again so they can be retried.
    let where = `WHERE ii.status = 'Available' AND ii.is_active = true
                 AND ii.serial_number NOT IN (
                   SELECT serial_number FROM tally_sync_log
                   WHERE sync_status IN ('stock_pushed', 'stock_pending', 'stock_skipped')
                   AND serial_number IS NOT NULL
                 )`;
    const params = [];

    if (storeId) {
      params.push(parseInt(storeId, 10));
      where += ` AND ii.store_id = $${params.length}`;
    }

    params.push(parseInt(limit, 10));

    const itemsResult = await pool.query(
      `SELECT ii.id, ii.product_name, ii.serial_number, ii.brand, ii.model,
              ii.selling_price, ii.purchase_price, ii.store_id, s.store_name,
              ii.tally_category, ii.tally_category_type,
              ii.gst_applicability, ii.hsn_code, ii.hsn_description, ii.hsn_source,
              ii.gst_rate, ii.gst_source, ii.gst_taxability, ii.gst_rate_type, ii.type_of_supply
       FROM inventory_items ii
       JOIN stores s ON s.id = ii.store_id
       ${where}
       ORDER BY ii.created_at ASC LIMIT $${params.length}`,
      params
    );

    if (itemsResult.rows.length === 0) {
      return res.json({ success: true, message: 'No new inventory items to sync', pushed: 0, skipped: 0, details: [] });
    }

    // Group by product name
    const groups = {};
    for (const row of itemsResult.rows) {
      const name = row.product_name.trim();
      if (!groups[name]) {
        groups[name] = {
          name,
          brand: row.brand,
          model: row.model,
          serials: [],
          rate: parseFloat(row.selling_price) || parseFloat(row.purchase_price) || 0,
          category: row.tally_category,
          categoryType: row.tally_category_type,
          gstApplicability: row.gst_applicability,
          hsnCode: row.hsn_code,
          hsnDescription: row.hsn_description,
          hsnSource: row.hsn_source,
          gstRate: row.gst_rate,
          gstSource: row.gst_source,
          gstTaxability: row.gst_taxability,
          gstRateType: row.gst_rate_type,
          typeOfSupply: row.type_of_supply,
          items: []
        };
      }
      groups[name].serials.push(row.serial_number);
      groups[name].items.push(row);
    }

    const details = [];
    let pushed = 0, skipped = 0, errors = 0;

    for (const [productName, group] of Object.entries(groups)) {
      // One Tally stock item per serial, named "{product} [{serial}]" (see inventory.js
      // pushStockToTallyBackground - serials are embedded in the item NAME because serial
      // tracking is disabled on Tally stock items and a plain SERIALNUMBERLIST is dropped).
      const tallyNames = {};
      for (const sn of group.serials) tallyNames[sn] = `${productName} [${sn}]`;

      // Reserve rows first (prevents double-push racing with inventory add)
      for (const sn of group.serials) {
        await pool.query(
          `INSERT INTO tally_sync_log (stock_item_name, serial_number, sync_status, raw_data)
           VALUES ($1, $2, 'stock_pending', $3)`,
          [tallyNames[sn], sn, JSON.stringify({ bulkSync: true, productName, startedAt: new Date().toISOString() })]
        ).catch(e => console.error('[TallyRoute] sync_log insert error:', e.message));
      }

      try {
        const stockItems = group.serials.map(sn => ({
          name: tallyNames[sn],
          qty: 1,
          rate: group.rate,
          serials: [sn],
          category: group.category,
          categoryType: group.categoryType,
          gstApplicability: group.gstApplicability,
          hsnCode: group.hsnCode,
          hsnDescription: group.hsnDescription,
          hsnSource: group.hsnSource,
          gstRate: group.gstRate,
          gstSource: group.gstSource,
          gstTaxability: group.gstTaxability,
          gstRateType: group.gstRateType,
          typeOfSupply: group.typeOfSupply,
        }));

        const pushResult = await tallyService.pushStockItemsToTallyWithRetry(stockItems, 3);
        if (pushResult.success) {
          pushed += group.serials.length;
          await pool.query(
            `UPDATE tally_sync_log SET sync_status = 'stock_pushed', raw_data = $2
             WHERE serial_number = ANY($1) AND sync_status = 'stock_pending'`,
            [group.serials, JSON.stringify({ bulkSync: true, productName, pushedAt: new Date().toISOString(), message: 'Successfully added to Tally', tallyResponse: pushResult.message })]
          ).catch(e => console.error('[TallyRoute] sync_log update error:', e.message));
          details.push({ product: productName, serials: group.serials.length, status: 'pushed', message: 'Successfully added to Tally' });
        } else {
          const permanent = tallyService.isPermanentStockError(pushResult.message);
          errors += group.serials.length;
          await pool.query(
            `UPDATE tally_sync_log SET sync_status = $2, error_message = $3
             WHERE serial_number = ANY($1) AND sync_status = 'stock_pending'`,
            [group.serials, permanent ? 'stock_skipped' : 'stock_error', pushResult.message]
          ).catch(e => console.error('[TallyRoute] sync_log update error:', e.message));
          details.push({ product: productName, serials: group.serials.length, status: permanent ? 'skipped' : 'error', message: pushResult.message });
        }
      } catch (e) {
        const permanent = tallyService.isPermanentStockError(e.message);
        errors += group.serials.length;
        await pool.query(
          `UPDATE tally_sync_log SET sync_status = $2, error_message = $3
           WHERE serial_number = ANY($1) AND sync_status = 'stock_pending'`,
          [group.serials, permanent ? 'stock_skipped' : 'stock_error', e.message]
        ).catch(() => {});
        details.push({ product: productName, serials: group.serials.length, status: permanent ? 'skipped' : 'error', message: e.message });
      }
    }

    res.json({
      success: true,
      message: `Sync complete: ${pushed} pushed, ${skipped} skipped, ${errors} errors`,
      pushed, skipped, errors, details
    });
  } catch (err) {
    console.error('[TallyRoute] Sync inventory error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/tally/ping
router.post('/ping', async (req, res) => {
  try {
    const result = await tallyService.pingTally();
    res.json(result);
  } catch (err) {
    res.status(200).json({ reachable: false, error: err.message, code: err.code });
  }
});

// GET /api/tally/connection-status
router.get('/connection-status', async (req, res) => {
  try {
    const status = tallyService.getConnectionStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ reachable: false, error: err.message });
  }
});

// POST /api/tally/refresh-serial-map - Clear the serial number cache and rebuild from Tally
router.post('/refresh-serial-map', async (req, res) => {
  try {
    tallyService.clearSerialCache();
    const map = await tallyService.fetchStockSerialMap();
    res.json({ success: true, count: Object.keys(map).length, map });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/tally/serial-map - Get current serial number -> stock item mapping
router.get('/serial-map', async (req, res) => {
  try {
    const map = await tallyService.fetchStockSerialMap();
    res.json({ success: true, count: Object.keys(map).length, map });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
