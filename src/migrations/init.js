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

    // Add 'Partially Completed' to ticket_status enum if missing (existing DBs)
    // Fresh installs get it from the schema below; existing DBs need an ALTER.
    try {
      await targetPool.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_status') AND NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ticket_status')
              AND enumlabel = 'Partially Completed'
          ) THEN
            ALTER TYPE ticket_status ADD VALUE 'Partially Completed';
          END IF;
        END $$;
      `);
    } catch (e) {
      // Failed to add (e.g. enum already altered / used in a transaction); log only
      console.log('Pre-migration ticket_status check:', e.message);
    }

    // Add service_type column to tickets if missing (existing DBs)
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'service_type'
        ) THEN
          ALTER TABLE tickets ADD COLUMN service_type VARCHAR(50) DEFAULT 'Out of Warranty';
        END IF;
      END $$;
    `);

    // Add partial-completion columns to tickets if missing (existing DBs).
    // remaining_work = work still to be done, pending_amount = amount for it,
    // expected_completion_date = when the remaining work will be finished.
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'remaining_work'
        ) THEN
          ALTER TABLE tickets ADD COLUMN remaining_work TEXT DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'pending_amount'
        ) THEN
          ALTER TABLE tickets ADD COLUMN pending_amount DECIMAL(12,2) DEFAULT 0.00;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'expected_completion_date'
        ) THEN
          ALTER TABLE tickets ADD COLUMN expected_completion_date DATE DEFAULT NULL;
        END IF;
      END $$;
    `);

    // Add replacement / service-center columns to tickets if missing.
    // Used when a replacement ticket is created (laptop handed over to an
    // external service center under warranty).
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'is_replacement'
        ) THEN
          ALTER TABLE tickets ADD COLUMN is_replacement BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'replacement_taken_by'
        ) THEN
          ALTER TABLE tickets ADD COLUMN replacement_taken_by VARCHAR(150) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'replacement_service_center'
        ) THEN
          ALTER TABLE tickets ADD COLUMN replacement_service_center VARCHAR(150) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'replacement_receipt_no'
        ) THEN
          ALTER TABLE tickets ADD COLUMN replacement_receipt_no VARCHAR(50) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'replacement_invoice_no'
        ) THEN
          ALTER TABLE tickets ADD COLUMN replacement_invoice_no VARCHAR(50) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'replacement_given_date'
        ) THEN
          ALTER TABLE tickets ADD COLUMN replacement_given_date DATE DEFAULT NULL;
        END IF;
      END $$;
    `);

    // Add error_message column to messages if missing (webhook stores Meta failure reasons)
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'messages' AND column_name = 'error_message'
        ) THEN
          ALTER TABLE messages ADD COLUMN error_message TEXT DEFAULT NULL;
        END IF;
      END $$;
    `);

    // Add email/warranty/accessory columns to orders if missing.
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'email'
        ) THEN
          ALTER TABLE orders ADD COLUMN email VARCHAR(191) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'warranty'
        ) THEN
          ALTER TABLE orders ADD COLUMN warranty VARCHAR(50) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'accessory_type'
        ) THEN
          ALTER TABLE orders ADD COLUMN accessory_type VARCHAR(100) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'custom_accessory'
        ) THEN
          ALTER TABLE orders ADD COLUMN custom_accessory TEXT DEFAULT NULL;
        END IF;
      END $$;
    `);

    // Add finance payment details to orders if missing.
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'finance_down_payment'
        ) THEN
          ALTER TABLE orders ADD COLUMN finance_down_payment DECIMAL(12,2) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'finance_emi'
        ) THEN
          ALTER TABLE orders ADD COLUMN finance_emi DECIMAL(12,2) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'finance_duration'
        ) THEN
          ALTER TABLE orders ADD COLUMN finance_duration INTEGER DEFAULT NULL;
        END IF;
      END $$;
    `);

    // Add finance payment details to invoices if missing.
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'invoices' AND column_name = 'finance_down_payment'
        ) THEN
          ALTER TABLE invoices ADD COLUMN finance_down_payment DECIMAL(12,2) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'invoices' AND column_name = 'finance_emi'
        ) THEN
          ALTER TABLE invoices ADD COLUMN finance_emi DECIMAL(12,2) DEFAULT NULL;
        END IF;
      END $$;
    `);
    await targetPool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'invoices' AND column_name = 'finance_duration'
        ) THEN
          ALTER TABLE invoices ADD COLUMN finance_duration INTEGER DEFAULT NULL;
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
