const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'repair_management_system'
    });
(async () => {
  const r = await pool.query('SELECT email, password_hash FROM users WHERE email = $1', ['admin@gmail.com']);
  if (!r.rows.length) { console.log('User not found'); return; }
  const hash = r.rows[0].password_hash;
  console.log('Stored hash:', hash);
  const match = await bcrypt.compare('1234', hash);
  console.log('Password matches 1234:', match);
  await pool.end();
})();
