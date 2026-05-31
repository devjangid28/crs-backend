/**
 * MySQL to PostgreSQL Data Migration Script
 * 
 * Usage:
 *   node server/src/migrations/migrate_data.js
 * 
 * Prerequisites:
 *   1. Both MySQL and PostgreSQL must be running
 *   2. MySQL must have the data (from database_schema.sql)
 *   3. PostgreSQL must have the schema (from database_schema.pg.sql)
 *   4. Configure both connections in .env or environment variables
 * 
 * Environment variables:
 *   MySQL connection:
 *     MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DB (default: repair_management_system)
 *   PostgreSQL connection:
 *     DATABASE_URL or DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 */

const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// ============================================================
// Configuration
// ============================================================
const mysqlConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DB || 'repair_management_system',
};

const pgConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'repair_management_system',
    };

// ============================================================
// Table migration order (respecting foreign key dependencies)
// ============================================================
const TABLES = [
  { name: 'users',             order: 1 },
  { name: 'store_settings',    order: 1 },
  { name: 'customers',         order: 1 },
  { name: 'tickets',           order: 2 },
  { name: 'ticket_status_history', order: 3 },
  { name: 'invoices',          order: 3 },
  { name: 'invoice_items',     order: 4 },
  { name: 'payment_history',   order: 4 },
  { name: 'inventory',         order: 1 },
  { name: 'appointments',      order: 3 },
  { name: 'messages',          order: 1 },
  { name: 'notes',             order: 3 },
  { name: 'attachments',       order: 3 },
  { name: 'customer_satisfaction', order: 3 },
];

// ============================================================
// Main migration function
// ============================================================
async function migrateData() {
  console.log('=== MySQL to PostgreSQL Data Migration ===\n');

  let mysqlConn;
  let pgPool;

  try {
    // Connect to MySQL
    console.log('Connecting to MySQL...');
    mysqlConn = await mysql.createConnection(mysqlConfig);
    console.log(`  MySQL connected: ${mysqlConfig.host}:${mysqlConfig.port}/${mysqlConfig.database}\n`);

    // Connect to PostgreSQL
    console.log('Connecting to PostgreSQL...');
    pgPool = new Pool(pgConfig);
    // Test connection
    const pgTest = await pgPool.query('SELECT NOW() as now');
    console.log(`  PostgreSQL connected: ${pgTest.rows[0].now}\n`);

    const stats = { totalRows: 0, tables: {} };

    // Migrate tables in dependency order
    for (const table of TABLES.sort((a, b) => a.order - b.order)) {
      const tableName = table.name;
      console.log(`Migrating table: ${tableName}...`);

      try {
        // Check if table exists in MySQL
        const mysqlCheck = await mysqlConn.query(
          `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
          [mysqlConfig.database, tableName]
        );
        if (mysqlCheck[0][0].cnt === 0) {
          console.log(`  Table ${tableName} not found in MySQL, skipping.`);
          continue;
        }

        // Get columns (excluding auto_increment id for serial tables)
        const mysqlCols = await mysqlConn.query(
          `SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS
           WHERE table_schema = ? AND table_name = ?
           ORDER BY ORDINAL_POSITION`,
          [mysqlConfig.database, tableName]
        );

        const columns = mysqlCols[0]
          .filter(c => c.COLUMN_NAME !== 'id' || !c.EXTRA.includes('auto_increment'))
          .map(c => c.COLUMN_NAME);

        if (columns.length === 0) {
          console.log(`  No data columns to migrate for ${tableName}.`);
          continue;
        }

        // Check if table is empty in PostgreSQL
        const pgCount = await pgPool.query(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
        if (parseInt(pgCount.rows[0].cnt) > 0) {
          console.log(`  ${pgCount.rows[0].cnt} rows already exist in PostgreSQL ${tableName}, skipping.`);
          continue;
        }

        // Read data from MySQL
        const colList = columns.map(c => `\`${c}\``).join(', ');
        const [rows] = await mysqlConn.query(`SELECT ${colList} FROM \`${tableName}\``);

        if (rows.length === 0) {
          console.log(`  No data found in MySQL ${tableName}.`);
          continue;
        }

        // Insert into PostgreSQL
        const pgCols = columns.map(c => `"${c}"`).join(', ');
        const pgParams = columns.map((_, i) => `$${i + 1}`).join(', ');

        let insertedCount = 0;
        for (const row of rows) {
          try {
            const values = columns.map(c => {
              const val = row[c];
              // Handle MySQL-specific types
              if (val === null || val === undefined) return null;
              if (typeof val === 'boolean') return val;
              return val;
            });

            await pgPool.query(
              `INSERT INTO "${tableName}" (${pgCols}) VALUES (${pgParams}) ON CONFLICT DO NOTHING`,
              values
            );
            insertedCount++;
          } catch (rowErr) {
            console.warn(`    Error inserting row into ${tableName}: ${rowErr.message}`);
          }
        }

        stats.totalRows += insertedCount;
        stats.tables[tableName] = insertedCount;
        console.log(`  Inserted ${insertedCount}/${rows.length} rows into ${tableName}`);

        // Verify migration
        const verifyCount = await pgPool.query(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
        console.log(`  Verification: ${verifyCount.rows[0].cnt} rows in PostgreSQL ${tableName}`);

      } catch (tableErr) {
        console.error(`  Error migrating table ${tableName}: ${tableErr.message}`);
      }
    }

    // ============================================================
    // Final Summary
    // ============================================================
    console.log('\n=== Migration Summary ===');
    console.log(`Total rows migrated: ${stats.totalRows}`);
    for (const [table, count] of Object.entries(stats.tables)) {
      console.log(`  ${table}: ${count} rows`);
    }
    console.log('\n=== Migration Complete ===');

  } catch (err) {
    console.error('\nMigration failed:', err.message);
    process.exit(1);
  } finally {
    if (mysqlConn) await mysqlConn.end();
    if (pgPool) await pgPool.end();
  }
}

migrateData();
