const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bluechipcs',
});

(async () => {
  const r = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'inventory_items' ORDER BY ordinal_position`
  );
  console.log(r.rows.map(c => c.column_name).join('\n'));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });