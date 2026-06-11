const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const run = async () => {
  const poolConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'repair_management_system',
      };

  const pool = new Pool(poolConfig);

  for (const table of ['appointments', 'customers', 'tickets']) {
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    console.log(`\n=== ${table} ===`);
    result.rows.forEach(r => console.log(`  ${r.column_name} | ${r.data_type} | default: ${r.column_default}`));
  }

  await pool.end();
};

run().catch(err => { console.error(err.message); process.exit(1); });
