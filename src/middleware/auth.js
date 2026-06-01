const crypto = require('crypto');
const config = require('../config/index');

const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.session_token;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  try {
    const { query } = require('../config/database');
    const result = await query(
      `SELECT u.id, u.full_name, u.mobile_number, u.email, u.username, u.role, u.is_active, u.is_disabled
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
    await query('UPDATE user_sessions SET last_activity = NOW() WHERE session_token = $1', [token]);

    req.user = user;
    req.sessionToken = token;
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

module.exports = { authenticate, requireRole };
