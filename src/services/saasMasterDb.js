// Master (super admin) database access.
//
// All super admin data lives in the OWNER'S OWN PostgreSQL (the same local
// database used by CRS) under the `saas` schema. Client *business* data lives
// in each client's own Neon database (see neonService.js / schemaClone.js).
// This module is intentionally isolated from tenant routing.

const { pool, runWithTenant } = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SCREEN_IDS = [
  'dashboard', 'newticket', 'tickets', 'orders', 'amc', 'quotation',
  'messages', 'inventory', 'settings', 'help',
];

const ALL_SCREENS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'newticket', label: 'New Ticket' },
  { id: 'tickets', label: 'Manage Tickets' },
  { id: 'orders', label: 'Orders' },
  { id: 'amc', label: 'AMC' },
  { id: 'quotation', label: 'Quotation' },
  { id: 'messages', label: 'Messaging' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'settings', label: 'Admin' },
  { id: 'help', label: 'Help' },
];

// CREATE SCHEMA + tables. Runs automatically on server boot; idempotent.
const ensureSchema = async () => {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS saas;

    CREATE TABLE IF NOT EXISTS saas.clients (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      company_name TEXT NOT NULL,
      owner_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      address TEXT,
      gst TEXT,
      monthly_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      allowed_screens JSONB NOT NULL DEFAULT '["dashboard","tickets","help"]',
      connection_string TEXT,
      neon_project_id TEXT,
      onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS saas.users (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES saas.clients(id) ON DELETE CASCADE,
      login_id TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL DEFAULT 'owner'
    );

    CREATE TABLE IF NOT EXISTS saas.sessions (
      id SERIAL PRIMARY KEY,
      session_token TEXT UNIQUE NOT NULL,
      client_id INTEGER NOT NULL REFERENCES saas.clients(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      last_activity TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_saas_sessions_token ON saas.sessions (session_token);
    CREATE INDEX IF NOT EXISTS idx_saas_users_login ON saas.users (login_id);
  `);
};

const toClientJson = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    companyName: row.company_name,
    ownerName: row.owner_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    address: row.address,
    gst: row.gst,
    monthlyFee: row.monthly_fee ? parseFloat(row.monthly_fee) : 0,
    status: row.status,
    allowedScreens: Array.isArray(row.allowed_screens) ? row.allowed_screens : JSON.parse(row.allowed_screens || '[]'),
    neonProjectId: row.neon_project_id,
    onboardingComplete: row.onboarding_complete,
    createdAt: row.created_at,
    hasConnection: !!row.connection_string,
  };
};

const makeSlug = (name) => {
  const base = String(name || 'shop')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'shop';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
};

const generateCredentials = () => {
  const login = `owner_${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(5).toString('hex');
  return { login, password };
};

// â”€â”€â”€ Clients (tenants) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const createClient = async ({ companyName, contactEmail, contactPhone, ownerName, address, gst, monthlyFee, allowedScreens, loginId, password }) => {
  const slug = makeSlug(companyName);
  const screens = JSON.stringify(allowedScreens && allowedScreens.length ? allowedScreens : ['dashboard', 'tickets', 'help']);
  const fee = monthlyFee || 0;

  const result = await pool.query(
    `INSERT INTO saas.clients
       (slug, company_name, contact_email, contact_phone, owner_name, address, gst, monthly_fee, status, allowed_screens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
     RETURNING *`,
    [slug, companyName, contactEmail || null, contactPhone || null, ownerName || null, address || null, gst || null, fee, screens]
  );
  const client = result.rows[0];

  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO saas.users (client_id, login_id, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4, 'owner')
     ON CONFLICT (login_id) DO UPDATE SET client_id = EXCLUDED.client_id, password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name`,
    [client.id, loginId, hash, ownerName || companyName]
  );

  return client;
};

const listClients = async () => {
  const result = await pool.query(
    `SELECT * FROM saas.clients ORDER BY created_at DESC`
  );
  return result.rows.map(toClientJson);
};

const getClient = async (id) => {
  const result = await pool.query(`SELECT * FROM saas.clients WHERE id = $1`, [id]);
  return result.rows[0] || null;
};

const getClientBySlug = async (slug) => {
  const result = await pool.query(`SELECT * FROM saas.clients WHERE slug = $1`, [slug]);
  return result.rows[0] || null;
};

// Permanently remove a client shop. saas.users + saas.sessions are removed
// automatically (FK ON DELETE CASCADE). Returns the deleted row.
const deleteClient = async (id) => {
  const result = await pool.query(`DELETE FROM saas.clients WHERE id = $1 RETURNING *`, [id]);
  return result.rows[0] || null;
};

const updateClient = async (id, fields) => {
  const allowed = ['company_name', 'owner_name', 'contact_email', 'contact_phone', 'address', 'gst', 'monthly_fee', 'allowed_screens', 'status', 'onboarding_complete'];
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key) && value !== undefined) {
      sets.push(`${key} = $${idx++}`);
      values.push(key === 'allowed_screens' ? JSON.stringify(value) : value);
    }
  }
  if (sets.length === 0) return getClient(id);
  values.push(id);
  const result = await pool.query(`UPDATE saas.clients SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, values);
  return result.rows[0] || null;
};

const markProvisioned = async (id, connectionString, neonProjectId) => {
  const result = await pool.query(
    `UPDATE saas.clients SET connection_string = $2, neon_project_id = $3, status = 'active' WHERE id = $1 RETURNING *`,
    [id, connectionString, neonProjectId]
  );
  return result.rows[0] || null;
};

// â”€â”€â”€ Tenant-session (login of a client shop owner) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Store a login session so later requests can route to the right tenant DB.
const storeSession = async (clientId, token, userId, expiresAt) => {
  await pool.query(
    `INSERT INTO saas.sessions (session_token, client_id, user_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, clientId, userId, expiresAt]
  );
};

const getSession = async (token) => {
  const result = await pool.query(
    `SELECT s.session_token, s.client_id, s.user_id, s.expires_at,
            c.connection_string, c.status, c.onboarding_complete,
            c.allowed_screens, c.slug, c.company_name
     FROM saas.sessions s JOIN saas.clients c ON c.id = s.client_id
     WHERE s.session_token = $1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (row.status !== 'active' || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
};

const touchSession = async (token) => {
  await pool.query(
    `UPDATE saas.sessions
     SET last_activity = CURRENT_TIMESTAMP, expires_at = CURRENT_TIMESTAMP + INTERVAL '30 days'
     WHERE session_token = $1`,
    [token]
  ).catch(() => {});
};

const deleteSession = async (token) => {
  await pool.query(`DELETE FROM saas.sessions WHERE session_token = $1`, [token]).catch(() => {});
};

// Given a loginId, does it belong to a tenant shop? Returns { client, loginRow }.
const findTenantUserByLogin = async (loginId) => {
  const result = await pool.query(
    `SELECT u.*, c.*
     FROM saas.users u JOIN saas.clients c ON c.id = u.client_id
     WHERE u.login_id = $1 AND c.status = 'active'`,
    [loginId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    client: row,
    loginRow: {
      id: row.id,
      client_id: row.client_id,
      login_id: row.login_id,
      password_hash: row.password_hash,
      role: row.role,
    },
  };
};

const verifyPassword = async (password, hash) => bcrypt.compare(password, hash);

// Fully provisioned? (helper for the owner UI)
const listScreenOptions = () => ALL_SCREENS;

module.exports = {
  ensureSchema,
  SCREEN_IDS,
  ALL_SCREENS,
  toClientJson,
  makeSlug,
  generateCredentials,
  createClient,
  listClients,
  getClient,
  getClientBySlug,
  deleteClient,
  updateClient,
  markProvisioned,
  storeSession,
  getSession,
  touchSession,
  deleteSession,
  findTenantUserByLogin,
  verifyPassword,
  listScreenOptions,
  runWithTenant,
};