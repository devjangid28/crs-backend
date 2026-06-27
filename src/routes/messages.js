const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { createTextMessage, createPdfMessage, createLinkMessage, createStatusEvent } = require('../services/messagingService');
const { sendTextMessage, isEnabled } = require('../services/whatsappService');
const { logAudit, actions } = require('../services/auditService');
const { authenticate } = require('../middleware/auth');
const { simulateDelivery, SIMULATION_PREFIX } = require('../services/simulationService');

// GET /api/messages - Get messages by conversation_id (auth-protected)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { conversationId, ticketId } = req.query;
    let sql = 'SELECT * FROM messages WHERE 1=1';
    const params = [];
    if (conversationId) { sql += ' AND conversation_id = ?'; params.push(conversationId); }
    if (ticketId) { sql += ' AND ticket_id = ?'; params.push(ticketId); }
    sql += ' ORDER BY created_at ASC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// POST /api/messages - Send a text message (auth-protected)
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { conversationId, ticketId, customerId, sender, text, phone } = req.body;

    // Send via WhatsApp if enabled and phone provided
    let providerMessageId = null;
    if (isEnabled() && phone) {
      try {
        const waResult = await sendTextMessage(phone, text, { conversationId, ticketId, customerId });
        if (waResult.success) {
          providerMessageId = waResult.messageId;
        } else {
          console.error('WhatsApp send failed (non-fatal):', waResult.error);
        }
      } catch (waErr) {
        console.error('WhatsApp send exception (non-fatal):', waErr.message);
      }
    }

    // Check if sendTextMessage already saved this message (via saveMessagesRecord)
    let msgResult;
    if (providerMessageId && conversationId) {
      const existing = await query(
        'SELECT id FROM messages WHERE conversation_id = $1 AND text = $2 ORDER BY created_at DESC LIMIT 1',
        [conversationId, text]
      );
      if (existing.rows.length > 0) {
        // Update the message created by saveMessagesRecord with sender info
        await query('UPDATE messages SET sender = $1, status = $2 WHERE id = $3',
          [sender || req.user?.full_name || 'Staff', 'sent', existing.rows[0].id]);
        msgResult = await query('SELECT * FROM messages WHERE id = $1', [existing.rows[0].id]);
        return res.status(201).json({ success: true, data: msgResult.rows[0] });
      }
    }

    const msg = await createTextMessage({
      conversationId: conversationId || `CONV-${Date.now()}`,
      ticketId: ticketId || null,
      customerId: customerId || null,
      sender: sender || req.user?.full_name || 'Staff',
      text: text || '',
    });

    msgResult = await query('SELECT * FROM messages WHERE id = $1', [msg.id]);

    await logAudit({
      action: actions.MESSAGE_SENT,
      ticketId,
      entityType: 'message',
      entityId: String(msg.id),
      performedBy: req.user?.full_name || 'Staff',
    });

    // Simulation delivery event
    setImmediate(() => {
      simulateDelivery({
        conversationId: conversationId || `CONV-${Date.now()}`,
        ticketId: ticketId || null,
        customerId: customerId || null,
        itemType: 'Text Message',
        itemName: 'Message',
        performedBy: req.user?.full_name || 'Staff',
      }).catch(e => console.error('Simulation event failed:', e.message));
    });

    res.status(201).json({ success: true, data: msgResult.rows[0] });
  } catch (err) { next(err); }
});

// GET /api/messages/conversations - List all conversations (auth-protected)
router.get('/conversations', authenticate, async (req, res, next) => {
  try {
    const sql = `SELECT * FROM (
                   SELECT DISTINCT ON (m.conversation_id)
                          m.conversation_id,
                          m.customer_id,
                          m.ticket_id,
                          m.created_at as last_message_at,
                          (SELECT text FROM messages WHERE conversation_id = m.conversation_id ORDER BY created_at DESC LIMIT 1) as last_text,
                          (SELECT type FROM messages WHERE conversation_id = m.conversation_id ORDER BY created_at DESC LIMIT 1) as last_type
                   FROM messages m
                   ORDER BY m.conversation_id, m.created_at DESC
                 ) sub
                 ORDER BY sub.last_message_at DESC`;
    const conversations = await query(sql);
    res.json({ success: true, data: conversations.rows });
  } catch (err) { next(err); }
});

// POST /api/messages/pdf - Send a PDF message (auth-protected)
router.post('/pdf', authenticate, async (req, res, next) => {
  try {
    const { conversationId, ticketId, customerId, sender, fileName, fileSize, documentType, event, phone } = req.body;

    // Send WhatsApp notification with link if phone provided
    if (isEnabled() && phone) {
      const waText = `*${documentType || 'Document'}*\n\n${fileName || 'document'}\n\nPlease check your CRS portal for details.`;
      sendTextMessage(phone, waText, { conversationId, ticketId, customerId }).catch(e =>
        console.error('WhatsApp PDF notification failed:', e.message)
      );
    }
    const msg = await createPdfMessage({
      conversationId: conversationId || `CONV-${Date.now()}`,
      ticketId: ticketId || null,
      customerId: customerId || null,
      sender: 'Staff',
      fileName: fileName || 'document.pdf',
      fileSize: fileSize || '0',
      documentType: documentType || 'PDF',
      event: event || '',
    });

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [msg.id]);

    await logAudit({
      action: actions.MESSAGE_SENT,
      ticketId,
      entityType: 'message',
      entityId: String(msg.id),
      performedBy: req.user?.full_name || 'Staff',
      details: { documentType, fileName, fileSize },
    });

    // Simulation delivery event
    setImmediate(() => {
      simulateDelivery({
        conversationId: conversationId || `CONV-${Date.now()}`,
        ticketId: ticketId || null,
        customerId: customerId || null,
        itemType: 'PDF',
        itemName: `${documentType || 'PDF'}: ${fileName || 'document'}`,
        performedBy: req.user?.full_name || 'Staff',
      }).catch(e => console.error('Simulation event failed:', e.message));
    });

    res.status(201).json({ success: true, data: msgResult.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/messages/link - Send a link message (auth-protected)
router.post('/link', authenticate, async (req, res, next) => {
  try {
    const { conversationId, ticketId, customerId, sender, linkType, linkUrl, text, description } = req.body;
    const msg = await createLinkMessage({
      conversationId: conversationId || `CONV-${Date.now()}`,
      ticketId: ticketId || null,
      customerId: customerId || null,
      sender: 'Staff',
      linkType: linkType || 'tracking',
      linkUrl: linkUrl || '',
      text: text || '',
      description: description || '',
    });

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [msg.id]);

    // Simulation delivery event
    setImmediate(() => {
      simulateDelivery({
        conversationId: conversationId || `CONV-${Date.now()}`,
        ticketId: ticketId || null,
        customerId: customerId || null,
        itemType: 'Link',
        itemName: `${linkType || 'Link'}: ${text || 'link'}`,
        performedBy: req.user?.full_name || 'Staff',
      }).catch(e => console.error('Simulation event failed:', e.message));
    });

    res.status(201).json({ success: true, data: msgResult.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/messages/auto-status - Auto-create status change event (auth-protected)
router.post('/auto-status', authenticate, async (req, res, next) => {
  try {
    const { ticketId, oldStatus, newStatus, changedBy } = req.body;
    const msg = await createStatusEvent(ticketId, oldStatus, newStatus, changedBy || req.user?.full_name);
    if (!msg) return res.json({ success: true, data: null, message: 'No event mapped for this status' });

    await logAudit({
      action: actions.MESSAGE_SENT,
      ticketId,
      entityType: 'message',
      entityId: String(msg.id),
      performedBy: changedBy || req.user?.full_name || 'System',
      details: { oldStatus, newStatus },
    });

    // Simulation delivery event
    setImmediate(() => {
      simulateDelivery({
        conversationId: msg.conversation_id,
        ticketId,
        customerId: msg.customer_id,
        itemType: 'Status Update',
        itemName: `${newStatus}`,
        performedBy: changedBy || req.user?.full_name || 'System',
      }).catch(e => console.error('Simulation event failed:', e.message));
    });

    res.status(201).json({ success: true, data: msg });
  } catch (err) { next(err); }
});

module.exports = router;
