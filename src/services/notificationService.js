const path = require('path');
const { pool } = require('../config/database');
const demoModelService = require('./demoModelService');

// ============================================================
// Notification + Push service
// - Stores notifications in the DB (in-app + mobile pull)
// - Emits real-time events over Socket.IO
// - Optionally sends real FCM pushes when firebase-admin is
//   installed and FIREBASE_SERVICE_ACCOUNT_PATH is configured.
//   (Backend never crashes if FCM is not configured.)
// ============================================================

async function createNotification({ userId, role, type, title, message, entityType, entityId }) {
  const res = await pool.query(
    `INSERT INTO notifications (recipient_user_id, recipient_role, notification_type, title, message, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId || null, role || null, type, title, message, entityType || null, entityId || null]
  );
  return res.rows[0];
}

// Dedupe check: has a notification of this type already been created for this entity?
async function notificationExists(type, entityId) {
  const res = await pool.query(
    `SELECT id FROM notifications WHERE notification_type = $1 AND entity_id = $2 LIMIT 1`,
    [type, entityId]
  );
  return res.rows.length > 0;
}

async function getOwnerIds() {
  const res = await pool.query(`SELECT id FROM users WHERE role = 'owner' AND is_active = true`);
  return res.rows.map(r => r.id);
}

// Emits a real-time event to a role (e.g. all owners) or a specific user.
function emitToRole(io, event, payload, role) {
  if (!io) return;
  io.emit(event, payload); // broadcast to every connected client (web + mobile)
}

// FCM push via firebase-admin - OPTIONAL. Requires:
//   crs-backend> npm install firebase-admin
//   and FIREBASE_SERVICE_ACCOUNT_PATH pointing at the JSON key.
let fcmReady = false;
let fcmApp = null;
let fcmMessaging = null;
let fcmErrorLogged = false;

function getFcm() {
  if (fcmReady) return { app: fcmApp, messaging: fcmMessaging };
  const configured = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!configured) return null;
  try {
    // Lazy require so the server starts fine without the package installed
    const admin = require('firebase-admin');
    const { getMessaging } = require('firebase-admin/messaging');
    if (admin.getApps().length === 0) {
      // Resolve relative paths against the project root (crs-backend), so .env
      // can use a simple "./serviceAccountKey.json".
      const keyPath = path.isAbsolute(configured)
        ? configured
        : path.resolve(__dirname, '../../', configured);
      admin.initializeApp({
        credential: admin.cert(require(keyPath)),
      });
    }
    fcmApp = admin;
    fcmMessaging = getMessaging();
    fcmReady = true;
    console.log('[Notifications] FCM ready - push notifications enabled');
  } catch (e) {
    if (!fcmErrorLogged) {
      console.error('[Notifications] FCM disabled:', e.message);
      fcmErrorLogged = true;
    }
  }
  return fcmReady ? { app: fcmApp, messaging: fcmMessaging } : null;
}

async function sendFcmPush({ title, body, userIds }) {
  const fcm = getFcm();
  if (!fcm) return { sent: 0, skipped: 'fcm-not-configured' };
  try {
    const res = await pool.query(
      `SELECT token FROM device_tokens WHERE user_id = ANY($1)`,
      [userIds]
    );
    const tokens = [...new Set(res.rows.map(r => r.token))];
    if (tokens.length === 0) return { sent: 0, skipped: 'no-tokens' };
    const message = {
      tokens,
      notification: { title, body },
      android: { priority: 'high', notification: { channelId: 'crs_alerts', clickAction: 'FLUTTER_NOTIFICATION_CLICK' } },
      data: { type: 'demo_sellable' },
    };
    const result = await fcm.messaging.sendEachForMulticast(message);
    return { sent: result.successCount, failed: result.failureCount };
  } catch (e) {
    console.error('[Notifications] FCM send error:', e.message);
    return { sent: 0, error: e.message };
  }
}

// ────────────────────────────────────────────────────────────
// Demo sellable check
// Finds demo units that crossed the 60-day mark and notifies
// the owner(s) exactly once per unit.
// ────────────────────────────────────────────────────────────
const NOTIF_TYPE = 'demo_sellable';

async function runSellableCheck(io) {
  try {
    const sellable = await demoModelService.findSellableDemoModels();
    if (sellable.length === 0) return { checked: 0, notified: 0 };

    const ownerIds = await getOwnerIds();
    const created = [];

    for (const demo of sellable) {
      if (await notificationExists(NOTIF_TYPE, demo.id)) continue;

      const text = demoModelService.demoStatusText(demo);
      const title = 'Demo product can now be sold';
      const message =
        `Model: ${demo.model_name} (S/N: ${demo.serial_number}) at ${demo.store_name || ''}. ${text}. ` +
        `Warranty expires on ${demoModelService.computeDemoDates(demo).warranty_expiry}.`;

      const notif = await createNotification({
        role: 'owner',
        type: NOTIF_TYPE,
        title,
        message,
        entityType: 'demo_model',
        entityId: demo.id,
      });
      created.push(notif);

      emitToRole(io, 'notification:new', {
        id: notif.id,
        type: notif.notification_type,
        title: notif.title,
        message: notif.message,
        entityType: notif.entity_type,
        entityId: notif.entity_id,
        createdAt: notif.created_at,
      }, 'owner');
    }

    // Attempt real mobile push for owners that registered FCM tokens
    if (created.length > 0) {
      await sendFcmPush({
        title: created[0].title,
        body: created.length === 1
          ? created[0].message
          : `${created.length} demo products are now sellable. Open the app to view.`,
        userIds: ownerIds,
      });
    }

    return { checked: sellable.length, notified: created.length };
  } catch (e) {
    console.error('[Notifications] Demo sellable check error:', e.message);
    return { checked: 0, notified: 0, error: e.message };
  }
}

module.exports = {
  createNotification,
  notificationExists,
  getOwnerIds,
  emitToRole,
  sendFcmPush,
  runSellableCheck,
};
