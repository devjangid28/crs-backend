const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bluechipcs',
});

async function runMigration() {
  const client = await pool.connect();
  try {
    // Regular (non-advanced-booking) orders are always Paid: the customer pays
    // at the counter when the order is created. Only advanced bookings can be
    // Unpaid / Partially Paid (they settle the balance on delivery).
    const res = await client.query(
      `UPDATE orders
       SET payment_status = 'Paid', updated_at = NOW()
       WHERE is_active = true
         AND (booking_type IS NULL OR booking_type <> 'advanced')
         AND payment_status <> 'Paid'`
    );
    console.log(`Fixed payment status for ${res.rowCount} order(s) to Paid.`);

    // Also mark fully-received-advance advanced bookings as Paid.
    const res2 = await client.query(
      `UPDATE orders
       SET payment_status = 'Paid', updated_at = NOW()
       WHERE is_active = true
         AND booking_type = 'advanced'
         AND remaining_balance <= 0.01
         AND payment_status <> 'Paid'`
    );
    console.log(`Fixed payment status for ${res2.rowCount} advanced booking(s) to Paid.`);
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();