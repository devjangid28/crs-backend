const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const DB_NAME = process.env.DB_NAME || 'repair_management_system';

const run = async () => {
  const poolConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: DB_NAME,
      };

  const pool = new Pool(poolConfig);

  const getColumns = async (table) => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table]
    );
    return new Set(result.rows.map(r => r.column_name));
  };

  console.log('PostgreSQL schema is managed via database_schema.pg.sql');
  console.log('This diagnostic script checks if all expected tables exist...');

  const expectedTables = ['users', 'customers', 'tickets', 'ticket_status_history', 'invoices',
    'invoice_items', 'payment_history', 'inventory', 'appointments', 'messages',
    'notes', 'attachments', 'store_settings', 'customer_satisfaction'];

  for (const table of expectedTables) {
    const exists = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
      [table]
    );
    console.log(`  ${exists.rows[0].exists ? '✓' : '✗'} ${table}`);
  }

  await pool.end();
  console.log('\nDone.');
};

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
