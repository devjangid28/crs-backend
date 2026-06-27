const express = require('express');
const router = express.Router();
const config = require('../config');
const { storeIncomingMessage } = require('../services/messagingService');
const { query } = require('../config/database');
const { wa } = require('../services/logger');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'crs_webhook_verify_2024';

// GET /api/whatsapp/webhook - Meta verification
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  wa.info('========== WEBHOOK GET VERIFICATION REQUEST ==========');
  wa.info('webhook GET: params', { mode, tokenPrefix: token?.slice(0, 10), challenge });

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    wa.info('webhook: VERIFICATION SUCCESSFUL - returning challenge', { challenge });
    return res.status(200).send(challenge);
  }

  wa.warn('webhook: VERIFICATION FAILED', { mode, providedToken: token?.slice(0, 10), expectedTokenPrefix: VERIFY_TOKEN.slice(0, 10) });
  return res.status(403).json({ error: 'Verification failed' });
});

// POST /api/whatsapp/webhook - Incoming messages + status callbacks
router.post('/webhook', async (req, res) => {
  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    const body = req.body;
    const headers = req.headers;

    wa.info(`========== WEBHOOK POST #${requestId} RECEIVED ==========`);
    wa.info('webhook: request headers', {
      'content-type': headers['content-type'],
      'x-hub-signature': headers['x-hub-signature']?.slice(0, 20) || '(none)',
      'user-agent': headers['user-agent'],
    });
    wa.info('webhook: body object type', { object: body.object });
    wa.payload(`webhook body #${requestId}`, body);

    if (!body || body.object !== 'whatsapp_business_account') {
      wa.warn(`webhook #${requestId}: invalid object`, { received: body?.object });
      // Must return 200 to Meta even on invalid payloads
      return res.status(200).json({ success: true });
    }

    let messagesProcessed = 0;
    let statusesProcessed = 0;

    for (const entry of body.entry || []) {
      wa.info(`webhook #${requestId}: processing entry`, { entryId: entry.id, changesCount: entry.changes?.length });

      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value) {
          wa.warn(`webhook #${requestId}: empty change value, skipping`);
          continue;
        }

        wa.info(`webhook #${requestId}: change field`, {
          field: change.field,
          messagingProduct: value.messaging_product,
          metadataPhone: value.metadata?.display_phone_number,
          metadataPhoneId: value.metadata?.phone_number_id,
        });

        // Process incoming messages
        const incomingMessages = value.messages || [];
        wa.info(`webhook #${requestId}: incoming messages count`, { count: incomingMessages.length });

        for (const msg of incomingMessages) {
          messagesProcessed++;
          const profileName = value.contacts?.[0]?.profile?.name || 'Unknown';
          const contactWaId = value.contacts?.[0]?.wa_id || 'unknown';

          wa.info(`========== WEBHOOK #${requestId} - MESSAGE #${messagesProcessed} ==========`);
          wa.info('webhook: message details', {
            msgId: msg.id,
            from: msg.from,
            type: msg.type,
            timestamp: msg.timestamp,
            profileName,
            contactWaId,
          });

          if (msg.type === 'text') {
            wa.info('webhook: text message content', {
              body: msg.text?.body,
              bodyPreview: msg.text?.body?.slice(0, 100),
            });
          } else if (msg.type === 'interactive') {
            wa.info('webhook: interactive message', {
              interactiveType: msg.interactive?.type,
              buttonReply: msg.interactive?.button_reply,
              listReply: msg.interactive?.list_reply,
            });
          } else if (msg.type === 'button') {
            wa.info('webhook: button message', { buttonText: msg.button?.text, payload: msg.button?.payload });
          } else if (msg.type === 'location') {
            wa.info('webhook: location message', { lat: msg.location?.latitude, lng: msg.location?.longitude });
          } else {
            wa.info('webhook: other message type', { type: msg.type, raw: JSON.stringify(msg).slice(0, 300) });
          }

          try {
            const textBody = msg.type === 'text' ? msg.text.body : `[${msg.type}]`;

            wa.info(`webhook #${requestId}: calling storeIncomingMessage`, {
              from: msg.from,
              textPreview: textBody.slice(0, 100),
              profileName,
            });

            const result = await storeIncomingMessage({
              from: msg.from,
              waId: msg.id,
              text: textBody,
              profileName,
            });

            wa.info(`webhook #${requestId}: DB INSERT SUCCESS`, {
              messageId: result?.id,
              customerId: result?.customerId,
              convId: result?.convId,
              sender: msg.from,
              textPreview: textBody.slice(0, 60),
            });
          } catch (dbErr) {
            wa.error(`webhook #${requestId}: DB INSERT FAILED`, dbErr, {
              from: msg.from,
              msgId: msg.id,
              type: msg.type,
            });
          }
        }

        // Process status updates
        const incomingStatuses = value.statuses || [];
        wa.info(`webhook #${requestId}: status updates count`, { count: incomingStatuses.length });

        for (const status of incomingStatuses) {
          statusesProcessed++;
          wa.info(`========== WEBHOOK #${requestId} - STATUS #${statusesProcessed} ==========`);
          wa.info('webhook: status update details', {
            messageId: status.id,
            status: status.status,
            recipientId: status.recipient_id,
            timestamp: status.timestamp,
            pricingModel: status.pricing?.model,
            pricingCategory: status.pricing?.category,
          });

          try {
            const updateResult = await query(
              `UPDATE messages SET status = $1
               WHERE conversation_id LIKE $2
               ORDER BY created_at DESC LIMIT 1`,
              [status.status, `%${status.recipient_id || status.id}%`]
            );

            wa.info(`webhook #${requestId}: status UPDATE result`, {
              statusValue: status.status,
              recipientId: status.recipient_id,
              rowsUpdated: updateResult.rowCount,
            });
          } catch (updateErr) {
            wa.error(`webhook #${requestId}: status UPDATE failed`, updateErr, {
              statusValue: status.status,
              recipientId: status.recipient_id,
            });
          }
        }
      }
    }

    wa.info(`========== WEBHOOK #${requestId} COMPLETED ==========`, {
      messagesProcessed,
      statusesProcessed,
    });

    // Always return 200 to Meta
    res.status(200).json({ success: true });
  } catch (err) {
    wa.error(`========== WEBHOOK #${requestId} CRASHED ==========`, err, {
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
    });
    // Always return 200 to Meta regardless of errors
    res.status(200).json({ success: true });
  }
});

module.exports = router;
