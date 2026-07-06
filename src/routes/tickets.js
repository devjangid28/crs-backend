const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/database');

async function getStoreInfo(storeId) {
  if (storeId) {
    const sRes = await query('SELECT * FROM stores WHERE id = $1 AND is_active = true', [storeId]);
    if (sRes.rows.length > 0) return sRes.rows[0];
  }
  const dRes = await query('SELECT * FROM stores WHERE is_default = true AND is_active = true LIMIT 1');
  if (dRes.rows.length > 0) return dRes.rows[0];
  const fRes = await query('SELECT * FROM store_settings LIMIT 1');
  return fRes.rows[0] || {};
}
const { generateTicketId, peekNextTicketId } = require('../services/ticketIdGenerator');
const { recordStatusChange, getStatusHistory } = require('../services/statusHistoryService');
const { validateTicket } = require('../middleware/validation');
const { generateInwardReceiptFromHTML } = require('../services/pdfGenerator');
const { createPdfMessage, createStatusEvent, getOrCreateConversation } = require('../services/messagingService');
const { notifyTicketCreated, sendTicketStatusTemplate, sendTextMessage, sendDocumentFile, getConversationIdFromPhone } = require('../services/whatsappService');

// GET /api/tickets - Get all tickets with search & filter
router.get('/', async (req, res, next) => {
  try {
    const { search, status, priority, page = 1, limit = 50 } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (search) {
      whereClause += ` AND (customer_name ILIKE ? OR customer_phone ILIKE ? OR customer_email ILIKE ? OR brand ILIKE ? OR model ILIKE ? OR issue_category ILIKE ? OR ticket_id ILIKE ?)`;
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam, searchParam, searchParam, searchParam, searchParam);
    }

    if (status) {
      if (status === 'open') {
        whereClause += ` AND status NOT IN ('Completed', 'Delivered', 'Cancelled')`;
      } else if (status === 'closed') {
        whereClause += ` AND status IN ('Completed', 'Delivered', 'Cancelled')`;
      } else {
        whereClause += ` AND status = ?`;
        params.push(status);
      }
    }

    if (priority) {
      whereClause += ` AND priority = ?`;
      params.push(priority);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const dataSql = `SELECT * FROM tickets ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) as total FROM tickets ${whereClause}`;
    const dataParams = [...params, parseInt(limit), offset];

    const [ticketsResult, countResult] = await Promise.all([
      query(dataSql, dataParams),
      query(countSql, params),
    ]);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    res.json({
      success: true,
      data: ticketsResult.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/next-id - Preview next ticket ID (without advancing sequence)
router.get('/next-id', async (req, res, next) => {
  try {
    const ticketId = await peekNextTicketId();
    res.json({ success: true, data: { ticketId } });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:id - Get single ticket
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const ticket = result.rows[0];
    ticket.statusHistory = await getStatusHistory(req.params.id);
    res.json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets - Create ticket
router.post('/', validateTicket, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const ticketId = await generateTicketId(client);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const {
      customerId, customerName,
      primaryPhone, customerPhone,
      email, customerEmail, serviceAddress,
      addressLine2, city, state, postcode, pincode, country,
      deviceType, brand, model, serialNumber, serialIMEI, imei, macAddress, password,
      issueCategory, customIssueCategory, problemDescription, issue,
      secondaryName, secondaryPhone, secondaryEmail,
      accessories, bodyDamage, body_damage, dataBackup, data_backup,
      estimatedCost, estimatedPrice, advancePayment, priority, location, warranty, company,
      storeId,
      status = 'New'
    } = req.body;

    const phone = primaryPhone || customerPhone;
    const emailAddr = email || customerEmail;
    const problemDesc = problemDescription || issue;
    const postCode = postcode || pincode;

    // Resolve store_id: prefer provided storeId, then default store, then first active store
    let resolvedStoreId = storeId || null;
    if (!resolvedStoreId) {
      const defStore = await client.query('SELECT id FROM stores WHERE is_default = true AND is_active = true LIMIT 1');
      if (defStore.rows.length > 0) {
        resolvedStoreId = defStore.rows[0].id;
      } else {
        const firstStore = await client.query('SELECT id FROM stores WHERE is_active = true ORDER BY id ASC LIMIT 1');
        if (firstStore.rows.length > 0) resolvedStoreId = firstStore.rows[0].id;
      }
    }

    const fields = {
      ticket_id: ticketId, customer_id: customerId || null,
      customer_name: customerName, customer_phone: phone,
      customer_email: emailAddr, service_address: serviceAddress || '',
      address_line2: addressLine2 || null, city: city || null,
      state: state || null, postcode: postCode || null, country: country || 'India',
      device_type: deviceType || null, brand: brand || null, model: model || null,
      serial_number: serialNumber || null, serial_imei: serialIMEI || null,
      imei: imei || null, mac_address: macAddress || null, device_password: password || null,
      issue_category: issueCategory, custom_issue_category: customIssueCategory || null,
      problem_description: problemDesc,
      secondary_name: secondaryName || null, secondary_phone: secondaryPhone || null,
      secondary_email: secondaryEmail || null,
      accessories: accessories || null,
      body_damage: bodyDamage || body_damage || 'No', data_backup: dataBackup || data_backup || 'No',
      estimated_cost: estimatedCost || 0, estimated_price: estimatedPrice || 0, advance_payment: advancePayment || 0,
      priority: priority || 'Medium', asset_location: location || 'In Shop',
      warranty: warranty ? true : false, company: company || null,
      store_id: resolvedStoreId,
      status, created_at: now, updated_at: now
    };

    const keys = Object.keys(fields);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map(k => fields[k]);

    const insertResult = await client.query(
      `INSERT INTO tickets (${keys.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      values
    );

    const insertId = insertResult.rows[0].id;

    await recordStatusChange(insertId, null, status, 'System', client, ticketId);

    await client.query('COMMIT');

    const newTicket = await client.query('SELECT * FROM tickets WHERE id = $1', [insertId]);

    // Auto-create conversation and send WhatsApp notification (fire-and-forget)
    const custConvId = getConversationIdFromPhone(phone);
    setImmediate(async () => {
      try {
        await getOrCreateConversation(insertId, customerId || null, phone);
      } catch (e) {
        console.error('Auto-create conversation failed:', e.message);
      }
      // Send template message first
      try {
        const store = await getStoreInfo(newTicket.rows[0]?.store_id);
        const waResult = await notifyTicketCreated(newTicket.rows[0], store);
        if (!waResult?.template?.success) {
          const errMsg = waResult?.template?.error || waResult?.template?.reason || 'Unknown error';
          console.error('WhatsApp template send failed:', errMsg, JSON.stringify(waResult));
          // Fallback: send a plain text message if template fails
          if (phone) {
            const ticketData = newTicket.rows[0];
            const fallbackText = `*Ticket Created*\n\nCustomer: ${ticketData.customer_name || 'N/A'}\nTicket: ${ticketData.ticket_id || ticketData.id}\nDevice: ${ticketData.device_type || ''} ${ticketData.brand || ''} ${ticketData.model || ''}`.trim();
            await sendTextMessage(phone, fallbackText, { ticketId: insertId, customerId: customerId || null, phone, sender: 'System', conversationId: custConvId });
          }
        }
      } catch (e) {
        console.error('WhatsApp notification failed:', e.message);
      }
      // Wait 30 seconds before sending the PDF receipt
      try {
        await new Promise(resolve => setTimeout(resolve, 30000));
        const pdf = await generateInwardReceiptFromHTML(insertId);
        await createPdfMessage({
          conversationId: custConvId,
          ticketId: insertId,
          customerId: customerId || null,
          sender: 'System',
          fileName: pdf.fileName,
          fileSize: pdf.fileSize,
          documentType: 'inward_receipt',
          event: 'Receipt generated',
          phone: phone,
        });
        // Auto-send the PDF document via WhatsApp
        if (phone && pdf.filePath) {
          sendDocumentFile(phone, pdf.filePath, `Inward Receipt - ${pdf.receiptNumber || ''}`, {
            ticketId: insertId,
            conversationId: custConvId,
            sender: 'System',
          }).catch(e => console.error('Auto-send inward receipt PDF failed:', e.message));
        }
      } catch (e) {
        console.error('Auto-generate inward receipt failed:', e.message);
      }
    });

    res.status(201).json({ success: true, message: 'Ticket created successfully', data: newTicket.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/tickets/:id - Update ticket
router.put('/:id', async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const oldTicket = existing.rows[0];
    const updates = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    updates.updated_at = now;

    let statusChanged = false;
    if (updates.status && updates.status !== oldTicket.status) {
      statusChanged = true;
      await recordStatusChange(req.params.id, oldTicket.status, updates.status, updates.changedBy || 'System', client, oldTicket.ticket_id);
    }

    const fieldMapping = {
      customerName: 'customer_name',
      primaryPhone: 'customer_phone', customerPhone: 'customer_phone',
      email: 'customer_email', customerEmail: 'customer_email', serviceAddress: 'service_address',
      addressLine2: 'address_line2', city: 'city', state: 'state',
      pincode: 'postcode', postcode: 'postcode', country: 'country',
      deviceType: 'device_type', brand: 'brand', model: 'model',
      serialNumber: 'serial_number', serialIMEI: 'serial_imei', imei: 'imei', macAddress: 'mac_address',
      password: 'device_password',
      issueCategory: 'issue_category', customIssueCategory: 'custom_issue_category',
      problemDescription: 'problem_description', issue: 'problem_description',
      secondaryName: 'secondary_name', secondaryPhone: 'secondary_phone',
      secondaryEmail: 'secondary_email',
      accessories: 'accessories', bodyDamage: 'body_damage', body_damage: 'body_damage',
      dataBackup: 'data_backup', data_backup: 'data_backup',
      estimatedCost: 'estimated_cost',
      estimatedPrice: 'estimated_price',
      advancePayment: 'advance_payment', priority: 'priority',
      location: 'asset_location', warranty: 'warranty', company: 'company',
      storeId: 'store_id',
      status: 'status', customerId: 'customer_id'
    };

    const setClauses = [];
    const updateValues = [];
    const seenCols = new Set();

    for (const [frontField, dbField] of Object.entries(fieldMapping)) {
      if (updates[frontField] !== undefined && !seenCols.has(dbField)) {
        seenCols.add(dbField);
        setClauses.push(`${dbField} = $${setClauses.length + 1}`);
        updateValues.push(updates[frontField]);
      }
    }

    if (setClauses.length > 0) {
      setClauses.push(`updated_at = $${setClauses.length + 1}`);
      updateValues.push(now);
      updateValues.push(req.params.id);

      await client.query(
        `UPDATE tickets SET ${setClauses.join(', ')} WHERE id = $${setClauses.length + 1}`,
        updateValues
      );
    }

    await client.query('COMMIT');

    const updated = await client.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);

    // Handle status change event and WhatsApp template (fire-and-forget)
    if (statusChanged) {
      setImmediate(async () => {
        try {
          await createStatusEvent(parseInt(req.params.id), oldTicket.status, updates.status, updates.changedBy || 'System');
        } catch (e) {
          console.error('Auto-create status event failed:', e.message);
        }
        try {
          const store = await getStoreInfo(updated.rows[0]?.store_id);
          const waResult = await sendTicketStatusTemplate(updated.rows[0], updates.status, store);
          if (!waResult.success) {
            console.error('Status change WhatsApp template failed:', waResult.error || waResult.reason || JSON.stringify(waResult));
            // Fallback: send text notification
            const ticketData = updated.rows[0];
            if (ticketData.customer_phone) {
              const convId = getConversationIdFromPhone(ticketData.customer_phone);
              const fallbackText = `*Status Update: ${updates.status}*\n\nTicket: ${ticketData.ticket_id || ticketData.id}\nCustomer: ${ticketData.customer_name || 'N/A'}\nDevice: ${ticketData.device_type || ''} ${ticketData.brand || ''} ${ticketData.model || ''}`.trim();
              await sendTextMessage(ticketData.customer_phone, fallbackText, { ticketId: parseInt(req.params.id), customerId: ticketData.customer_id, phone: ticketData.customer_phone, sender: 'System', conversationId: convId });
            }
          }
        } catch (e) {
          console.error('Send status template failed:', e.message);
        }
      });
    }

    res.json({ success: true, message: 'Ticket updated successfully', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/tickets/:id - Delete ticket
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await query('DELETE FROM tickets WHERE id = ?', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    res.json({ success: true, message: 'Ticket deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:id/status-history - Get status history
router.get('/:id/status-history', async (req, res, next) => {
  try {
    const history = await getStatusHistory(req.params.id);
    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tickets/:id/status - Update status only
router.put('/:id/status', async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const { status, changedBy } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, message: 'Status is required' });
    }

    const existing = await client.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const oldTicket = existing.rows[0];
    const oldStatus = oldTicket.status;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await client.query('UPDATE tickets SET status = $1, updated_at = $2 WHERE id = $3', [status, now, req.params.id]);
    await recordStatusChange(req.params.id, oldStatus, status, changedBy || 'System', client, oldTicket.ticket_id);

    await client.query('COMMIT');

    const updated = await client.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);

    // Handle status change: create event and send WhatsApp template (fire-and-forget)
    if (status !== oldStatus) {
      setImmediate(async () => {
        try {
          await createStatusEvent(parseInt(req.params.id), oldStatus, status, changedBy || 'System');
        } catch (e) {
          console.error('Auto-create status event failed:', e.message);
        }
        try {
          const store = await getStoreInfo(updated.rows[0]?.store_id);
          const waResult = await sendTicketStatusTemplate(updated.rows[0], status, store);
          if (!waResult.success) {
            console.error('Status change WhatsApp template failed:', waResult.error || waResult.reason || JSON.stringify(waResult));
            const ticketData = updated.rows[0];
            if (ticketData.customer_phone) {
              const convId = getConversationIdFromPhone(ticketData.customer_phone);
              const fallbackText = `*Status Update: ${status}*\n\nTicket: ${ticketData.ticket_id || ticketData.id}\nCustomer: ${ticketData.customer_name || 'N/A'}\nDevice: ${ticketData.device_type || ''} ${ticketData.brand || ''} ${ticketData.model || ''}`.trim();
              await sendTextMessage(ticketData.customer_phone, fallbackText, { ticketId: parseInt(req.params.id), customerId: ticketData.customer_id, phone: ticketData.customer_phone, sender: 'System', conversationId: convId });
            }
          }
        } catch (e) {
          console.error('Send status template failed:', e.message);
        }
      });
    }

    res.json({ success: true, message: 'Status updated successfully', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;