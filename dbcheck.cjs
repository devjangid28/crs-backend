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
    console.log('--- ticket 102 exists? ---');
    const t = await c.query('SELECT id, ticket_id, customer_name, customer_phone, status FROM tickets WHERE id = 102');
    console.log(JSON.stringify(t.rows));

    console.log('--- messages with conversation_id containing 9998945013 ---');
    const m = await c.query("SELECT id, conversation_id, sender, ticket_id, order_id, type, event, left(text,40) AS text, created_at FROM messages WHERE conversation_id LIKE '%9998945013%' ORDER BY created_at");
    m.rows.forEach(r => console.log(JSON.stringify(r)));

    console.log('--- all messages mentioning ticket_id=102 ---');
    const m2 = await c.query("SELECT id, conversation_id, sender, ticket_id, order_id, type, left(text,40) AS text, created_at FROM messages WHERE ticket_id = 102 ORDER BY created_at");
    m2.rows.forEach(r => console.log(JSON.stringify(r)));

    console.log('--- distinct conversations still present (top 30 by msg count) ---');
    const d = await c.query('SELECT conversation_id, COUNT(*) FROM messages GROUP BY conversation_id ORDER BY count DESC LIMIT 30');
    d.rows.forEach(r => console.log(JSON.stringify(r)));

    console.log('--- "dev" conversation messages ---');
    const dev = await c.query("SELECT id, conversation_id, sender, ticket_id, order_id, type, event, left(text,40) AS text, created_at FROM messages WHERE conversation_id LIKE '%dev%' OR text LIKE '%dev%' ORDER BY created_at");
    dev.rows.forEach(r => console.log(JSON.stringify(r)));
  } finally { c.release(); await pool.end(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });