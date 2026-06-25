const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const SESSION_DURATION_DAYS = 30;

const generateSessionToken = () => {
  return crypto.randomBytes(48).toString('hex');
};

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { loginId, password, rememberMe } = req.body;

    if (!loginId || !password) {
      return res.status(400).json({ success: false, message: 'Login ID and password are required' });
    }

    // Find user by email, mobile_number, or username
    const result = await query(
      `SELECT * FROM users WHERE (email = $1 OR mobile_number = $1 OR username = $1) AND is_active = TRUE`,
      [loginId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (user.is_disabled) {
      return res.status(403).json({ success: false, message: 'Account has been disabled by administrator' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Create new session (existing sessions remain valid)
    const sessionToken = generateSessionToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);

    await query(
      `INSERT INTO user_sessions (user_id, session_token, ip_address, user_agent, is_valid, expires_at)
       VALUES ($1, $2, $3, $4, TRUE, $5)`,
      [user.id, sessionToken, req.ip || null, req.headers['user-agent'] || null, expiresAt.toISOString()]
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          fullName: user.full_name,
          mobileNumber: user.mobile_number,
          email: user.email,
          username: user.username,
          role: user.role
        },
        sessionToken,
        expiresAt: expiresAt.toISOString()
      }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body.sessionToken;
    if (token) {
      await query('UPDATE user_sessions SET is_valid = FALSE WHERE session_token = $1', [token]);
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/session - Validate current session
router.get('/session', authenticate, async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: {
        user: req.user,
        sessionToken: req.sessionToken
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me - Get current user profile
router.get('/me', authenticate, async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: {
        id: req.user.id,
        fullName: req.user.full_name,
        mobileNumber: req.user.mobile_number,
        email: req.user.email,
        username: req.user.username,
        role: req.user.role
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
