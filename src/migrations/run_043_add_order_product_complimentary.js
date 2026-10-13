const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function runMigration() {
  const sqlPath = path.join(__dirname, '043_add_order_product_complimentary.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');
  console.log('Running migration: 043_add_order_product_complimentary.sql ...');
  try {
    await pool.query(sql);
    console.log('Migration 043 completed successfully!');
  } catch (err) {
    console.error('Migration 043 failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
