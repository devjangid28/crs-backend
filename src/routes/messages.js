const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const {
  createTextMessage, createPdfMessage, createLinkMessage,
  createStatusEvent, storeIncomingMessage, getOrCreateConversation,
  markConversationRead, getConversationsWithDetails,
  saveCustomerContact, updateMessageStatus,
} = require('../services/messagingService');
const { sendTextMessage, isEnabled } = require('../services/whatsappService');
const { logAudit, actions } = require('../services/auditService');
const { authenticate } = require('../middleware/auth');
const { simulateDelivery } = require('../services/simulationService');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '../../uploads/chat');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// GET /api/messages - Get messages by conversation_id
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

async function resolvePhone(phone, ticketId) {
  if (phone) return phone;
  if (!ticketId) return null;
  try {
    const tRes = await query('SELECT customer_phone FROM tickets WHERE id = $1', [ticketId]);
    if (tRes.rows.length > 0 && tRes.rows[0].customer_phone) {
      return tRes.rows[0].customer_phone;
    }
  } catch {}
  return null;
}

// POST /api/messages - Send a text message
router.post('/', authenticate, async (req, res, next) => {
  try {
    let { conversationId, ticketId, customerId, sender, text, phone } = req.body;
    phone = await resolvePhone(phone, ticketId);

    let convId = conversationId;
    if (!convId && ticketId) {
      const conv = await getOrCreateConversation(ticketId, customerId, phone);
      if (conv) convId = conv.conversationId;
    }

    let providerMessageId = null;
    let waError = null;
    if (isEnabled() && phone) {
      try {
        const waResult = await sendTextMessage(phone, text, {
          conversationId: convId,
          ticketId,
          customerId,
          sender: sender || req.user?.full_name || 'Staff',
        }, { skipSave: true });
        if (waResult.success) {
          providerMessageId = waResult.messageId;
        } else {
          waError = waResult.error || 'WhatsApp API returned unsuccessful';
          console.error('WhatsApp send failed:', waError, JSON.stringify(waResult));
        }
      } catch (waErr) {
        waError = waErr.message;
        console.error('WhatsApp send exception:', waErr.message);
      }
    }

    const status = providerMessageId ? 'sent' : (isEnabled() ? 'failed' : 'sending');
    const msg = await createTextMessage({
      conversationId: convId || `CONV-${Date.now()}`,
      ticketId: ticketId || null,
      customerId: customerId || null,
      sender: sender || req.user?.full_name || 'Staff',
      text: text || '',
      providerMessageId,
      phone,
      status,
    });

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [msg.id]);

    await logAudit({
      action: actions.MESSAGE_SENT,
      ticketId,
      entityType: 'message',
      entityId: String(msg.id),
      performedBy: req.user?.full_name || 'Staff',
    });

    // Simulation: mark as delivered + create simulated event
    if (!isEnabled()) {
      query('UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2', ['delivered', msg.id]).catch(e => console.error('Simulation status update failed:', e.message));
      setImmediate(() => {
        simulateDelivery({
          conversationId: convId || `CONV-${Date.now()}`,
          ticketId: ticketId || null,
          customerId: customerId || null,
          itemType: 'Text Message',
          itemName: 'Message',
          performedBy: req.user?.full_name || 'Staff',
        }).catch(e => console.error('Simulation event failed:', e.message));
      });
    }

    res.status(201).json({
      success: true,
      data: msgResult.rows[0],
      waError: waError || undefined,
    });
  } catch (err) { next(err); }
});

// GET /api/messages/conversations - List all conversations
router.get('/conversations', authenticate, async (req, res, next) => {
  try {
    const { search, filter } = req.query;
    const conversations = await getConversationsWithDetails({ search, filter });

    const sorted = (conversations || []).sort((a, b) => {
      const da = new Date(a.last_message_at || 0);
      const db = new Date(b.last_message_at || 0);
      return db - da;
    });

    res.json({ success: true, data: sorted });
  } catch (err) { next(err); }
});

// POST /api/messages/pdf - Send a PDF message
router.post('/pdf', authenticate, async (req, res, next) => {
  try {
    let { conversationId, ticketId, customerId, sender, fileName, fileSize, documentType, event, phone } = req.body;
    phone = await resolvePhone(phone, ticketId);

    let convId = conversationId;
    if (!convId && ticketId) {
      const conv = await getOrCreateConversation(ticketId, customerId, phone);
      if (conv) convId = conv.conversationId;
    }

    // Send WhatsApp notification with link if phone provided
    let pdfProviderMessageId = null;
    let waError = null;
    if (isEnabled() && phone) {
      try {
        const waText = `*${documentType || 'Document'}*\n\n${fileName || 'document'}\n\nPlease check your CRS portal for details.`;
        const waResult = await sendTextMessage(phone, waText, { conversationId: convId, ticketId, customerId, sender: sender || 'Staff' }, { skipSave: true });
        if (waResult.success) {
          pdfProviderMessageId = waResult.messageId;
        } else {
          waError = waResult.error || 'WhatsApp API returned unsuccessful';
          console.error('WhatsApp PDF notification failed:', waError, JSON.stringify(waResult));
        }
      } catch (waErr) {
        waError = waErr.message;
        console.error('WhatsApp PDF notification exception:', waErr.message);
      }
    }

    const msgStatus = pdfProviderMessageId ? 'sent' : (isEnabled() ? 'failed' : 'sending');
    const msg = await createPdfMessage({
      conversationId: convId || `CONV-${Date.now()}`,
      ticketId: ticketId || null,
      customerId: customerId || null,
      sender: sender || 'Staff',
      fileName: fileName || 'document.pdf',
      fileSize: fileSize || '0',
      documentType: documentType || 'PDF',
      event: event || '',
      providerMessageId: pdfProviderMessageId,
      phone,
      status: msgStatus,
    });

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [msg.id]);

    // Simulation: mark as delivered + create simulated event
    if (!isEnabled()) {
      query('UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2', ['delivered', msg.id]).catch(e => console.error('Simulation status update failed:', e.message));
      setImmediate(() => {
        simulateDelivery({
          conversationId: convId || `CONV-${Date.now()}`,
          ticketId: ticketId || null,
          customerId: customerId || null,
          itemType: 'PDF',
          itemName: `${documentType || 'PDF'}: ${fileName || 'document'}`,
          performedBy: req.user?.full_name || 'Staff',
        }).catch(e => console.error('Simulation event failed:', e.message));
      });
    }

    res.status(201).json({
      success: true,
      data: msgResult.rows[0],
      waError: waError || undefined,
    });
  } catch (err) { next(err); }
});

// POST /api/messages/link - Send a link message
router.post('/link', authenticate, async (req, res, next) => {
  try {
    let { conversationId, ticketId, customerId, sender, linkType, linkUrl, text, description, phone } = req.body;
    phone = await resolvePhone(phone, ticketId);

    let convId = conversationId;
    if (!convId && ticketId) {
      const conv = await getOrCreateConversation(ticketId, customerId, phone);
      if (conv) convId = conv.conversationId;
    }

    // Send WhatsApp message with link if phone provided
    let linkProviderMessageId = null;
    let waError = null;
    if (isEnabled() && phone) {
      try {
        const linkText = `*${text || linkType || 'Link'}*\n${description || ''}\n\n${linkUrl || ''}`;
        const waResult = await sendTextMessage(phone, linkText, { conversationId: convId, ticketId, customerId, sender: sender || 'Staff' }, { skipSave: true });
        if (waResult.success) {
          linkProviderMessageId = waResult.messageId;
        } else {
          waError = waResult.error || 'WhatsApp API returned unsuccessful';
          console.error('WhatsApp link send failed:', waError, JSON.stringify(waResult));
        }
      } catch (waErr) {
        waError = waErr.message;
        console.error('WhatsApp link send exception:', waErr.message);
      }
    }

    const msgStatus = linkProviderMessageId ? 'sent' : (isEnabled() ? 'failed' : 'sending');
    const msg = await createLinkMessage({
      conversationId: convId || `CONV-${Date.now()}`,
      ticketId: ticketId || null,
      customerId: customerId || null,
      sender: sender || 'Staff',
      linkType: linkType || 'tracking',
      linkUrl: linkUrl || '',
      text: text || '',
      description: description || '',
      providerMessageId: linkProviderMessageId,
      phone,
      status: msgStatus,
    });

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [msg.id]);

    // Simulation: mark as delivered + create simulated event
    if (!isEnabled()) {
      query('UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2', ['delivered', msg.id]).catch(e => console.error('Simulation status update failed:', e.message));
      setImmediate(() => {
        simulateDelivery({
          conversationId: convId || `CONV-${Date.now()}`,
          ticketId: ticketId || null,
          customerId: customerId || null,
          itemType: 'Link',
          itemName: `${linkType || 'Link'}: ${text || 'link'}`,
          performedBy: req.user?.full_name || 'Staff',
        }).catch(e => console.error('Simulation event failed:', e.message));
      });
    }

    res.status(201).json({
      success: true,
      data: msgResult.rows[0],
      waError: waError || undefined,
    });
  } catch (err) { next(err); }
});

// POST /api/messages/read - Mark conversation as read
router.post('/read', authenticate, async (req, res, next) => {
  try {
    const { conversationId } = req.body;
    if (!conversationId) {
      return res.status(400).json({ success: false, message: 'conversationId is required' });
    }
    const count = await markConversationRead(conversationId);
    res.json({ success: true, data: { markedRead: count } });
  } catch (err) { next(err); }
});

// POST /api/messages/save-contact - Save/update customer contact
router.post('/save-contact', authenticate, async (req, res, next) => {
  try {
    let { customerId, name, phone } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const result = await saveCustomerContact(customerId, name, phone);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// POST /api/messages/upload - Upload file attachment
router.post('/upload', authenticate, async (req, res, next) => {
  try {
    const { conversationId, ticketId, customerId, fileName, fileData, fileType, phone } = req.body;
    if (!fileData) {
      return res.status(400).json({ success: false, message: 'fileData is required' });
    }

    const ext = path.extname(fileName) || '.bin';
    const safeName = Date.now() + '_' + fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(UPLOAD_DIR, safeName);

    const buffer = Buffer.from(fileData, 'base64');
    fs.writeFileSync(filePath, buffer);

    const stats = fs.statSync(filePath);

    let convId = conversationId;
    if (!convId && ticketId) {
      const conv = await getOrCreateConversation(ticketId, customerId, phone);
      if (conv) convId = conv.conversationId;
    }

    const msgType = fileType?.startsWith('image/') ? 'image' : 'file';

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await query(
      `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, file_name, file_size, document_type, text, status, phone, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'sent', $10, $11) RETURNING id`,
      [convId || `CONV-${Date.now()}`, req.user?.full_name || 'Staff', customerId, ticketId,
       msgType, fileName, String(stats.size), fileType || 'document', `Sent ${fileType || 'file'}: ${fileName}`,
       phone, now]
    );

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [result.rows[0].id]);

    res.status(201).json({
      success: true,
      data: {
        ...msgResult.rows[0],
        downloadUrl: `/api/messages/download/${result.rows[0].id}`,
      }
    });
  } catch (err) { next(err); }
});

// GET /api/messages/download/:id - Download uploaded file
router.get('/download/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM messages WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    const msg = result.rows[0];
    const filePath = path.join(UPLOAD_DIR, msg.file_name);
    if (!msg.file_name || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }
    res.download(filePath, msg.file_name);
  } catch (err) { next(err); }
});

// POST /api/messages/auto-status - Auto-create status change event
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

    res.status(201).json({ success: true, data: msg });
  } catch (err) { next(err); }
});

module.exports = router;