const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bluechipcs',
});

const testItems = [
  {
    productName: 'NOTEBOOK ASUS B1503CVAB-S76018',
    brand: 'ASUS',
    model: 'B1503CVAB-S76018',
    serialNumber: 'TCNXCV08C442508',
    sellingPrice: 47033.90,
    purchasePrice: 45000,
    category: 'Laptop',
    status: 'Available',
  },
  {
    productName: 'NOTEBOOK HP VICTUS 15-FA2191TX',
    brand: 'HP',
    model: 'Victus 15-FA2191TX',
    serialNumber: '5CD5391BXX',
    sellingPrice: 62287.29,
    purchasePrice: 59000,
    category: 'Laptop',
    status: 'Available',
  },
  {
    productName: 'Test Laptop Dell Latitude 3420',
    brand: 'Dell',
    model: 'Latitude 3420',
    serialNumber: 'TEST-SN-001',
    sellingPrice: 35000,
    purchasePrice: 32000,
    category: 'Laptop',
    status: 'Available',
  },
  {
    productName: 'Test Monitor Samsung 24"',
    brand: 'Samsung',
    model: 'LS24R350',
    serialNumber: 'TEST-SN-002',
    sellingPrice: 12000,
    purchasePrice: 10000,
    category: 'Monitor',
    status: 'Available',
  },
];

async function run() {
  console.log('=== Adding Test Inventory Items ===\n');

  const storesRes = await pool.query('SELECT id, store_name FROM stores WHERE is_active = true ORDER BY id ASC LIMIT 1');
  if (storesRes.rows.length === 0) {
    console.error('ERROR: No active stores found. Run store migration first.');
    process.exit(1);
  }
  const storeId = storesRes.rows[0].id;
  const storeName = storesRes.rows[0].store_name;
  console.log(`Using store: ${storeName} (id: ${storeId})\n`);

  let added = 0, skipped = 0;
  for (const item of testItems) {
    try {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      await pool.query(
        `INSERT INTO inventory_items (product_name, brand, model, serial_number, selling_price, purchase_price, category, status, store_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [item.productName, item.brand, item.model, item.serialNumber, item.sellingPrice, item.purchasePrice, item.category, item.status, storeId, now, now]
      );
      console.log(`  ADDED: ${item.serialNumber} - ${item.productName} (₹${item.sellingPrice})`);
      added++;
    } catch (err) {
      console.log(`  FAIL: ${item.serialNumber} - ${err.message}`);
      skipped++;
    }
  }

  console.log(`\nDone: ${added} added, ${skipped} skipped`);
  await pool.end();
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
