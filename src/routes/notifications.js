const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/database');
const { authenticate } = require('../middleware/auth');

// ════════════════════════════════════════════════════════════
// GET /api/notifications - List notifications for the logged-in user
// Owners see all owner-targeted notifications; staff see their own.
// ════════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { unread_only, limit = 50, page = 1 } = req.query;
    const isOwner = req.user.role === 'owner';

    const where = isOwner
      ? [`(recipient_role = 'owner' OR recipient_user_id = $1)`]
      : [`recipient_user_id = $1`];

    const params = [req.user.id];
    if (unread_only === 'true') {
      params.push(false);
      where.push(`is_read = $${params.length}`);
    }

    const whereStr = where.join(' AND ');

    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    params.push(parseInt(limit, 10));
    params.push(offset);

    const [dataRes, countRes, unreadRes] = await Promise.all([
      query(
        `SELECT * FROM notifications WHERE ${whereStr}
         ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      query(`SELECT COUNT(*) as total FROM notifications WHERE ${whereStr}`, params.slice(0, -2)),
      query(`SELECT COUNT(*) as total FROM notifications WHERE ${whereStr} AND is_read = false`, params.slice(0, -2)),
    ]);

    res.json({
      success: true,
      data: dataRes.rows,
      pagination: {
        total: parseInt(countRes.rows[0]?.total) || 0,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        totalPages: Math.ceil((parseInt(countRes.rows[0]?.total) || 0) / parseInt(limit, 10)),
      },
      unreadCount: parseInt(unreadRes.rows[0]?.total) || 0,
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// PUT /api/notifications/:id/read - Mark one notification read
// ════════════════════════════════════════════════════════════
router.put('/:id/read', authenticate, async (req, res, next) => {
  try {
    const isOwner = req.user.role === 'owner';
    const allowed = isOwner
      ? `(recipient_role = 'owner' OR recipient_user_id = $2)`
      : `recipient_user_id = $2`;

    const result = await query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND ${allowed}`,
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Notification not found' });
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// PUT /api/notifications/read-all - Mark all notifications read
// ════════════════════════════════════════════════════════════
router.put('/read-all', authenticate, async (req, res, next) => {
  try {
    const isOwner = req.user.role === 'owner';
    if (isOwner) {
      await query(`UPDATE notifications SET is_read = true WHERE recipient_role = 'owner' OR recipient_user_id = $1`, [req.user.id]);
    } else {
      await query(`UPDATE notifications SET is_read = true WHERE recipient_user_id = $1`, [req.user.id]);
    }
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// POST /api/notifications/register-device
// Registers a mobile FCM token so the owner receives push alerts.
// ════════════════════════════════════════════════════════════
router.post('/register-device', authenticate, async (req, res, next) => {
  try {
    const { token, platform } = req.body;
    if (!token || !token.trim()) return res.status(400).json({ success: false, message: 'Device token is required' });

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await query(
      `INSERT INTO device_tokens (user_id, platform, token, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token) DO UPDATE SET user_id = $1, platform = $2, updated_at = $5
       RETURNING id`,
      [req.user.id, platform || 'android', token.trim(), now, now]
    );
    res.json({ success: true, message: 'Device registered for notifications', data: { id: result.rows[0].id } });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════
// DELETE /api/notifications/device/:token - Unregister a device token
// ════════════════════════════════════════════════════════════
router.delete('/device/:token', authenticate, async (req, res, next) => {
  try {
    await query(`DELETE FROM device_tokens WHERE token = $1 AND user_id = $2`, [req.params.token, req.user.id]);
    res.json({ success: true, message: 'Device unregistered' });
  } catch (err) { next(err); }
});

module.exports = router;
