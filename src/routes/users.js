const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');

// All user management routes require owner role
router.use(authenticate);
router.use(requireRole('owner'));

// GET /api/users - Get all users
router.get('/', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, full_name, mobile_number, email, username, role, is_active, is_disabled, created_at, updated_at
       FROM users ORDER BY created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, full_name, mobile_number, email, username, role, is_active, is_disabled, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/users - Create new user
router.post('/', async (req, res, next) => {
  try {
    const { fullName, mobileNumber, email, username, password, role } = req.body;

    if (!fullName || !mobileNumber || !password) {
      return res.status(400).json({ success: false, message: 'Full name, mobile number, and password are required' });
    }

    // Check for existing mobile
    const existingMobile = await query('SELECT id FROM users WHERE mobile_number = $1', [mobileNumber]);
    if (existingMobile.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Mobile number already exists' });
    }

    if (email) {
      const existingEmail = await query('SELECT id FROM users WHERE email = $1', [email]);
      if (existingEmail.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'Email already exists' });
      }
    }

    if (username) {
      const existingUsername = await query('SELECT id FROM users WHERE username = $1', [username]);
      if (existingUsername.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'Username already exists' });
      }
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await query(
      `INSERT INTO users (full_name, mobile_number, email, username, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [fullName, mobileNumber, email || null, username || null, passwordHash, role || 'staff']
    );

    const newUser = await query(
      `SELECT id, full_name, mobile_number, email, username, role, is_active, is_disabled, created_at
       FROM users WHERE id = $1`,
      [result.rows[0].id]
    );

    res.status(201).json({ success: true, message: 'User created successfully', data: newUser.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id - Update user
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const { fullName, mobileNumber, email, username, role } = req.body;

    if (mobileNumber && mobileNumber !== existing.rows[0].mobile_number) {
      const dup = await query('SELECT id FROM users WHERE mobile_number = $1 AND id != $2', [mobileNumber, req.params.id]);
      if (dup.rows.length > 0) {
        return res.status(409).json({ success: false, message: 'Mobile number already in use' });
      }
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (fullName !== undefined) { updates.push(`full_name = $${idx++}`); values.push(fullName); }
    if (mobileNumber !== undefined) { updates.push(`mobile_number = $${idx++}`); values.push(mobileNumber); }
    if (email !== undefined) { updates.push(`email = $${idx++}`); values.push(email || null); }
    if (username !== undefined) { updates.push(`username = $${idx++}`); values.push(username || null); }
    if (role !== undefined) { updates.push(`role = $${idx++}`); values.push(role); }

    if (updates.length > 0) {
      values.push(req.params.id);
      await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    }

    const updated = await query(
      `SELECT id, full_name, mobile_number, email, username, role, is_active, is_disabled, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );

    res.json({ success: true, message: 'User updated successfully', data: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/disable - Disable user
router.put('/:id/disable', async (req, res, next) => {
  try {
    const result = await query('UPDATE users SET is_disabled = TRUE WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    // Invalidate all sessions
    await query('UPDATE user_sessions SET is_valid = FALSE WHERE user_id = $1', [req.params.id]);
    res.json({ success: true, message: 'User disabled successfully' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/enable - Enable user
router.put('/:id/enable', async (req, res, next) => {
  try {
    const result = await query('UPDATE users SET is_disabled = FALSE WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, message: 'User enabled successfully' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/reset-password - Reset password
router.put('/:id/reset-password', async (req, res, next) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ success: false, message: 'Password must be at least 4 characters' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    const result = await query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id', [passwordHash, req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Invalidate all sessions so user must login again
    await query('UPDATE user_sessions SET is_valid = FALSE WHERE user_id = $1', [req.params.id]);

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id - Delete user
router.delete('/:id', async (req, res, next) => {
  try {
    // Cannot delete yourself
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    }

    await query('DELETE FROM user_sessions WHERE user_id = $1', [req.params.id]);
    const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
