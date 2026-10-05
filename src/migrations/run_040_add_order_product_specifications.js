const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function runMigration() {
  const sqlPath = path.join(__dirname, '040_add_order_product_specifications.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');
  console.log('Running migration: 040_add_order_product_specifications.sql ...');
  try {
    await pool.query(sql);
    console.log('Migration 040 completed successfully!');
  } catch (err) {
    console.error('Migration 040 failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();