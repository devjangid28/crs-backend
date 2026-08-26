const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { recordStatusChange, getStatusHistory } = require('../services/statusHistoryService');
const { createStatusEvent, getOrCreateConversation, createPdfMessage } = require('../services/messagingService');
const { sendTicketStatusTemplate, sendCollectionLink, sendTextMessage, getConversationIdFromPhone } = require('../services/whatsappService');
const { generateServiceInvoiceFromHTML } = require('../services/pdfGenerator');

// Normalize status strings to exact DB enum values (handles casing differences
// between mobile app, web frontend, and the PostgreSQL enum).
const VALID_STATUSES = new Set([
  'New', 'Pending', 'In Progress', 'Waiting For Parts', 'Partially Completed',
  'Ready For Pickup', 'Completed', 'Delivered', 'Cancelled', 'Collected'
]);
const STATUS_ALIAS_MAP = Object.fromEntries([
  ['waiting for parts', 'Waiting For Parts'],
  ['ready for pickup', 'Ready For Pickup'],
  ['partially completed', 'Partially Completed'],
  ['in progress', 'In Progress'],
]);
function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (VALID_STATUSES.has(trimmed)) return trimmed;
  const alias = STATUS_ALIAS_MAP[trimmed.toLowerCase()];
  return alias || trimmed;
}

// Normalize line items from any source shape into { description, qty, unitPrice, total }.
function normalizeLineItems(raw, fallbackSource) {
  let items = raw;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = null; }
  }
  const out = [];
  if (Array.isArray(items)) {
    items.forEach((it) => {
      if (!it) return;
      const description = it.description || it.name || it.item || it.desc || '';
      if (!String(description).trim()) return;
      const qty = parseFloat(it.qty ?? it.quantity ?? it.unit ?? 1) || 1;
      const unitPrice = parseFloat(it.unitPrice ?? it.unit_price ?? it.price ?? 0) || 0;
      const total = parseFloat(it.total ?? it.amount);
      out.push({
        description: String(description).trim(),
        qty,
        unitPrice,
        total: Number.isFinite(total) ? total : qty * unitPrice,
      });
    });
  }
  if (out.length === 0 && fallbackSource) {
    const lines = String(fallbackSource).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      lines.forEach(line => out.push({ description: line, qty: 1, unitPrice: 0, total: 0 }));
    }
  }
  return out;
}

// Generate (or regenerate) the Service Invoice PDF for a Completed ticket and
// record it in the conversation history. Fire-and-forget so API stays fast.
function scheduleServiceInvoiceGeneration(ticketId, status) {
  if (status !== 'Completed') return;
  setImmediate(async () => {
    try {
      const pdf = await generateServiceInvoiceFromHTML(ticketId);
      const conv = await getOrCreateConversation(ticketId);
      await createPdfMessage({
        conversationId: conv ? conv.conversationId : null,
        ticketId,
        sender: 'System',
        fileName: pdf.fileName,
        fileSize: pdf.fileSize,
        documentType: 'service_invoice',
        event: 'Service invoice generated',
      });
      console.log('Service invoice generated for ticket:', ticketId, pdf.invoiceNumber);
    } catch (e) {
      console.error('Auto-generate service invoice failed:', e.message);
    }
  });
}

// All staff ticket routes require an authenticated session. The web ticket
// routes are untouched, so existing functionality is not affected.
router.use(authenticate);

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

// Does this staff member own the ticket? Owned means they created it
// (created_by_user_id matches) or, for older records, their full name was
// recorded in checked_in_by.
function isOwner(ticket, user) {
  if (ticket.created_by_user_id && user.id) {
    return String(ticket.created_by_user_id) === String(user.id);
  }
  if (ticket.checked_in_by && user.full_name) {
    return String(ticket.checked_in_by).trim().toLowerCase() === String(user.full_name).trim().toLowerCase();
  }
  return false;
}

// GET /api/staff/tickets - List tickets created by the logged-in staff member
router.get('/', async (req, res, next) => {
  try {
    const { search, status, priority, page = 1, limit = 50 } = req.query;
    let whereClause = 'WHERE (created_by_user_id = ? OR (created_by_user_id IS NULL AND checked_in_by ILIKE ?))';
    const params = [req.user.id, String(req.user.full_name || '').trim()];

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

// GET /api/staff/tickets/:id - Get one of the staff member's tickets
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const ticket = result.rows[0];
    if (!isOwner(ticket, req.user)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this ticket' });
    }
    ticket.statusHistory = await getStatusHistory(req.params.id);
    res.json({ success: true, data: ticket });
  } catch (err) {
    next(err);
  }
});

// PUT /api/staff/tickets/:id - Update one of the staff member's tickets
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
    if (!isOwner(oldTicket, req.user)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'You do not have access to this ticket' });
    }

    const updates = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    updates.updated_at = now;
    updates.changedBy = req.user.full_name || updates.changedBy || 'System';

    // Normalize partial-completion fields before saving.
    if (updates.pendingAmount !== undefined) {
      const pa = parseFloat(updates.pendingAmount);
      updates.pendingAmount = Number.isFinite(pa) && pa >= 0 ? pa : null;
    }
    if (updates.remainingWork !== undefined) {
      updates.remainingWork = String(updates.remainingWork).trim() || null;
    }
    if (updates.expectedCompletionDate !== undefined) {
      updates.expectedCompletionDate = updates.expectedCompletionDate ? updates.expectedCompletionDate : null;
    }

    if (updates.status) updates.status = normalizeStatus(updates.status);

    let statusChanged = false;
    if (updates.status && updates.status !== oldTicket.status) {
      statusChanged = true;
      await recordStatusChange(req.params.id, oldTicket.status, updates.status, updates.changedBy, client, oldTicket.ticket_id);
    }

    // Partial completion details: notify the customer whenever the ticket is
    // marked (or already is) Partially Completed and the remaining work or
    // pending amount was actually changed.
    const effectiveStatus = updates.status || oldTicket.status;
    const partialFieldsTouched = ['remainingWork', 'pendingAmount', 'expectedCompletionDate'].some(k => {
      if (updates[k] === undefined) return false;
      const oldVal = k === 'remainingWork' ? oldTicket.remaining_work
        : k === 'pendingAmount' ? oldTicket.pending_amount
        : oldTicket.expected_completion_date;
      const newVal = updates[k];
      if (oldVal === null && (newVal === null || newVal === '')) return false;
      return String(newVal ?? '') !== String(oldVal ?? '');
    });
    const shouldNotifyPartial = effectiveStatus === 'Partially Completed' && (statusChanged || partialFieldsTouched);

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
      serviceType: 'service_type', service_type: 'service_type',
      problemDescription: 'problem_description', issue: 'problem_description',
      solutionDescription: 'solution_description', solution_description: 'solution_description',
      secondaryName: 'secondary_name', secondaryPhone: 'secondary_phone',
      secondaryEmail: 'secondary_email',
      accessories: 'accessories', bodyDamage: 'body_damage', body_damage: 'body_damage',
      dataBackup: 'data_backup', data_backup: 'data_backup',
      estimatedCost: 'estimated_cost',
      estimatedPrice: 'estimated_price',
      advancePayment: 'advance_payment', priority: 'priority',
      location: 'asset_location', warranty: 'warranty', company: 'company',
      storeId: 'store_id', taxRate: 'tax_rate', tax_rate: 'tax_rate',
      discount: 'discount',
      status: 'status', customerId: 'customer_id',
      remainingWork: 'remaining_work', pendingAmount: 'pending_amount',
      expectedCompletionDate: 'expected_completion_date',
      remaining_work: 'remaining_work', pending_amount: 'pending_amount',
      expected_completion_date: 'expected_completion_date'
    };

    const setClauses = [];
    const updateValues = [];
    const seenCols = new Set();

    // line_items is JSONB: normalize the incoming array/string to JSON.
    if (updates.lineItems !== undefined || updates.line_items !== undefined || updates.invoiceItems !== undefined || updates.invoice_items !== undefined) {
      const raw = updates.lineItems !== undefined ? updates.lineItems
        : updates.line_items !== undefined ? updates.line_items
        : updates.invoiceItems !== undefined ? updates.invoiceItems
        : updates.invoice_items;
      const normalized = normalizeLineItems(raw, updates.solutionDescription || updates.solution_description || updates.problemDescription || updates.problem_description || oldTicket.solution_description || oldTicket.problem_description);
      seenCols.add('line_items');
      setClauses.push(`line_items = $${setClauses.length + 1}`);
      updateValues.push(normalized.length > 0 ? JSON.stringify(normalized) : null);
    }

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

    scheduleServiceInvoiceGeneration(parseInt(req.params.id), effectiveStatus);

    // Handle status change event and WhatsApp template (fire-and-forget)
    if (statusChanged || shouldNotifyPartial) {
      setImmediate(async () => {
        try {
          await createStatusEvent(parseInt(req.params.id), oldTicket.status, effectiveStatus, updates.changedBy);
        } catch (e) {
          console.error('Auto-create status event failed:', e.message);
        }
        try {
          const store = await getStoreInfo(updated.rows[0]?.store_id);
          const waResult = await sendTicketStatusTemplate(updated.rows[0], effectiveStatus, store);
          if (!waResult.success) {
            console.error('Status change WhatsApp template failed:', waResult.error || waResult.reason || JSON.stringify(waResult));
            const ticketData = updated.rows[0];
            if (ticketData.customer_phone) {
              const convId = getConversationIdFromPhone(ticketData.customer_phone);
              let fallbackText = `*Status Update: ${effectiveStatus}*\n\nTicket: ${ticketData.ticket_id || ticketData.id}\nCustomer: ${ticketData.customer_name || 'N/A'}\nDevice: ${ticketData.device_type || ''} ${ticketData.brand || ''} ${ticketData.model || ''}`.trim();
              if (effectiveStatus === 'Partially Completed') {
                fallbackText += `\n\nRemaining Work: ${ticketData.remaining_work || 'Details will be shared soon.'}\nPending Amount: ₹${parseFloat(ticketData.pending_amount || 0).toFixed(2)}`;
              }
              await sendTextMessage(ticketData.customer_phone, fallbackText, { ticketId: parseInt(req.params.id), customerId: ticketData.customer_id, phone: ticketData.customer_phone, sender: 'System', conversationId: convId });
            }
          }
          if (effectiveStatus === 'Completed') {
            await sendCollectionLink(updated.rows[0]);
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

// PUT /api/staff/tickets/:id/status - Update status only
router.put('/:id/status', async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const status = normalizeStatus(req.body.status);
    const changedBy = req.body.changedBy || req.user.full_name || 'System';
    if (!status) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Status is required' });
    }

    const existing = await client.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const oldTicket = existing.rows[0];
    if (!isOwner(oldTicket, req.user)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'You do not have access to this ticket' });
    }

    const oldStatus = oldTicket.status;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Allow partial-completion details (remaining work, pending amount,
    // expected completion date) to be saved together with the status.
    const partialField = (key) => {
      const value = req.body[key];
      if (value === undefined || value === null) return null;
      if (key === 'pendingAmount') {
        const num = parseFloat(value);
        return Number.isFinite(num) && num >= 0 ? num : null;
      }
      if (key === 'remainingWork') {
        return String(value).trim() || null;
      }
      return value === '' ? null : value;
    };
    const partialTouched = ['remainingWork', 'pendingAmount', 'expectedCompletionDate'].some(k => {
      if (req.body[k] === undefined) return false;
      const oldVal = k === 'remainingWork' ? oldTicket.remaining_work
        : k === 'pendingAmount' ? oldTicket.pending_amount
        : oldTicket.expected_completion_date;
      const newVal = partialField(k);
      if (oldVal === null && newVal === null) return false;
      return String(newVal ?? '') !== String(oldVal ?? '');
    });
    const partialWhere = [
      'remaining_work', 'pending_amount', 'expected_completion_date'
    ];

    const partialSets = [];
    const partialValues = [];
    ['remainingWork', 'pendingAmount', 'expectedCompletionDate'].forEach((key, i) => {
      if (req.body[key] !== undefined) {
        partialSets.push(`${partialWhere[i]} = $${partialSets.length + 1}`);
        partialValues.push(partialField(key));
      }
    });

    await client.query('UPDATE tickets SET status = $1, updated_at = $2 WHERE id = $3', [status, now, req.params.id]);
    if (partialSets.length > 0) {
      await client.query(
        `UPDATE tickets SET ${partialSets.join(', ')} WHERE id = $${partialSets.length + 1}`,
        [...partialValues, req.params.id]
      );
    }
    // Persist line items (JSONB) when the status endpoint receives them.
    const lineItemsRaw = req.body.lineItems ?? req.body.line_items ?? req.body.invoiceItems ?? req.body.invoice_items;
    if (lineItemsRaw !== undefined) {
      const normalized = normalizeLineItems(lineItemsRaw, oldTicket.solution_description || oldTicket.problem_description);
      await client.query(
        `UPDATE tickets SET line_items = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [normalized.length > 0 ? JSON.stringify(normalized) : null, req.params.id]
      );
    }
    await recordStatusChange(req.params.id, oldStatus, status, changedBy, client, oldTicket.ticket_id);

    await client.query('COMMIT');

    const updated = await client.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);

    scheduleServiceInvoiceGeneration(parseInt(req.params.id), status);

    // Handle status change: create event and send WhatsApp template (fire-and-forget)
    if (status !== oldStatus || (status === 'Partially Completed' && partialTouched)) {
      setImmediate(async () => {
        try {
          await createStatusEvent(parseInt(req.params.id), oldStatus, status, changedBy);
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
              let fallbackText = `*Status Update: ${status}*\n\nTicket: ${ticketData.ticket_id || ticketData.id}\nCustomer: ${ticketData.customer_name || 'N/A'}\nDevice: ${ticketData.device_type || ''} ${ticketData.brand || ''} ${ticketData.model || ''}`.trim();
              if (status === 'Partially Completed') {
                fallbackText += `\n\nRemaining Work: ${ticketData.remaining_work || 'Details will be shared soon.'}\nPending Amount: ₹${parseFloat(ticketData.pending_amount || 0).toFixed(2)}`;
              }
              await sendTextMessage(ticketData.customer_phone, fallbackText, { ticketId: parseInt(req.params.id), customerId: ticketData.customer_id, phone: ticketData.customer_phone, sender: 'System', conversationId: convId });
            }
          }
          if (status === 'Completed') {
            await sendCollectionLink(updated.rows[0]);
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
