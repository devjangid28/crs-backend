const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function runMigration() {
  const sqlPath = path.join(__dirname, '042_free_text_payment_modes.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');
  console.log('Running migration: 042_free_text_payment_modes.sql ...');
  try {
    await pool.query(sql);
    console.log('Migration 042 completed successfully!');
  } catch (err) {
    console.error('Migration 042 failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();