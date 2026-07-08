const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'repair_management_system',
});

async function columnExists(table, column) {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return res.rows.length > 0;
}

async function tableExists(table) {
  const res = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
    [table]
  );
  return res.rows.length > 0;
}

async function addColumn(table, column, type, defaultVal = 'DEFAULT NULL') {
  if (await columnExists(table, column)) {
    console.log(`  √ ${table}.${column} already exists`);
    return;
  }
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} ${defaultVal}`);
    console.log(`  + ${table}.${column} added`);
  } catch (err) {
    console.log(`  ! ${table}.${column}: ${err.message}`);
  }
}

async function run() {
  console.log('=== Stores Table Migration ===\n');

  // 1. Create stores table if not exists
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id SERIAL PRIMARY KEY,
        store_name VARCHAR(200) NOT NULL,
        owner_name VARCHAR(150) DEFAULT NULL,
        gst_number VARCHAR(100) DEFAULT NULL,
        address TEXT DEFAULT NULL,
        phone VARCHAR(30) DEFAULT NULL,
        email VARCHAR(191) DEFAULT NULL,
        logo TEXT DEFAULT NULL,
        website VARCHAR(200) DEFAULT NULL,
        terms_conditions TEXT DEFAULT NULL,
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('√ stores table created/verified');
  } catch (err) {
    console.log('! stores table:', err.message);
  }

  // 2. Add missing columns
  console.log('\n--- Adding missing columns ---');
  await addColumn('stores', 'city', 'VARCHAR(100)');
  await addColumn('stores', 'state', 'VARCHAR(100)');
  await addColumn('stores', 'pincode', 'VARCHAR(20)');
  await addColumn('stores', 'mobile', 'VARCHAR(30)');
  await addColumn('stores', 'whatsapp_number', 'VARCHAR(30)');
  await addColumn('stores', 'notes', 'TEXT');
  await addColumn('stores', 'invoice_footer', 'TEXT');

  // 3. Create indexes (IF NOT EXISTS)
  console.log('\n--- Indexes ---');
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_stores_active ON stores (is_active)');
    console.log('√ idx_stores_active');
  } catch (err) { console.log('! idx_stores_active:', err.message); }
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_stores_default ON stores (is_default)');
    console.log('√ idx_stores_default');
  } catch (err) { console.log('! idx_stores_default:', err.message); }

  // 4. Update trigger for updated_at
  console.log('\n--- Trigger ---');
  try {
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    console.log('√ update_updated_at_column function');
  } catch (err) { console.log('! function:', err.message); }

  try {
    // Drop and recreate to avoid duplicate errors
    await pool.query('DROP TRIGGER IF EXISTS trg_stores_updated_at ON stores');
    await pool.query(`
      CREATE TRIGGER trg_stores_updated_at
      BEFORE UPDATE ON stores
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
    `);
    console.log('√ trg_stores_updated_at');
  } catch (err) { console.log('! trigger:', err.message); }

  // 5. Seed default store from store_settings if no stores exist
  console.log('\n--- Default store ---');
  const storeCount = await pool.query('SELECT COUNT(*) FROM stores');
  if (parseInt(storeCount.rows[0].count) === 0) {
    try {
      await pool.query(`
        INSERT INTO stores (store_name, gst_number, address, city, state, pincode, phone, email, website, is_default, is_active)
        SELECT
          COALESCE(company_name, 'REPAIR SHOP'),
          gst_vat,
          address,
          city,
          state,
          pincode,
          phone,
          email,
          website,
          TRUE, TRUE
        FROM store_settings
        WHERE EXISTS (SELECT 1 FROM store_settings)
        LIMIT 1
      `);
      console.log('√ Default store seeded from store_settings');
    } catch (err) { console.log('! seed:', err.message); }
  } else {
    console.log(`√ ${storeCount.rows[0].count} store(s) already exist`);
  }

  // Ensure at least one default store
  try {
    const defaultCount = await pool.query('SELECT COUNT(*) FROM stores WHERE is_default = TRUE');
    if (parseInt(defaultCount.rows[0].count) === 0) {
      await pool.query('UPDATE stores SET is_default = TRUE WHERE id = (SELECT id FROM stores ORDER BY id ASC LIMIT 1)');
      console.log('√ First store set as default');
    }
  } catch (err) { console.log('! set default:', err.message); }

  // 6. Drop NOT NULL constraint from store_id columns (was added accidentally)
  console.log('\n--- Dropping NOT NULL from store_id ---');
  for (const tbl of ['tickets', 'orders', 'customers', 'inwards']) {
    if (!await tableExists(tbl)) continue;
    try {
      await pool.query(`ALTER TABLE ${tbl} ALTER COLUMN store_id DROP NOT NULL`);
      console.log(`  √ ${tbl}.store_id NOT NULL dropped`);
    } catch (err) {
      if (err.message.includes('does not exist')) {
        // Column doesn't exist, skip
      } else {
        console.log(`  ! ${tbl}.store_id: ${err.message}`);
      }
    }
  }

  // 7. Add store_id columns to related tables
  console.log('\n--- Related tables ---');
  await addColumn('tickets', 'store_id', 'INTEGER', 'DEFAULT NULL');
  await addColumn('orders', 'store_id', 'INTEGER', 'DEFAULT NULL');
  await addColumn('customers', 'store_id', 'INTEGER', 'DEFAULT NULL');

  if (await tableExists('inwards')) {
    await addColumn('inwards', 'store_id', 'INTEGER', 'DEFAULT NULL');
  }

  console.log('\n=== Migration complete ===');
  await pool.end();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
