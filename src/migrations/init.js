const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const parseDbUrl = (url) => {
  const regex = /postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/;
  const match = url.match(regex);
  if (!match) return null;
  return {
    user: decodeURIComponent(match[1]),
    password: decodeURIComponent(match[2]),
    host: match[3],
    port: parseInt(match[4], 10),
    database: match[5],
  };
};

const runMigrations = async () => {
  const dbUrl = process.env.DATABASE_URL;
  const dbUrlParsed = dbUrl ? parseDbUrl(dbUrl) : null;
  const dbName = dbUrlParsed ? dbUrlParsed.database : (process.env.DB_NAME || 'repair_management_system');

  // First connect to the default 'postgres' database to create the target database if needed
  const adminConfig = dbUrlParsed
    ? { host: dbUrlParsed.host, port: dbUrlParsed.port, user: dbUrlParsed.user, password: dbUrlParsed.password, database: 'postgres' }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: 'postgres',
      };

  const adminPool = new Pool(adminConfig);

  try {
    console.log('Running database migrations...');

    // Create database if it doesn't exist
    const checkDb = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]
    );
    if (checkDb.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Database "${dbName}" created`);
    } else {
      console.log(`Database "${dbName}" already exists`);
    }

    await adminPool.end();

    // Connect to the target database
    const targetConfig = dbUrlParsed
      ? {
          host: dbUrlParsed.host,
          port: dbUrlParsed.port,
          user: dbUrlParsed.user,
          password: dbUrlParsed.password,
          database: dbName,
        }
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
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') THEN
          UPDATE users SET password_hash = '$2b$10$gREx/VHAcisqwH5k2yc2/eirh77j5GWlNJI/xsTt5gY6twzTEpcnS'
          WHERE email = 'admin@gmail.com';
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') THEN
          UPDATE users SET password_hash = '$2b$10$gREx/VHAcisqwH5k2yc2/eirh77j5GWlNJI/xsTt5gY6twzTEpcnS'
          WHERE email = 'admin@crs.io';
        END IF;
      END $$;
    `);
    // Reset all sessions so users must log in again with the correct password
    await targetPool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_sessions') THEN
          UPDATE user_sessions SET is_valid = FALSE;
        END IF;
      END $$;
    `);

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
