const { Pool } = require('pg');
const config = require('./index');

const poolConfig = config.db.databaseUrl
  ? {
      connectionString: config.db.databaseUrl,
      ssl: config.server.env === 'production'
        ? { rejectUnauthorized: false }
        : false,
    }
  : {
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      max: config.db.connectionLimit || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };

const pool = new Pool(poolConfig);

const waitForPool = async (retries = 10, delay = 300) => {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      client.release();
      return true;
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return false;
};

const sanitizeParams = (params) => {
  if (!params) return params;
  return params.map(p => p === undefined ? null : p);
};

// Convert ? placeholders to $1, $2, ... for PostgreSQL
const toPgParams = (sql, params) => {
  if (params === undefined || params === null) {
    return { text: sql, values: [] };
  }
  let count = 0;
  const text = sql.replace(/\?/g, () => `$${++count}`);
  return { text, values: sanitizeParams(params) };
};

const query = async (sql, params) => {
  try {
    const { text, values } = toPgParams(sql, params);
    const result = await pool.query(text, values);
    return result;
  } catch (error) {
    console.error('Query error:', error.message);
    throw error;
  }
};

const getConnection = async () => {
  const client = await pool.connect();
  return client;
};

module.exports = { pool, query, getConnection, waitForPool };
