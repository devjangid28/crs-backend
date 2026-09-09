const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function runMigration() {
  const sqlPath = path.join(__dirname, '034_add_order_products.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');
  console.log('Running migration: 034_add_order_products.sql ...');
  try {
    await pool.query(sql);
    console.log('Migration 034 completed successfully!');
  } catch (err) {
    console.error('Migration 034 failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
