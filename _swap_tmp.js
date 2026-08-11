const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const c = new Client({ host: 'localhost', port: 5432, user: 'postgres', password: 'BCCS@2026', database: 'bluechipcs' });
(async () => {
  await c.connect();
  const r = await c.query(`SELECT id, password_hash FROM users WHERE mobile_number = '9998245013'`);
  if (!r.rows.length) { console.log('USER NOT FOUND'); process.exit(1); }
  const orig = r.rows[0].password_hash;
  const hash = await bcrypt.hash('Test@1234', 10);
  await c.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, r.rows[0].id]);
  console.log('PASSWORD SWAPPED, ORIGINAL SAVED');
  require('fs').writeFileSync('_pw_orig.txt', orig);
})().catch(e => { console.error('DB FAILED:', e.message); process.exit(1); });
