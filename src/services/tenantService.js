// tenantService.js — orchestrates creating a full client sandbox:
//   1) master row (saas.clients)          (local Postgres — super admin data)
//   2) Neon project + schema clone         (cloud — client business data)
//   3) seed owner credentials + default brand (inside the tenant DB)
// It also handles client (tenant) login sessions.

const { getTenantPool, runWithTenant } = require('../config/database');
const customerMaster = require('./saasMasterDb');
const neonService = require('./neonService');
const schemaClone = require('./schemaClone');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SESSION_DURATION_DAYS = 30;

// Full provisioning of a brand new client shop.
// Returns { client, credentials: { login, password }, connectionString }
const provisionClient = async (payload) => {
  const { companyName, loginId, password } = payload;

  // 1) Master row (pending) — must exist before we provision so that failures
  //    leave a clearly-marked status in the super admin panel.
  const client = await customerMaster.createClient(payload);

  // 2) Neon project.
  const neonConfigured = neonService.neonConfigured();
  if (!neonConfigured) {
    // No Neon key configured → keep the client row as "pending" listing so the
    // owner can see it and add their key. Never crash the existing system.
    console.warn('[SaaS] NEON_API_KEY not set — client created in pending state only.');
    return { client, credentials: null, provisioned: false, reason: 'NEON_API_KEY not configured' };
  }

  try {
    const { projectId, connectionUri } = await neonService.createProject(client.slug, companyName);
    await neonService.waitForProjectReady(projectId);

    // 3) Clone live schema into the fresh Neon DB.
    const parts = await schemaClone.buildSchemaParts();
    await neonService.applySchemaToDatabase(connectionUri, parts);

    // 4) Seed owner user + default store + blank brand inside the tenant DB.
    await seedTenant(client, connectionUri, { companyName, loginId, passwordHash: await bcrypt.hash(password, 10), fullName: payload.ownerName || companyName });

    // 5) Mark provisioned + active in master.
    const prov = await customerMaster.markProvisioned(client.id, connectionUri, projectId);
    if (!prov) throw new Error('Failed to update master client row');

    return { client: prov, credentials: { loginId, password, hash: null }, provisioned: true };
  } catch (err) {
    console.error('[SaaS] Provisioning failed:', err.message);
    await customerMaster.updateClient(client.id, { status: 'error' });
    throw new Error('Provisioning failed: ' + err.message);
  }
};

// Seed a fresh tenant DB: owner user + session-friendly columns + a default
// store (so branding derives from the store) + blank store_settings row.
const seedTenant = async (client, connectionUri, { companyName, loginId, passwordHash, fullName }) => {
  return runWithTenant(customerClientish(client, connectionUri), async () => {
    const { query } = require('../config/database');

    // Owner user (same columns as the live users table). The live schema has no
    // unique constraint on email, so do a manual check instead of ON CONFLICT.
    const email = loginId.includes('@') ? loginId : `${loginId}@client.local`;
    const existing = await query(
      `SELECT id FROM users WHERE username = $1 OR email = $1 LIMIT 1`,
      [loginId]
    );
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO users (full_name, email, mobile_number, username, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, $5, 'owner', TRUE)`,
        [fullName, email, client.contact_phone || '0000000000', loginId, passwordHash]
      );
    } else {
      await query(
        `UPDATE users SET full_name = $1, password_hash = $2, role = 'owner', is_active = TRUE WHERE id = $3`,
        [fullName, passwordHash, existing.rows[0].id]
      );
    }

    // Default store so the dashboard auto-selects it and branding follows.
    try {
      await query(
        `INSERT INTO stores (store_name, address, phone, is_default, is_active)
         VALUES ($1, '', '', TRUE, TRUE)
         ON CONFLICT DO NOTHING`,
        [companyName]
      );
    } catch (e) { console.warn('[SaaS] Store seed skipped:', e.message); }

    // Blank store_settings row so /api/settings returns a shape.
    try {
      const c = await query(`SELECT COUNT(*) AS cnt FROM store_settings`);
      if (parseInt(c.rows[0].cnt, 10) === 0) {
        await query(
          `INSERT INTO store_settings (company_name, phone, email, currency, timezone)
           VALUES ($1, '', '', 'INR', 'Asia/Kolkata')`,
          [companyName]
        );
      }
    } catch (e) { console.warn('[SaaS] store_settings seed skipped:', e.message); }
  });
};

// Keep schemaClone/seed helpers happy with a client-shaped object.
const customerClientish = (client, connectionUri) => ({
  id: client.id,
  connection_string: connectionUri,
});

// Validate credentials for an already-created tenant and start a session.
// Returns { success, data } shaped like the normal login route.
const tenantLogin = async (loginId, password, req) => {
  const found = await customerMaster.findTenantUserByLogin(loginId);
  if (!found) return null;

  const client = found.client;

  // Verify the password against the tenant's OWN user row (authoritative).
  let valid = false;
  try {
    valid = await runWithTenant(client, async () => {
      const { query } = require('../config/database');
      const rows = await query(
        `SELECT u.* FROM users u
         WHERE u.email = $1 OR u.mobile_number = $1 OR u.username = $1`,
        [loginId]
      );
      if (rows.rows.length === 0) return false;
      return await bcrypt.compare(password, rows.rows[0].password_hash);
    });
  } catch (err) {
    console.error('[SaaS] Tenant DB check failed:', err.message);
    return { success: false, message: 'Unable to reach your workspace database. Please try again.' };
  }
  if (!valid) return null;

  // Create session in the tenant DB (same table the existing middleware uses).
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

  let tenantUser = null;
  try {
    tenantUser = await runWithTenant(client, async () => {
      const { query } = require('../config/database');
      const row = await query(
        `SELECT id, full_name, email, mobile_number, username, role, store_id FROM users
         WHERE email = $1 OR mobile_number = $1 OR username = $1 LIMIT 1`,
        [loginId]
      );
      const u = row.rows[0];
      await query(
        `INSERT INTO user_sessions (user_id, session_token, ip_address, user_agent, is_valid, expires_at)
         VALUES ($1, $2, $3, $4, TRUE, $5)`,
        [u.id, token, req.ip || null, req.headers['user-agent'] || null, expiresAt.toISOString()]
      );
      return u;
    });
  } catch (err) {
    console.error('[SaaS] Session create failed:', err.message);
    return { success: false, message: 'Login failed while starting your workspace session.' };
  }

  // Record routing info in master so authenticate() can find the tenant.
  await customerMaster.storeSession(client.id, token, tenantUser.id, expiresAt);

  return {
    success: true,
    data: {
      user: {
        id: tenantUser.id,
        fullName: tenantUser.full_name,
        mobileNumber: tenantUser.mobile_number,
        email: tenantUser.email,
        username: tenantUser.username,
        role: tenantUser.role,
        storeId: tenantUser.store_id,
      },
      sessionToken: token,
      expiresAt: expiresAt.toISOString(),
      client: {
        clientId: client.id,
        slug: client.slug,
        companyName: client.company_name,
        allowedScreens: Array.isArray(client.allowed_screens) ? client.allowed_screens : JSON.parse(client.allowed_screens || '[]'),
        onboardingComplete: client.onboarding_complete,
      },
    },
  };
};

module.exports = { provisionClient, tenantLogin, SESSION_DURATION_DAYS };