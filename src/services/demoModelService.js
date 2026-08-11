const { pool } = require('../config/database');

// ============================================================
// Demo Model business rules
// - Base date = purchase_date if set, otherwise added_date
// - A demo unit CANNOT be sold before base_date + 60 days
// - A demo unit MUST be sold before base_date + warranty (1 year)
// ============================================================
const SELLABLE_AFTER_DAYS = 60;

function parseDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(`${d.slice(0, 10)}T00:00:00`);
  if (isNaN(date.getTime())) return null;
  return date;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Formats a Date as YYYY-MM-DD using LOCAL timezone components.
// (toISOString() would shift the date to UTC and can be off by one day.)
function toDateStr(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function baseDateOf(row) {
  const purchase = parseDate(row.purchase_date);
  if (purchase) return startOfDay(purchase);
  return startOfDay(parseDate(row.added_date) || new Date());
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

// Computes the 60-day / 1-year timeline for a demo row.
// Returns a plain object with all derived dates + day counts.
function computeDemoDates(row) {
  const base = baseDateOf(row);
  const today = startOfDay(new Date());
  const warrantyMonths = parseInt(row.warranty_months, 10) || 12;

  const sellableAfter = addDays(base, SELLABLE_AFTER_DAYS);
  const warrantyExpiry = addMonths(base, warrantyMonths);

  const daysUntilSellable = daysBetween(today, sellableAfter); // negative/0 => sellable
  const daysUntilExpiry = daysBetween(today, warrantyExpiry);  // negative/0 => expired
  const totalWarrantyDays = daysBetween(base, warrantyExpiry);

  return {
    base_date: toDateStr(base),
    sellable_after: toDateStr(sellableAfter),
    warranty_expiry: toDateStr(warrantyExpiry),
    days_until_sellable: daysUntilSellable,
    days_until_expiry: daysUntilExpiry,
    total_warranty_days: totalWarrantyDays,
    sellable: daysUntilSellable <= 0,
    expired: daysUntilExpiry < 0,
    warning: daysUntilSellable > 0 && daysUntilSellable <= 15,
  };
}

// Human friendly status text shown in the UI / push message.
function demoStatusText(row) {
  const d = computeDemoDates(row);
  if (d.expired) return `Warranty expired on ${d.warranty_expiry} - sell immediately`;
  if (!d.sellable) return `After ${d.days_until_sellable} days you can sell`;
  return `Sellable - ${d.days_until_expiry} days left to sell`;
}

// All ACTIVE (not sold) demo units that have crossed the 60-day mark.
// These are the ones the owner must be notified about.
async function findSellableDemoModels() {
  const res = await pool.query(
    `SELECT dm.*, s.store_name
     FROM demo_models dm
     JOIN stores s ON s.id = dm.store_id
     WHERE dm.is_active = true
       AND dm.status IN ('Available', 'Reserved')
       AND COALESCE(dm.purchase_date, dm.added_date) + ($1 * INTERVAL '1 day') <= CURRENT_DATE
     ORDER BY dm.added_date ASC, dm.id ASC`,
    [SELLABLE_AFTER_DAYS]
  );
  return res.rows;
}

// All active demo units with their computed timeline (for list APIs).
async function listDemoModels({ storeId, status, search, page = 1, limit = 100 } = {}) {
  const where = ['dm.is_active = true'];
  const params = [];
  const param = (v) => { params.push(v); return `$${params.length}`; };

  if (storeId) where.push(`dm.store_id = ${param(parseInt(storeId, 10))}`);
  if (status) where.push(`dm.status = ${param(status)}`);
  if (search) {
    where.push(`(dm.model_name ILIKE ${param(`%${search}%`)} OR dm.serial_number ILIKE ${param(`%${search}%`)} OR dm.brand ILIKE ${param(`%${search}%`)})`);
  }

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  params.push(parseInt(limit, 10));
  params.push(offset);

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT dm.*, s.store_name
       FROM demo_models dm
       JOIN stores s ON s.id = dm.store_id
       WHERE ${where.join(' AND ')}
       ORDER BY dm.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) as total FROM demo_models dm WHERE ${where.join(' AND ')}`,
      params.slice(0, -2)
    ),
  ]);

  return {
    data: dataRes.rows.map(row => ({ ...row, ...computeDemoDates(row), status_text: demoStatusText(row) })),
    pagination: {
      total: parseInt(countRes.rows[0]?.total) || 0,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      totalPages: Math.ceil((parseInt(countRes.rows[0]?.total) || 0) / parseInt(limit, 10)),
    },
  };
}

async function getDemoById(id) {
  const res = await pool.query(
    `SELECT dm.*, s.store_name FROM demo_models dm JOIN stores s ON s.id = dm.store_id WHERE dm.id = $1 AND dm.is_active = true`,
    [id]
  );
  return res.rows[0] || null;
}

module.exports = {
  SELLABLE_AFTER_DAYS,
  computeDemoDates,
  demoStatusText,
  baseDateOf,
  findSellableDemoModels,
  listDemoModels,
  getDemoById,
};
