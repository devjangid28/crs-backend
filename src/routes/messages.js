const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const config = require('../config');
const {
  createTextMessage, createPdfMessage, createLinkMessage,
  createStatusEvent, storeIncomingMessage, getOrCreateConversation,
  markConversationRead, getConversationsWithDetails, getUnreadSummary,
  saveCustomerContact, updateMessageStatus, nowIST,
} = require('../services/messagingService');
const { sendTextMessage, sendMediaMessage, sendDocumentFile, sendMediaFile, sendPhotoSheet, isEnabled, getConversationIdFromPhone, sendInwardReceiptLink, sendServiceInvoiceTemplate, sendOrderInvoiceTemplate } = require('../services/whatsappService');
const { renderPhotoSheet, MAX_PHOTOS } = require('../services/photoSheetService');
const { generateInwardReceiptFromHTML, generateOrderPdfFromHTML, generateServiceInvoiceFromHTML } = require('../services/pdfGenerator');
const { generateOrderInvoicePdf } = require('../services/tallyOrderInvoicePdf');
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

    let convId = conversationId || getConversationIdFromPhone(phone);
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
          waError += waResult.details ? ' | Details: ' + JSON.stringify(waResult.details) : '';
          waError += waResult.code ? ' | Code: ' + waResult.code : '';
          console.error('WhatsApp send failed:', waError, JSON.stringify(waResult));
        }
      } catch (waErr) {
        waError = waErr.message;
        console.error('WhatsApp send exception:', waErr.message);
      }
    }

    const status = providerMessageId ? 'sent' : (isEnabled() ? 'failed' : 'sending');
    const finalConvId = convId || getConversationIdFromPhone(phone) || `CONV-${Date.now()}`;
    const msg = await createTextMessage({
      conversationId: finalConvId,
      ticketId: ticketId || null,
      customerId: customerId || null,
      sender: sender || req.user?.full_name || 'Staff',
      text: text || '',
      providerMessageId,
      phone,
      status,
    });

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [msg.id]);

    const io = req.app?.get('io') || req.io;

    // Emit message_status for failures so frontend can show error
    if (io && waError) {
      const failPayload = { conversationId: finalConvId, providerMessageId, status: 'failed', error: waError, messageId: msg.id };
      io.to('conv:' + finalConvId).emit('message_status', failPayload);
      io.emit('message_status', failPayload);
    }

    // Emit socket event for real-time updates (room + global)
    if (io) {
      io.to('conv:' + finalConvId).emit('new_message', { message: msgResult.rows[0], conversationId: finalConvId, waError: waError || undefined });
      io.emit('new_message', { message: msgResult.rows[0], conversationId: finalConvId, waError: waError || undefined });
    }

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
          conversationId: finalConvId,
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
    const { search, filter, store_id } = req.query;
    const conversations = await getConversationsWithDetails({ search, filter, storeId: store_id });

    const sorted = (conversations || []).sort((a, b) => {
      const da = new Date(a.last_message_at || 0);
      const db = new Date(b.last_message_at || 0);
      return db - da;
    });

    res.json({ success: true, data: sorted });
  } catch (err) { next(err); }
});

// GET /api/messages/unread-count - How many customer messages are still unread.
// Powers the Messaging badge on the web sidebar and the mobile home screen so a
// new message is noticed without opening the conversation list.
router.get('/unread-count', authenticate, async (req, res, next) => {
  try {
    const summary = await getUnreadSummary({ storeId: req.query.store_id });
    res.json({ success: true, data: summary });
  } catch (err) { next(err); }
});

// GET /api/messages/lookup-user - Find a registered user by phone (WhatsApp-style)
// Searches customers and staff users. If the number is registered, returns the
// profile so the UI can open a one-to-one conversation without saving a contact.
router.get('/lookup-user', authenticate, async (req, res, next) => {
  try {
    const raw = req.query.phone;
    if (!raw) {
      return res.json({ success: true, data: { registered: false, valid: false } });
    }
    const cleaned = String(raw).replace(/[^\d]/g, '').replace(/^0+/, '');
    let normalized = null;
    if (cleaned.length === 10) normalized = '91' + cleaned;
    else if (cleaned.length === 12 && cleaned.startsWith('91')) normalized = cleaned;
    if (!normalized) {
      return res.json({ success: true, data: { registered: false, valid: false } });
    }

    const likeShort = `%${cleaned}`;
    const likeFull = `%${normalized}`;

    const custRes = await query(
      `SELECT id, name, phone FROM customers WHERE phone IS NOT NULL AND (phone LIKE $1 OR phone LIKE $2) ORDER BY created_at DESC LIMIT 1`,
      [likeShort, likeFull]
    );
    if (custRes.rows.length > 0) {
      const c = custRes.rows[0];
      return res.json({
        success: true,
        data: {
          registered: true,
          valid: true,
          type: 'customer',
          name: c.name || 'Customer',
          phone: normalized,
          customerId: c.id,
          userId: null,
        },
      });
    }

    const userRes = await query(
      `SELECT id, full_name, mobile_number FROM users WHERE mobile_number IS NOT NULL AND (mobile_number LIKE $1 OR mobile_number LIKE $2) ORDER BY id LIMIT 1`,
      [likeShort, likeFull]
    );
    if (userRes.rows.length > 0) {
      const u = userRes.rows[0];
      return res.json({
        success: true,
        data: {
          registered: true,
          valid: true,
          type: 'user',
          name: u.full_name || 'User',
          phone: normalized,
          customerId: null,
          userId: u.id,
        },
      });
    }

    return res.json({ success: true, data: { registered: false, valid: true, phone: normalized } });
  } catch (err) { next(err); }
});

// POST /api/messages/pdf - Send a PDF message
router.post('/pdf', authenticate, async (req, res, next) => {
  try {
    let { conversationId, ticketId, customerId, sender, fileName, fileSize, documentType, event, phone } = req.body;
    phone = await resolvePhone(phone, ticketId);

    let convId = conversationId || getConversationIdFromPhone(phone);
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

    const finalConvId = convId || getConversationIdFromPhone(phone) || `CONV-${Date.now()}`;
    const msgStatus = pdfProviderMessageId ? 'sent' : (isEnabled() ? 'failed' : 'sending');
    const msg = await createPdfMessage({
      conversationId: finalConvId,
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

    // Emit socket event for real-time updates (room + global)
    const io = req.app?.get('io') || req.io;
    if (io) {
      io.to('conv:' + finalConvId).emit('new_message', { message: msgResult.rows[0], conversationId: finalConvId });
      io.emit('new_message', { message: msgResult.rows[0], conversationId: finalConvId });
    }

    // Simulation: mark as delivered + create simulated event
    if (!isEnabled()) {
      query('UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2', ['delivered', msg.id]).catch(e => console.error('Simulation status update failed:', e.message));
      setImmediate(() => {
        simulateDelivery({
          conversationId: finalConvId,
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

// POST /api/messages/send-document - Generate PDF and send via WhatsApp Document API
router.post('/send-document', authenticate, async (req, res, next) => {
  try {
    const { documentType, ticketId, orderId, customerId, phone } = req.body;
    if (!documentType || (!ticketId && !orderId)) {
      return res.status(400).json({
        success: false,
        message: 'documentType and either ticketId or orderId are required'
      });
    }

    // Resolve phone if needed
    let resolvedPhone = phone;
    if (!resolvedPhone && ticketId) {
      const tRes = await query('SELECT customer_phone FROM tickets WHERE id = $1', [ticketId]);
      if (tRes.rows.length > 0) resolvedPhone = tRes.rows[0].customer_phone;
    }
    if (!resolvedPhone && orderId) {
      const oRes = await query('SELECT mobile_number FROM orders WHERE id = $1', [orderId]);
      if (oRes.rows.length > 0) resolvedPhone = oRes.rows[0].mobile_number;
    }

    if (!resolvedPhone && isEnabled()) {
      return res.status(400).json({ success: false, message: 'Customer phone is required to send document' });
    }

    // Generate PDF
    let pdf;
    let entityId;
    let entityType;
    // Re-read the ticket after generation so the WhatsApp template carries the
    // same (latest) customer name / number / ticket id as the PDF we just built.
    let ticketRow = null;
    if (documentType === 'inward' && ticketId) {
      pdf = await generateInwardReceiptFromHTML(ticketId);
      entityId = ticketId;
      entityType = 'inward';

      // Keep inward_receipts in sync so download/preview lookups always succeed
      try {
        const tRes = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
        const t = tRes.rows[0];
        if (t) {
          ticketRow = t;
          await query(
            `INSERT INTO inward_receipts (ticket_id, receipt_number, customer_name, customer_phone, device_details, serial_number, problem_description, accessories_received, pdf_path, pdf_size)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (receipt_number) DO UPDATE SET pdf_path = $9, pdf_size = $10`,
            [ticketId, pdf.receiptNumber, t.customer_name, t.customer_phone,
             `${t.device_type || ''} ${t.brand || ''} ${t.model || ''}`.trim(),
             t.serial_number, t.problem_description, t.accessories,
             pdf.filePath, pdf.fileSize]
          );
        }
      } catch (syncErr) {
        console.error('Failed to sync inward_receipts row:', syncErr.message);
      }
    } else if (documentType === 'order' && orderId) {
      pdf = await generateOrderPdfFromHTML(orderId);
      entityId = orderId;
      entityType = 'order';
    } else if (documentType === 'service_invoice' && ticketId) {
      pdf = await generateServiceInvoiceFromHTML(ticketId);
      entityId = ticketId;
      entityType = 'service_invoice';

      // The service_invoice WhatsApp template needs the same ticket details as
      // the inward receipt, so load the row once and reuse it for the send.
      try {
        const tRes = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
        if (tRes.rows.length > 0) ticketRow = tRes.rows[0];
      } catch (tErr) {
        console.error('Failed to load ticket for service invoice send:', tErr.message);
      }
    } else if (documentType === 'invoice' && orderId) {
      // Send the exact ManageOrders (Tally-style) tax invoice for this order.
      pdf = await generateOrderInvoicePdf(orderId);
      entityId = orderId;
      entityType = 'order';
    } else {
      return res.status(400).json({ success: false, message: 'Invalid documentType/id combination' });
    }

    // Construct public URL for the PDF
    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`;
    let publicUrl;
    if (entityType === 'inward') {
      publicUrl = `${baseUrl}/api/pdf/download/inward/${entityId}`;
    } else if (entityType === 'service_invoice') {
      publicUrl = `${baseUrl}/api/pdf/download/service-invoice/${entityId}`;
    } else if (entityType === 'invoice') {
      publicUrl = `${baseUrl}/api/pdf/download/invoice/${entityId}`;
    } else {
      publicUrl = `${baseUrl}/api/pdf/download/order/${entityId}`;
    }

    // Build conversation ID using phone-based format for consistency
    let convId = getConversationIdFromPhone(resolvedPhone);
    if (!convId && ticketId) {
      const conv = await getOrCreateConversation(ticketId, customerId, resolvedPhone);
      if (conv) convId = conv.conversationId;
    }
    if (!convId) {
      convId = getConversationIdFromPhone(resolvedPhone) || `CONV-${Date.now()}`;
    }

    // Send to the customer.
    //
    // Free-form document messages are rejected by Meta ("Re-engagement message",
    // error 131047) whenever we are outside the 24-hour customer service window,
    // so a plain "Send Inward" tap could be accepted by the API and then silently
    // dropped. Documents that have an approved Meta template are therefore always
    // delivered through that template, with the freshly generated PDF as the
    // header attachment. This is the same path ticket creation already uses, which
    // is why the receipt reaches the customer there and not here.
    let providerMessageId = null;
    let waError = null;
    let deliveryRoute = null;
    if (isEnabled() && resolvedPhone) {
      try {
        const sendCtx = {
          conversationId: convId,
          ticketId: ticketId || null,
          orderId: orderId || null,
          customerId: customerId || null,
        };
        const caption = documentType === 'inward'
          ? `*Inward Receipt*\nYour service receipt is attached.`
          : documentType === 'service_invoice'
            ? `*Service Invoice*\nYour service invoice is attached.`
            : documentType === 'invoice'
              ? `*Invoice*\nYour invoice is attached.`
              : `*Order Form*\nYour order details are attached.`;

        let waResult;
        if (documentType === 'inward' && ticketRow) {
          waResult = await sendInwardReceiptLink(ticketRow, pdf.filePath);
          deliveryRoute = 'inward_receipt_template';
        } else if (documentType === 'service_invoice' && ticketRow) {
          waResult = await sendServiceInvoiceTemplate(ticketRow, pdf.filePath);
          deliveryRoute = 'service_invoice_template';
        } else if (documentType === 'invoice' && orderId) {
          const oRes = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
          if (oRes.rows.length > 0) {
            waResult = await sendOrderInvoiceTemplate(oRes.rows[0], pdf.filePath);
            deliveryRoute = 'order_invoice_template';
          }
        }

        if (!waResult) {
          // No template available for this document type (e.g. the order form),
          // so fall back to a free-form document send.
          waResult = await sendDocumentFile(resolvedPhone, pdf.filePath, caption, sendCtx);
          deliveryRoute = 'free_form_document';
        }

        if (waResult.success) {
          providerMessageId = waResult.messageId || null;
        } else if (!waResult.skipped) {
          waError = waResult.error || 'WhatsApp API returned unsuccessful';
          console.error('WhatsApp document send failed:', waError, JSON.stringify(waResult));
        }
      } catch (waErr) {
        waError = waErr.message;
        console.error('WhatsApp document send exception:', waErr.message);
      }
    }

    // Record the document send in the messages table so it appears in the chat
    const msgStatus = providerMessageId ? 'sent' : (isEnabled() ? 'failed' : 'sending');
    const msg = await createPdfMessage({
      conversationId: convId,
      ticketId: ticketId || null,
      orderId: orderId || null,
      customerId: customerId || null,
      sender: req.user?.full_name || 'Staff',
      fileName: pdf.fileName,
      fileSize: String(pdf.fileSize || ''),
      documentType: documentType === 'inward' ? 'Inward Receipt'
        : documentType === 'service_invoice' ? 'Service Invoice'
        : documentType === 'invoice' ? 'Invoice'
        : 'Order Form',
      event: documentType === 'inward' ? 'inward_receipt'
        : documentType === 'service_invoice' ? 'service_invoice_sent'
        : documentType === 'invoice' ? 'invoice_sent'
        : 'order_form',
      providerMessageId,
      phone: resolvedPhone,
      status: msgStatus,
    });

    if (waError) {
      await query('UPDATE messages SET error_message = $1 WHERE id = $2', [waError, msg.id]);
    }

    // Emit socket event for real-time updates (room + global)
    const io = req.app?.get('io') || req.io;
    if (io) {
      const msgResult = await query('SELECT * FROM messages WHERE id = $1', [msg.id]);
      io.to('conv:' + convId).emit('new_message', { message: msgResult.rows[0], conversationId: convId });
      io.emit('new_message', { message: msgResult.rows[0], conversationId: convId });
    }

    // Simulation for dev mode (no WhatsApp)
    if (!isEnabled() && msg) {
      query('UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2', ['delivered', msg.id]).catch(e => console.error('Simulation status update failed:', e.message));
      setImmediate(() => {
        simulateDelivery({
          conversationId: convId,
          ticketId: ticketId || null,
          customerId: customerId || null,
          itemType: 'PDF',
          itemName: `${documentType}: ${pdf.fileName}`,
          performedBy: req.user?.full_name || 'Staff',
        }).catch(e => console.error('Simulation event failed:', e.message));
      });
    }

    // Log audit
    await logAudit({
      action: actions.MESSAGE_SENT,
      ticketId: ticketId || null,
      entityType: 'document',
      entityId: pdf.fileName || 'unknown',
      performedBy: req.user?.full_name || 'Staff',
      details: {
        documentType,
        fileName: pdf.fileName,
        fileSize: pdf.fileSize,
        sent: !!providerMessageId,
        deliveryRoute,
        waError: waError || null,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        fileName: pdf.fileName,
        fileSize: pdf.fileSize,
        downloadUrl: publicUrl,
        providerMessageId,
        messageId: msg.id,
        // How the PDF actually reached (or failed to reach) the customer, so the
        // caller can tell the user the truth instead of assuming it was sent.
        delivered: !!providerMessageId || !isEnabled(),
        deliveryRoute,
        waError: waError || undefined,
      },
      waError: waError || undefined,
    });
  } catch (err) { next(err); }
});

// POST /api/messages/link - Send a link message
router.post('/link', authenticate, async (req, res, next) => {
  try {
    let { conversationId, ticketId, customerId, sender, linkType, linkUrl, text, description, phone } = req.body;
    phone = await resolvePhone(phone, ticketId);

    let convId = conversationId || getConversationIdFromPhone(phone);
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

    const finalConvId = convId || getConversationIdFromPhone(phone) || `CONV-${Date.now()}`;
    const msgStatus = linkProviderMessageId ? 'sent' : (isEnabled() ? 'failed' : 'sending');
    const msg = await createLinkMessage({
      conversationId: finalConvId,
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

    // Emit socket event for real-time updates (room + global)
    const io = req.app?.get('io') || req.io;
    if (io) {
      io.to('conv:' + finalConvId).emit('new_message', { message: msgResult.rows[0], conversationId: finalConvId });
      io.emit('new_message', { message: msgResult.rows[0], conversationId: finalConvId });
    }

    // Simulation: mark as delivered + create simulated event
    if (!isEnabled()) {
      query('UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2', ['delivered', msg.id]).catch(e => console.error('Simulation status update failed:', e.message));
      setImmediate(() => {
        simulateDelivery({
          conversationId: finalConvId,
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
    // Emit socket event to update unread counts (room + global)
    const io = req.app?.get('io') || req.io;
    if (io) {
      io.to('conv:' + conversationId).emit('conversation_read', { conversationId, markedRead: count });
      io.emit('conversation_read', { conversationId, markedRead: count });
    }
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
    let { conversationId, ticketId, customerId, sender, fileName, fileData, fileType, phone, caption } = req.body;
    if (!fileData) {
      return res.status(400).json({ success: false, message: 'fileData is required' });
    }
    phone = await resolvePhone(phone, ticketId);

    const ext = path.extname(fileName) || '.bin';
    const safeName = Date.now() + '_' + fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(UPLOAD_DIR, safeName);

    const buffer = Buffer.from(fileData, 'base64');
    fs.writeFileSync(filePath, buffer);

    const stats = fs.statSync(filePath);

    let convId = conversationId || getConversationIdFromPhone(phone);
    if (!convId && ticketId) {
      const conv = await getOrCreateConversation(ticketId, customerId, phone);
      if (conv) convId = conv.conversationId;
    }

    const msgType = fileType?.startsWith('image/') ? 'image' : 'file';
    const finalConvId = convId || getConversationIdFromPhone(phone) || `CONV-${Date.now()}`;

    // Send via WhatsApp media API when a phone is available
    let providerMessageId = null;
    let waError = null;
    if (isEnabled() && phone) {
      try {
        const mimeType = fileType || 'application/octet-stream';
        const waResult = await sendMediaFile(phone, filePath, mimeType, caption || '', {
          conversationId: finalConvId,
          ticketId: ticketId || null,
          orderId: null,
          customerId: customerId || null,
          sender: sender || req.user?.full_name || 'Staff',
        });
        if (waResult.success) {
          providerMessageId = waResult.messageId || null;
        } else if (!waResult.skipped) {
          waError = waResult.error || 'WhatsApp API returned unsuccessful';
          waError += waResult.details ? ' | Details: ' + JSON.stringify(waResult.details) : '';
          waError += waResult.code ? ' | Code: ' + waResult.code : '';
          console.error('WhatsApp media send failed:', waError, JSON.stringify(waResult));
        }
      } catch (waErr) {
        waError = waErr.message;
        console.error('WhatsApp media send exception:', waErr.message);
      }
    }

    const status = providerMessageId ? 'sent' : (isEnabled() ? 'failed' : 'sending');
    const now = nowIST();
    const result = await query(
      `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, file_name, file_size, document_type, text, status, error_message, phone, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [finalConvId, sender || req.user?.full_name || 'Staff', customerId, ticketId,
       msgType, fileName, String(stats.size), fileType || 'document', caption || `Sent ${fileType || 'file'}: ${fileName}`,
       status, waError || null, phone, now]
    );

    const msgResult = await query('SELECT * FROM messages WHERE id = $1', [result.rows[0].id]);

    // Emit socket event for real-time updates (room + global)
    const io = req.app?.get('io') || req.io;
    if (io) {
      if (waError) {
        const failPayload = { conversationId: finalConvId, providerMessageId, status: 'failed', error: waError, messageId: msgResult.rows[0].id };
        io.to('conv:' + finalConvId).emit('message_status', failPayload);
        io.emit('message_status', failPayload);
      }
      io.to('conv:' + finalConvId).emit('new_message', { message: msgResult.rows[0], conversationId: finalConvId, waError: waError || undefined });
      io.emit('new_message', { message: msgResult.rows[0], conversationId: finalConvId, waError: waError || undefined });
    }

    // Simulation: mark as delivered + create simulated event
    if (!isEnabled()) {
      query('UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2', ['delivered', msgResult.rows[0].id]).catch(e => console.error('Simulation status update failed:', e.message));
      setImmediate(() => {
        simulateDelivery({
          conversationId: finalConvId,
          ticketId: ticketId || null,
          customerId: customerId || null,
          itemType: msgType === 'image' ? 'Image' : 'File',
          itemName: fileName,
          performedBy: sender || req.user?.full_name || 'Staff',
        }).catch(e => console.error('Simulation event failed:', e.message));
      });
    }

    res.status(201).json({
      success: true,
      data: {
        ...msgResult.rows[0],
        downloadUrl: `/api/messages/download/${msgResult.rows[0].id}`,
        // Whether the customer actually received it. Images cannot be delivered
        // by Meta outside the 24h window without an approved image template, so
        // this is what the UI must use to decide between "sent" and a warning.
        delivered: !!providerMessageId || !isEnabled(),
      },
      providerMessageId,
      waError: waError || undefined,
    });
  } catch (err) { next(err); }
});

// The sheet header shows the report date the way the rest of the app formats
// dates on customer-facing documents (DD-MM-YYYY, IST).
function formatSheetDate(d = new Date()) {
  const ist = new Date(d.getTime() + (330 * 60 * 1000));
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = ist.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// POST /api/messages/upload-photo-sheet
//
// Merges several repair photos into ONE labelled grid image and delivers it as a
// single WhatsApp message via the approved photo-sheet template. The template is
// what allows delivery outside the 24-hour customer service window, so the
// customer never has to message the business first.
//
// Body: { images: [{ fileName, fileData, fileType, label? }], ticketId,
//         conversationId, customerId, sender, phone, caption,
//         meta: { customer, device, ticket, date } }
router.post('/upload-photo-sheet', authenticate, async (req, res, next) => {
  let sheetFilePath = null;
  const stagedFiles = [];
  try {
    const {
      conversationId, ticketId, customerId, sender, phone, caption,
      meta: metaOverride, images,
    } = req.body;

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, message: 'images array is required' });
    }

    const resolvedPhone = await resolvePhone(phone, ticketId);

    // Persist the originals first so the sheet can be rendered from disk and so
    // staff can still open each individual photo later via /sheet-photo/:id/:i.
    const savedPhotos = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img || !img.fileData) continue;
      const originalName = img.fileName || `photo_${i + 1}.jpg`;
      const ext = (path.extname(originalName) || '.jpg').toLowerCase();
      const tempName = `sheet_src_${Date.now()}_${i}${ext.replace(/[^a-z0-9.]/g, '')}`;
      const tempPath = path.join(UPLOAD_DIR, tempName);
      fs.writeFileSync(tempPath, Buffer.from(img.fileData, 'base64'));
      stagedFiles.push(tempPath);
      savedPhotos.push({
        label: img.label || null,
        // Keyed as `path` because that is the field photoSheetService reads.
        path: tempPath,
        originalName,
      });
    }

    if (savedPhotos.length === 0) {
      return res.status(400).json({ success: false, message: 'No image data could be read' });
    }

    // Prefer ticket data for the template variables so the sheet always matches
    // the job, and only fall back to whatever the client supplied.
    let meta = {
      customer: metaOverride?.customer || '',
      device: metaOverride?.device || '',
      ticket: metaOverride?.ticket || '',
      date: metaOverride?.date || formatSheetDate(),
    };

    if (ticketId) {
      try {
        const t = await query(
          `SELECT ticket_id, customer_name, device_type, brand, model
           FROM tickets WHERE id = $1 LIMIT 1`,
          [ticketId]
        );
        if (t.rows.length > 0) {
          const row = t.rows[0];
          const device = [row.brand, row.model].filter(Boolean).join(' ').trim()
            || row.device_type || '';
          meta = {
            customer: meta.customer || row.customer_name || '',
            device: meta.device || device,
            ticket: meta.ticket || row.ticket_id || String(ticketId),
            date: formatSheetDate(),
          };
        }
      } catch (e) {
        // A missing ticket row must not block the send; the client values stand.
        console.error('Photo sheet ticket lookup failed:', e.message);
      }
    }

    if (!meta.ticket) meta.ticket = ticketId ? String(ticketId) : '';

    const sheet = await renderPhotoSheet({
      photos: savedPhotos,
      meta,
      outDir: UPLOAD_DIR,
    });
    sheetFilePath = sheet.filePath;

    let convId = conversationId || getConversationIdFromPhone(resolvedPhone);
    if (!convId && ticketId) {
      const conv = await getOrCreateConversation(ticketId, customerId, resolvedPhone);
      if (conv) convId = conv.conversationId;
    }
    const finalConvId = convId || getConversationIdFromPhone(resolvedPhone) || `CONV-${Date.now()}`;

    // Deliver before inserting so the row can be written with its real status.
    // sendPhotoSheet routes through the approved photo-sheet template whenever
    // the 24h window is closed, which is what lets the customer receive this
    // without messaging the business first.
    let providerMessageId = null;
    let waError = null;
    let waVia = null;
    let waWithinWindow = null;

    if (isEnabled() && resolvedPhone) {
      try {
        const waResult = await sendPhotoSheet(
          resolvedPhone,
          sheet.filePath,
          meta,
          {
            conversationId: finalConvId,
            ticketId: ticketId || null,
            orderId: null,
            customerId: customerId || null,
            sender: sender || req.user?.full_name || 'Staff',
            caption: caption || '',
          }
        );
        if (waResult.success) {
          providerMessageId = waResult.messageId || null;
          waVia = waResult.via || null;
          waWithinWindow = waResult.withinWindow ?? null;
        } else if (!waResult.skipped) {
          waError = waResult.error || 'WhatsApp API returned unsuccessful';
          if (waResult.code) waError += ' | Code: ' + waResult.code;
          if (waResult.details) waError += ' | Details: ' + JSON.stringify(waResult.details);
          console.error('Photo sheet WhatsApp send failed:', waError);
        }
      } catch (waErr) {
        waError = waErr.message;
        console.error('Photo sheet WhatsApp send exception:', waErr.message);
      }
    }

    // One row for the sheet the customer receives. document_type carries the
    // photo count so the UI can rebuild the per-photo gallery without a new
    // column or table.
    const status = providerMessageId ? 'sent' : (isEnabled() ? 'failed' : 'sending');
    const insert = await query(
      `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, file_name, file_size, document_type, text, status, error_message, phone, created_at)
       VALUES ($1, $2, $3, $4, 'image', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [finalConvId, sender || req.user?.full_name || 'Staff', customerId, ticketId || null,
       sheet.fileName, String(sheet.size), `photo_sheet:${sheet.usedCount}`,
       caption || `Photo sheet: ${sheet.usedCount} photo${sheet.usedCount > 1 ? 's' : ''} of ${meta.device || 'device'}`,
       status, waError || null, resolvedPhone, nowIST()]
    );
    const messageId = insert.rows[0].id;

    // Rename the originals to be addressable by this message id.
    savedPhotos.slice(0, sheet.usedCount).forEach((p, i) => {
      try {
        fs.renameSync(p.path, path.join(UPLOAD_DIR, `${messageId}_${i}.jpg`));
      } catch (e) {
        console.error(`Photo sheet part ${i} rename failed:`, e.message);
      }
    });
    // Anything beyond the cap is not shown, so do not leave it behind.
    savedPhotos.slice(sheet.usedCount).forEach((p) => {
      try { fs.unlinkSync(p.path); } catch (e) { /* best effort */ }
    });

    const sheetRow = await query('SELECT * FROM messages WHERE id = $1', [messageId]);

    const io = req.app?.get('io') || req.io;
    if (io) {
      const payload = {
        message: sheetRow.rows[0],
        conversationId: finalConvId,
        photoCount: sheet.usedCount,
        waError: waError || undefined,
      };
      if (waError) {
        const failPayload = { ...payload, status: 'failed', error: waError };
        io.to('conv:' + finalConvId).emit('message_status', failPayload);
        io.emit('message_status', failPayload);
      }
      io.to('conv:' + finalConvId).emit('new_message', payload);
      io.emit('new_message', payload);
    }

    res.status(201).json({
      success: true,
      data: {
        ...sheetRow.rows[0],
        downloadUrl: `/api/messages/download/${messageId}`,
        delivered: !!providerMessageId || !isEnabled(),
      },
      photoCount: sheet.usedCount,
      photos: Array.from({ length: sheet.usedCount }, (_, i) => ({
        index: i,
        url: `/api/messages/sheet-photo/${messageId}/${i}`,
      })),
      // Surfaced so the caller is never surprised that a selection was trimmed.
      droppedCount: sheet.droppedCount,
      maxPhotos: MAX_PHOTOS,
      template: config.whatsapp.templatePhotoSheet,
      via: waVia || null,
      withinWindow: waWithinWindow ?? null,
      providerMessageId,
      waError: waError || undefined,
    });
  } catch (err) {
    console.error('Photo sheet send failed:', err.stack || err.message);
    if (err.code === 'NO_PHOTOS') {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  } finally {
    // The merged sheet is disposable once it has been handed to WhatsApp.
    if (sheetFilePath) {
      try { fs.unlinkSync(sheetFilePath); } catch (e) { /* best effort */ }
    }
    // Staged originals that were not renamed into place are cleaned up; the ones
    // that were renamed no longer exist under their temp name, so this is a
    // no-op for them and the per-photo parts survive for the gallery route.
    stagedFiles.forEach((f) => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* best effort */ }
    });
  }
});

// GET /api/messages/sheet-photo/:messageId/:index
// Serves one original photo that was merged into a sheet, so the UI can offer a
// full-size per-photo viewer. Unauthenticated to match /download/:id, which the
// frontends already load through a plain <img src>.
router.get('/sheet-photo/:messageId/:index', async (req, res, next) => {
  try {
    const messageId = parseInt(req.params.messageId, 10);
    const index = parseInt(req.params.index, 10);
    if (!messageId || Number.isNaN(index) || index < 0) {
      return res.status(400).json({ success: false, message: 'Invalid message id or photo index' });
    }

    const result = await query('SELECT document_type FROM messages WHERE id = $1', [messageId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }
    // Only sheet messages keep per-photo parts on disk.
    if (!String(result.rows[0].document_type || '').startsWith('photo_sheet:')) {
      return res.status(404).json({ success: false, message: 'Message has no photo sheet parts' });
    }

    const filePath = path.join(UPLOAD_DIR, `${messageId}_${index}.jpg`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Photo not found' });
    }
    res.sendFile(filePath);
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
    if (!msg.file_name) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }
    let filePath = path.join(UPLOAD_DIR, msg.file_name);
    if (!fs.existsSync(filePath)) {
      // Uploaded files are stored with a Date.now()_ prefix; locate the actual
      // file on disk by matching the stored name as a suffix of a file in the dir.
      const matches = fs.readdirSync(UPLOAD_DIR)
        .filter((f) => f.endsWith(msg.file_name) && fs.statSync(path.join(UPLOAD_DIR, f)).isFile())
        .sort((a, b) => fs.statSync(path.join(UPLOAD_DIR, b)).mtimeMs - fs.statSync(path.join(UPLOAD_DIR, a)).mtimeMs);
      if (matches.length === 0) {
        return res.status(404).json({ success: false, message: 'File not found' });
      }
      filePath = path.join(UPLOAD_DIR, matches[0]);
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