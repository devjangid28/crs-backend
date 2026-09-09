const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function runMigration() {
  const sqlPath = path.join(__dirname, '035_add_order_product_fields.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');
  console.log('Running migration: 035_add_order_product_fields.sql ...');
  try {
    await pool.query(sql);
    console.log('Migration 035 completed successfully!');
  } catch (err) {
    console.error('Migration 035 failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();