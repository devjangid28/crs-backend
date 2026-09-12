const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'repair_management_system',
});
(async () => {
  const c = await pool.connect();
  try {
    console.log('--- ticket 102? ---');
    console.log(JSON.stringify((await c.query('SELECT id FROM tickets WHERE id = 102')).rows));

    console.log('--- cust_ (empty) conversation messages ---');
    const m = await c.query("SELECT id, conversation_id, sender, ticket_id, order_id, type, event, phone, left(text,50) AS text, created_at FROM messages WHERE conversation_id = 'cust_' ORDER BY created_at");
    m.rows.forEach(r => console.log(JSON.stringify(r)));

    console.log('--- conversations ending 45013 still present? ---');
    const d = await c.query("SELECT conversation_id, COUNT(*) FROM messages WHERE conversation_id LIKE '%45013%' GROUP BY conversation_id");
    d.rows.forEach(r => console.log(JSON.stringify(r)));

    console.log('--- how many conversations reference ticket 102 now? ---');
    const t = await c.query('SELECT conversation_id, COUNT(*) FROM messages WHERE ticket_id = 102 GROUP BY conversation_id');
    t.rows.forEach(r => console.log(JSON.stringify(r)));

    console.log('--- saved customers matching dev / 45013 ---');
    const cu = await c.query("SELECT id, name, phone, company FROM customers WHERE phone LIKE '%45013%' OR name ILIKE '%dev%' OR company ILIKE '%element%' LIMIT 10");
    cu.rows.forEach(r => console.log(JSON.stringify(r)));
  } finally { c.release(); await pool.end(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });