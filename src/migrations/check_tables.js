const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bluechipcs',
});

async function check() {
  try {
    const tables = ['messages', 'secure_tokens', 'inward_receipts', 'invoice_pdfs', 'customer_collection_records', 'customer_signatures', 'customer_feedback', 'audit_logs', 'whatsapp_templates', 'whatsapp_message_log', 'store_settings'];
    for (const table of tables) {
      const r = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
        [table]
      );
      console.log(`\n=== ${table} ===`);
      console.log(r.rows.map(c => c.column_name).join(', '));
    }
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}
check();
