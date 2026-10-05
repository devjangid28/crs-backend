// neonService.js — creates a dedicated Neon PostgreSQL project per client shop
// and provisions it with the CRS schema.
//
// Neon is used because it offers up to ~100 free projects per account, each
// with its own PostgreSQL database (0.5 GB) and scale-to-zero. This is the
// "database per tenant" model. In contrast, Render's free tier allows only one
// database per workspace, which can never scale to 100 shops.
//
// Requires NEON_API_KEY (https://console.neon.tech) in the backend .env.

const { Client } = require('pg');
const config = require('../config/index');

const NEON_API = 'https://console.neon.tech/api/v2';

const neonHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.neon.apiKey}`,
});

const neonConfigured = () => !!config.neon.apiKey;

const neonRequest = async (method, path, body) => {
  const res = await fetch(`${NEON_API}${path}`, {
    method,
    headers: neonHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.message || j.error || JSON.stringify(j).slice(0, 400);
    } catch { detail = res.statusText; }
    throw new Error(`Neon API ${res.status}: ${detail}`);
  }
  return res.json();
};

// Personal API keys need an org_id to create projects (organization-scoped
// keys infer it automatically). Resolve the id from the account via
// /users/me/organizations, or use an explicit NEON_ORG_ID env override.
let cachedOrgId = null;

const resolveOrgId = async () => {
  if (config.neon.orgId) return config.neon.orgId;
  if (cachedOrgId) return cachedOrgId;
  try {
    const data = await neonRequest('GET', '/users/me/organizations');
    const orgs = (data && data.organizations) || [];
    if (orgs.length === 0) return null;
    cachedOrgId = orgs[0].id;
    console.log(`[Neon] Using org_id ${orgs[0].id} (from ${orgs[0].name || 'account'})`);
    return cachedOrgId;
  } catch (err) {
    console.warn('[Neon] Could not resolve org_id:', err.message);
    return null;
  }
};

// Create a Neon project. Returns { projectId, name, connectionUri }.
const createProject = async (slug, companyName) => {
  const body = {
    project: {
      name: (slug || companyName || 'crs-client').slice(0, 40),
      pg_version: 16,
    },
  };
  const orgId = await resolveOrgId();
  if (orgId) body.project.org_id = orgId;
  if (config.neon.region) body.project.region_id = config.neon.region;

  const data = await neonRequest('POST', '/projects', body);
  const project = data.project || (data.projects && data.projects[0]);
  if (!project) throw new Error('Neon did not return a project');

  let connectionUri = null;
  if (data.connection_uris && data.connection_uris[0]) {
    connectionUri = data.connection_uris[0].connection_uri;
  }
  if (!connectionUri) {
    try {
      const uriData = await neonRequest('GET', `/projects/${project.id}/connection_uris`);
      if (uriData.connection_uris && uriData.connection_uris[0]) {
        connectionUri = uriData.connection_uris[0].connection_uri;
      }
    } catch (e) {
      console.warn('[Neon] Could not fetch connection URIs:', e.message);
    }
  }
  if (!connectionUri) {
    throw new Error('Neon project created but no connection URI returned');
  }

  return { projectId: project.id, name: project.name, connectionUri };
};

const waitForProjectReady = async (projectId, retries = 12, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const data = await neonRequest('GET', `/projects/${projectId}`);
      const project = data.project;
      if (project && project.synthetic_storage_size !== undefined) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, delay));
  }
  return true; // best-effort; connection will surface real errors later
};

// Delete a Neon project (permanently removes the shop's database). Best-effort:
// Neon returns 404 if the project no longer exists.
const deleteProject = async (projectId) => {
  if (!projectId) return false;
  try {
    const data = await neonRequest('DELETE', `/projects/${encodeURIComponent(projectId)}`);
    console.log(`[Neon] Project ${projectId} deleted`);
    return !(data.project && data.project.id === projectId);
  } catch (err) {
    console.warn(`[Neon] Could not delete project ${projectId}:`, err.message);
    return false;
  }
};

// Apply the cloned CRS schema to a fresh Neon database.
const applySchemaToDatabase = async (connectionUri, parts) => {
  const client = new Client({ connectionString: connectionUri, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 1) Extensions — optional; ignore failures (extensions may be preinstalled).
  if (parts.extensions) {
    for (const stmt of parts.extensions.split(';').filter(s => s.trim())) {
      try { await client.query(stmt); } catch { /* ignore */ }
    }
  }

  // 2) Main DDL (enums, sequences, tables, indexes, triggers) — one script.
  if (parts.main) {
    try {
      await client.query(parts.main);
    } catch (err) {
      // Retry once — the script is idempotent (IF NOT EXISTS / DO blocks).
      try {
        await client.query(parts.main);
      } catch (err2) {
        console.warn('[Neon] Main schema apply warning (retried):', err2.message);
      }
    }
  }

  // 3) Foreign keys — best-effort multi-pass.
  const pending = [...parts.fks];
  const MAX_PASSES = 6;
  for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass++) {
    const remaining = [];
    for (const fk of pending) {
      try {
        await client.query(fk);
      } catch {
        remaining.push(fk);
      }
    }
    pending.splice(0, pending.length, ...remaining);
    if (remaining.length === pending.length && pass > 0) break;
  }
  if (pending.length > 0) {
    console.warn(`[Neon] ${pending.length} foreign keys not applied (ignored):`, pending.length);
  }

  await client.end();
  return true;
};

module.exports = {
  neonConfigured,
  createProject,
  resolveOrgId,
  waitForProjectReady,
  applySchemaToDatabase,
  deleteProject,
};