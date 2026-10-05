const crypto = require('crypto');
const config = require('../config/index');
const { query, runWithTenant } = require('../config/database');

const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.session_token;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    // 1) Does this token belong to a client shop (tenant)? Look it up in the
    //    master registry (super admin's own PostgreSQL). If yes, route every
    //    query of this request to the client's own database.
    const { getSession, touchSession } = require('../services/saasMasterDb');
    const session = await getSession(token);
    if (session) {
      const client = { id: session.client_id, connection_string: session.connection_string };
      let user = null;
      try {
        user = await runWithTenant(client, async () => {
          const result = await query(
            `SELECT u.id, u.full_name, u.mobile_number, u.email, u.username, u.role, u.is_active, u.is_disabled, u.store_id
             FROM user_sessions s JOIN users u ON s.user_id = u.id
             WHERE s.session_token = $1 AND s.is_valid = TRUE AND s.expires_at > NOW()`,
            [token]
          );
          if (result.rows.length === 0) return null;
          const u = result.rows[0];
          await query(`UPDATE user_sessions SET last_activity = NOW(), expires_at = NOW() + INTERVAL '30 days' WHERE session_token = $1`, [token]);
          return u;
        });
      } catch (err) {
        console.error('Tenant auth error:', err.message);
        return res.status(500).json({ success: false, message: 'Authentication failed' });
      }

      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid or expired session' });
      }
      if (user.is_disabled) {
        return res.status(403).json({ success: false, message: 'Account has been disabled' });
      }
      if (!user.is_active) {
        return res.status(403).json({ success: false, message: 'Account is not active' });
      }

      await touchSession(token);
      req.user = user;
      req.sessionToken = token;
      req.isTenant = true;
      // NOTE: must not be `req.client` - Node >= 18 exposes the underlying TCP
      // socket as `req.client`, and for local (non-tenant) logins that socket is
      // still there. Serialising it throws "Converting circular structure to
      // JSON" and /auth/session + /auth/me return 500, which leaves the mobile
      // app with no session and therefore no data at all.
      req.tenantClient = {
        clientId: session.client_id,
        slug: session.slug,
        companyName: session.company_name,
        allowedScreens: Array.isArray(session.allowed_screens) ? session.allowed_screens : JSON.parse(session.allowed_screens || '[]'),
        onboardingComplete: session.onboarding_complete,
      };
      return next();
    }

    // 2) Local (super admin / existing store) login — unchanged behaviour.
    const result = await query(
      `SELECT u.id, u.full_name, u.mobile_number, u.email, u.username, u.role, u.is_active, u.is_disabled, u.store_id
       FROM user_sessions s JOIN users u ON s.user_id = u.id
       WHERE s.session_token = $1 AND s.is_valid = TRUE AND s.expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid or expired session' });
    }

    const user = result.rows[0];

    if (user.is_disabled) {
      return res.status(403).json({ success: false, message: 'Account has been disabled' });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account is not active' });
    }

    // Update last activity
    await query(`UPDATE user_sessions SET last_activity = NOW(), expires_at = NOW() + INTERVAL '30 days' WHERE session_token = $1`, [token]);

    req.user = user;
    req.sessionToken = token;
    req.isTenant = false;
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(500).json({ success: false, message: 'Authentication failed' });
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    next();
  };
};

// Only the master account (local DB owner, NOT a tenant) can manage the SaaS
// client registry.
const requireSaasAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  if (req.isTenant) {
    return res.status(403).json({ success: false, message: 'Only the master account can use the Super Admin panel' });
  }
  if (req.user.role !== 'owner' && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  }
  next();
};

// Maps an API prefix to the client "screen" that must be enabled for it.
// Used server-side so screens are enforced even if a client calls the API
// directly. Requests on behalf of the local (super admin) account are never
// restricted.
const SCREEN_GUARD_MAP = {
  '/api/tickets': ['tickets', 'newticket'],
  '/api/customers': ['tickets', 'newticket', 'orders'],
  '/api/orders': ['orders'],
  '/api/amc': ['amc'],
  '/api/quotations': ['quotation'],
  '/api/messages': ['messages'],
  '/api/inventory': ['inventory'],
  '/api/suppliers': ['inventory', 'orders'],
  '/api/demo-models': ['inventory', 'orders'],
  '/api/dashboard': ['dashboard'],
  '/api/stores': ['settings', 'dashboard'],
};

const guardClientScreens = (req, res, next) => {
  if (!req.isTenant || !req.tenantClient) return next();
  const allowed = req.tenantClient.allowedScreens || [];
  for (const [prefix, screens] of Object.entries(SCREEN_GUARD_MAP)) {
    if (req.path.startsWith(prefix) || req.baseUrl?.startsWith(prefix)) {
      const has = screens.some(s => allowed.includes(s));
      if (!has) {
        return res.status(403).json({ success: false, message: 'Access to this module is not enabled for your plan.' });
      }
    }
  }
  next();
};

module.exports = { authenticate, requireRole, requireSaasAdmin, guardClientScreens };