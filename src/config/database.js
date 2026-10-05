const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./index');

// Multi-tenant request context. When a request belongs to a client (tenant),
// the middleware wraps the request in runWithTenant() and every query() call
// made inside that request is automatically routed to the tenant's own
// PostgreSQL database. Requests without tenant context keep using the local
// (super admin) pool, so the existing system behaves exactly as before.
const tenantStorage = new AsyncLocalStorage();
const tenantPools = new Map();

const poolConfig = config.db.databaseUrl
  ? {
      connectionString: config.db.databaseUrl,
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

// Create (and cache) a pool for a tenant database from its connection string.
// Each client gets its own PostgreSQL database on Neon.
const getTenantPool = (client) => {
  if (!client || !client.id || !client.connection_string) {
    throw new Error('Invalid tenant configuration: missing connection string');
  }
  const key = `client_${client.id}`;
  if (tenantPools.has(key)) return tenantPools.get(key);

  const isLocal = /localhost|127\.0\.0\.1|::1/.test(client.connection_string);
  const tenantPool = new Pool({
    connectionString: client.connection_string,
    max: client.pool_size || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  });

  tenantPool.on('error', (err) => {
    console.error(`Tenant pool error (client ${client.id}):`, err.message);
  });

  tenantPools.set(key, tenantPool);
  return tenantPool;
};

// Run `fn` with tenant context. Entire request handlers get wrapped with this
// so queries via query() hit the tenant DB instead of the local one.
const runWithTenant = (client, fn) => {
  return tenantStorage.run({ client, pool: getTenantPool(client) }, fn);
};

// Current tenant (client) for the request, or null when running locally.
const getTenant = () => tenantStorage.getStore() || null;

// Pool used by query(): tenant pool when in a tenant request, else local pool.
const currentPool = () => {
  const ctx = tenantStorage.getStore();
  if (ctx && ctx.pool) return ctx.pool;
  return pool;
};

const clearTenantPools = () => tenantPools.clear();

const query = async (sql, params) => {
  try {
    const { text, values } = toPgParams(sql, params);
    const result = await currentPool().query(text, values);
    return result;
  } catch (error) {
    console.error('Query error:', error.message);
    throw error;
  }
};

const getConnection = async () => {
  const client = await currentPool().connect();
  return client;
};

module.exports = { pool, query, getConnection, waitForPool, runWithTenant, getTenant, getTenantPool, currentPool, clearTenantPools };
