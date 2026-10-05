// Routes for the Super Admin panel — managing client shops (tenants).
// Only the master account (local owner, not a tenant) can use these.

const express = require('express');
const router = express.Router();
const { authenticate, requireSaasAdmin, guardClientScreens } = require('../middleware/auth');
const master = require('../services/saasMasterDb');
const tenantService = require('../services/tenantService');
const neonService = require('../services/neonService');

// Screens available to configure for each client.
router.get('/screens', authenticate, requireSaasAdmin, (req, res) => {
  res.json({ success: true, data: master.ALL_SCREENS });
});

// List all clients (super admin).
router.get('/clients', authenticate, requireSaasAdmin, async (req, res, next) => {
  try {
    const clients = await master.listClients();
    res.json({ success: true, data: clients, neonConfigured: neonService.neonConfigured() });
  } catch (err) { next(err); }
});

// Create a client WITHOUT provisioning (returns credentials to give to the shop).
// Provisioning runs when NEON_API_KEY is set; otherwise the row is "pending".
router.post('/clients', authenticate, requireSaasAdmin, async (req, res, next) => {
  try {
    const {
      companyName, contactEmail, contactPhone, ownerName, address, gst,
      monthlyFee, allowedScreens, loginId, password,
    } = req.body;

    if (!companyName) {
      return res.status(400).json({ success: false, message: 'Company name is required' });
    }

    // Accept custom owner credentials from the form, otherwise auto-generate.
    const LOGIN_RE = /^[a-zA-Z0-9._@-]{3,}$/;
    let creds;
    if (loginId || password) {
      if (typeof loginId !== 'string' || !LOGIN_RE.test(loginId)) {
        return res.status(400).json({ success: false, message: 'Custom Login ID must be 3+ characters (letters, numbers, . _ @ -)' });
      }
      if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ success: false, message: 'Custom Password must be at least 6 characters' });
      }
      creds = { login: loginId, password };
    } else {
      creds = master.generateCredentials();
    }

    const buyScreen = allowedScreens && allowedScreens.length ? allowedScreens : ['dashboard', 'tickets', 'help'];
    const payload = {
      companyName,
      contactEmail,
      contactPhone,
      ownerName,
      address,
      gst,
      monthlyFee,
      allowedScreens: buyScreen,
      loginId: creds.login,
      password: creds.password,
    };

    const result = await tenantService.provisionClient(payload);

    res.status(201).json({
      success: true,
      message: result.provisioned
        ? 'Client created and provisioned successfully'
        : `Client created. Awaiting provisioning (${result.reason || 'check Neon configuration'})`,
      data: {
        client: master.toClientJson(result.client),
        credentials: { loginId: creds.login, password: creds.password },
        provisioned: !!result.provisioned,
      },
    });
  } catch (err) { next(err); }
});

// Get one client.
router.get('/clients/:id', authenticate, requireSaasAdmin, async (req, res, next) => {
  try {
    const client = await master.getClient(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, data: master.toClientJson(client) });
  } catch (err) { next(err); }
});

// Update client details / screens / fee.
router.put('/clients/:id', authenticate, requireSaasAdmin, async (req, res, next) => {
  try {
    const {
      companyName, ownerName, contactEmail, contactPhone, address, gst,
      monthlyFee, allowedScreens, status,
    } = req.body;
    const fields = {
      company_name: companyName, owner_name: ownerName,
      contact_email: contactEmail, contact_phone: contactPhone,
      address, gst, monthly_fee: monthlyFee, status,
    };
    if (Array.isArray(allowedScreens)) fields.allowed_screens = allowedScreens;

    const client = await master.updateClient(req.params.id, fields);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, message: 'Client updated', data: master.toClientJson(client) });
  } catch (err) { next(err); }
});

// Re-provision (e.g. after adding NEON_API_KEY) — creates the Neon DB + schema.
router.post('/clients/:id/provision', authenticate, requireSaasAdmin, async (req, res, next) => {
  try {
    const client = await master.getClient(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    if (client.connection_string) {
      return res.status(400).json({ success: false, message: 'Client is already provisioned' });
    }
    if (!neonService.neonConfigured()) {
      return res.status(400).json({ success: false, message: 'NEON_API_KEY is not configured in the backend .env file' });
    }

    const { projectId, connectionUri } = await neonService.createProject(client.slug, client.company_name);
    await neonService.waitForProjectReady(projectId);
    const schemaClone = require('../services/schemaClone');
    const schemaParts = await schemaClone.buildSchemaParts();
    await neonService.applySchemaToDatabase(connectionUri, schemaParts);

    // Seed owner login/password (from saas.users) into the tenant DB.
    const users = await require('../config/database').query(
      `SELECT u.*, c.* FROM saas.users u JOIN saas.clients c ON c.id = u.client_id WHERE u.client_id = $1`,
      [client.id]
    );
    const userRow = users.rows[0];
    if (!userRow) {
      return res.status(400).json({ success: false, message: 'Owner credentials missing for this client' });
    }
    const { seedTenant } = require('../services/tenantService');
    await seedTenant(client, connectionUri, {
      companyName: client.company_name,
      loginId: userRow.login_id,
      passwordHash: userRow.password_hash,
      fullName: userRow.full_name || client.company_name,
    });

    const updated = await master.markProvisioned(client.id, connectionUri, projectId);
    res.json({ success: true, message: 'Workspace provisioned', data: master.toClientJson(updated) });
  } catch (err) { next(err); }
});

// Toggle active/suspended.
router.post('/clients/:id/toggle', authenticate, requireSaasAdmin, async (req, res, next) => {
  try {
    const client = await master.getClient(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    const nextStatus = client.status === 'active' ? 'suspended' : 'active';
    await master.updateClient(client.id, { status: nextStatus });
    res.json({ success: true, message: `Client ${nextStatus === 'active' ? 'activated' : 'suspended'}`, data: { status: nextStatus } });
  } catch (err) { next(err); }
});

// Delete a client shop permanently: removes the master registry row
// (saas.clients, saas.users, saas.sessions — cascade) AND the shop's Neon database.
router.delete('/clients/:id', authenticate, requireSaasAdmin, async (req, res, next) => {
  try {
    const client = await master.getClient(req.params.id);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    let neonDeleted = false;
    if (client.neon_project_id) {
      neonDeleted = await neonService.deleteProject(client.neon_project_id);
    }

    await master.deleteClient(client.id);

    // Drop any cached connection pool for this tenant so its DB file handles
    // are released and never reused after deletion.
    const dbConfig = require('../config/database');
    dbConfig.clearTenantPools();

    const dbNotice = client.connection_string
      ? (neonDeleted ? ' Its Neon database was deleted.' : ' Its Neon database could not be deleted automatically — remove it in the Neon console.')
      : '';
    res.json({
      success: true,
      message: `Client "${client.company_name}" was deleted.${dbNotice}`,
    });
  } catch (err) { next(err); }
});

// Mark my own onboarding complete (tenant marks its own after filling shop
// details). Requires a tenant session.
router.post('/onboarding-complete', authenticate, async (req, res, next) => {
  try {
    if (!req.isTenant) {
      return res.status(400).json({ success: false, message: 'Only client workspaces can be onboarded' });
    }
    await master.updateClient(req.tenantClient.clientId, { onboarding_complete: true });
    req.tenantClient.onboardingComplete = true;
    res.json({ success: true, message: 'Onboarding complete' });
  } catch (err) { next(err); }
});

module.exports = router;