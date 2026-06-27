const express = require('express');
const router = express.Router();
const config = require('../config');
const { storeIncomingMessage } = require('../services/messagingService');
const { query } = require('../config/database');
const { wa } = require('../services/logger');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'crs_webhook_verify_2024';

let io = null;
function setSocketIO(socketIO) {
  io = socketIO;
}

// GET /api/whatsapp/webhook - Meta verification
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.status(403).json({ error: 'Verification failed' });
});

// POST /api/whatsapp/webhook - Incoming messages + status callbacks
router.post('/webhook', async (req, res) => {
  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    const body = req.body;

    if (!body || body.object !== 'whatsapp_business_account') {
      return res.status(200).json({ success: true });
    }

    let messagesProcessed = 0;
    let statusesProcessed = 0;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) continue;

        // Process incoming messages
        const incomingMessages = value.messages || [];

        for (const msg of incomingMessages) {
          messagesProcessed++;
          const profileName = value.contacts?.[0]?.profile?.name || 'Unknown';
          const contactWaId = value.contacts?.[0]?.wa_id || 'unknown';

          wa.info('webhook: incoming message', { msgId: msg.id, from: msg.from, type: msg.type });

          try {
            const textBody = msg.type === 'text' ? msg.text.body : `[${msg.type}]`;

            const result = await storeIncomingMessage({
              from: msg.from,
              waId: msg.id,
              text: textBody,
              profileName,
            });

            // Emit socket event for real-time update
            if (io) {
              const newMsg = await query('SELECT * FROM messages WHERE id = $1', [result.id]);
              io.emit('new_message', { message: newMsg.rows[0], conversationId: result.convId });
            }
          } catch (dbErr) {
            wa.error('webhook: DB INSERT FAILED', dbErr, { from: msg.from, msgId: msg.id });
          }
        }

        // Process status updates
        const incomingStatuses = value.statuses || [];

        for (const status of incomingStatuses) {
          statusesProcessed++;
          wa.info('webhook: status update', { messageId: status.id, status: status.status, recipientId: status.recipient_id });

          try {
            // Try to update by provider_message_id first
            let updateResult = await query(
              `UPDATE messages SET status = $1 WHERE provider_message_id = $2 RETURNING conversation_id`,
              [status.status, status.id]
            );

            if (updateResult.rowCount === 0) {
              // Fallback: try matching by conversation_id with recipient_id
              updateResult = await query(
                `UPDATE messages SET status = $1
                 WHERE conversation_id LIKE $2
                 ORDER BY created_at DESC LIMIT 1
                 RETURNING conversation_id`,
                [status.status, `%${status.recipient_id}%`]
              );
            }

            if (updateResult.rowCount > 0 && io) {
              const convId = updateResult.rows[0].conversation_id;
              io.emit('message_status', {
                conversationId: convId,
                providerMessageId: status.id,
                status: status.status,
              });
            }
          } catch (updateErr) {
            wa.error('webhook: status UPDATE failed', updateErr, { status: status.status });
          }
        }
      }
    }

    res.status(200).json({ success: true });
  } catch (err) {
    wa.error('webhook crashed', err);
    res.status(200).json({ success: true });
  }
});

module.exports = router;
module.exports.setSocketIO = setSocketIO;