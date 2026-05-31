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
