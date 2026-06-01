const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const runMigrations = async () => {
  const poolConfig = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: 'postgres', // Connect to default DB first to create our database
      };

  const pool = new Pool(poolConfig);

  try {
    console.log('Running database migrations...');

    // Create database if it doesn't exist
    const dbName = process.env.DB_NAME || 'repair_management_system';
    const checkDb = await pool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]
    );
    if (checkDb.rows.length === 0) {
      await pool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Database "${dbName}" created`);
    } else {
      console.log(`Database "${dbName}" already exists`);
    }

    await pool.end();

    // Connect to the target database
    const targetConfig = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }
      : {
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT, 10) || 5432,
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || '',
          database: dbName,
        };

    const targetPool = new Pool(targetConfig);

    const possiblePaths = [
      path.join(__dirname, '..', '..', '..', 'database_schema.pg.sql'),
      path.join(__dirname, '..', '..', '..', '..', 'database_schema.pg.sql'),
      path.join(process.cwd(), 'database_schema.pg.sql'),
    ];

    let schemaPath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        schemaPath = p;
        break;
      }
    }

    if (!schemaPath) {
      throw new Error('database_schema.pg.sql not found. Checked: ' + possiblePaths.join(', '));
    }

    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Pre-migration: add 'owner' to user_role enum (separate transaction)
    // This must run BEFORE the main schema to avoid PG error 55P04
    // ("new enum values must be committed before they can be used")
    try {
      await targetPool.query(`ALTER TYPE user_role ADD VALUE 'owner'`);
    } catch (e) {
      // 'owner' already exists (fresh install or already migrated)
    }

    // Convert old user roles ('admin'→'owner', 'technician'→'staff')
    // in a separate transaction so the new 'owner' enum value is visible
    await targetPool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') THEN
          UPDATE users SET role = 'owner' WHERE role::text = 'admin';
          UPDATE users SET role = 'staff' WHERE role::text IN ('technician', 'user');
        END IF;
      END $$;
    `);

    // Fix existing admin user password hash (seed only runs for new rows)
    await targetPool.query(`
      UPDATE users SET password_hash = '$2b$10$gREx/VHAcisqwH5k2yc2/eirh77j5GWlNJI/xsTt5gY6twzTEpcnS'
      WHERE email = 'admin@gmail.com';
    `);
    await targetPool.query(`
      UPDATE users SET password_hash = '$2b$10$gREx/VHAcisqwH5k2yc2/eirh77j5GWlNJI/xsTt5gY6twzTEpcnS'
      WHERE email = 'admin@crs.io';
    `);
    // Reset all sessions so users must log in again with the correct password
    await targetPool.query(`UPDATE user_sessions SET is_valid = FALSE`);

    await targetPool.query(schema);

    console.log('Database migrations completed successfully!');
    console.log(`Database "${dbName}" is ready.`);
    await targetPool.end();
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
};

runMigrations();
