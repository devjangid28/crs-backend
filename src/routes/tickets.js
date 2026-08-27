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
const { optionalAuth } = require('../middleware/optionalAuth');
const { generateInwardReceiptFromHTML, generateServiceInvoiceFromHTML } = require('../services/pdfGenerator');
const { createPdfMessage, createStatusEvent, getOrCreateConversation } = require('../services/messagingService');
const { notifyTicketCreated, sendTicketStatusTemplate, sendTextMessage, sendCollectionLink, sendInwardReceiptLink, getConversationIdFromPhone } = require('../services/whatsappService');

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

// Accept both camelCase (web) and snake_case (mobile) request bodies
function pick(body, names) {
  for (const n of names) {
    const v = body[n];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

// Normalize line items from any source shape into { description, qty, unitPrice, total }.
// Falls back to splitting the work description line-by-line so a Service Invoice
// can always be generated even when no explicit items were saved.
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

function normalizePhoneDigits(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/[^\d]/g, '').replace(/^0+/, '');
  if (!cleaned) return null;
  return cleaned.length > 10 ? cleaned.slice(-10) : cleaned;
}

// Find an existing customer by phone/email, otherwise create one.
// Mirrors the web app's logic (find by phone -> find by email -> create) so
// tickets created from the mobile app link to the same customer record.
async function resolveCustomer(client, { name, phone, email, company }) {
  const shortPhone = normalizePhoneDigits(phone);
  let customer = null;

  if (shortPhone) {
    const r1 = await client.query(
      `SELECT * FROM customers
       WHERE phone LIKE $1 OR phone2 LIKE $1 OR phone LIKE $2 OR phone2 LIKE $2
       ORDER BY id ASC LIMIT 1`,
      [`%${shortPhone}`, `%${shortPhone}`]
    );
    if (r1.rows.length > 0) customer = r1.rows[0];
  }

  if (!customer && email) {
    const r2 = await client.query(
      'SELECT * FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [String(email).trim()]
    );
    if (r2.rows.length > 0) customer = r2.rows[0];
  }

  if (!customer && (shortPhone || email) && name) {
    const r3 = await client.query(
      `INSERT INTO customers (name, phone, email, company, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING *`,
      [String(name).trim(), phone || null, email || null, company || null]
    );
    customer = r3.rows[0];
  }

  return customer || null;
}

// GET /api/tickets - Get all tickets with search & filter
router.get('/', async (req, res, next) => {
  try {
    const { search, status, priority, page = 1, limit = 50, store_id } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (store_id) {
      whereClause += ` AND store_id = ?`;
      params.push(parseInt(store_id));
    }

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
router.post('/', validateTicket, optionalAuth, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const ticketId = await generateTicketId(client);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const b = req.body;
    const customerId = pick(b, ['customerId', 'customer_id']);
    const customerName = pick(b, ['customerName', 'customer_name']);
    const primaryPhone = pick(b, ['primaryPhone', 'primary_phone', 'customerPhone', 'customer_phone', 'phone', 'mobile_number']);
    const emailAddr = pick(b, ['email', 'customerEmail', 'customer_email']);
    const serviceAddress = pick(b, ['serviceAddress', 'service_address']);
    const addressLine2 = pick(b, ['addressLine2', 'address_line2']);
    const city = pick(b, ['city']);
    const state = pick(b, ['state']);
    const postCode = pick(b, ['postcode', 'pincode']);
    const country = pick(b, ['country']);
    const deviceType = pick(b, ['deviceType', 'device_type']);
    const brand = pick(b, ['brand']);
    const model = pick(b, ['model']);
    const serialNumber = pick(b, ['serialNumber', 'serial_number']);
    const serialIMEI = pick(b, ['serialIMEI', 'serial_imei']);
    const imei = pick(b, ['imei']);
    const macAddress = pick(b, ['macAddress', 'mac_address']);
    const password = pick(b, ['password', 'device_password']);
    const issueCategory = pick(b, ['issueCategory', 'issue_category']);
    const serviceType = pick(b, ['serviceType', 'service_type']);
    const customIssueCategory = pick(b, ['customIssueCategory', 'custom_issue_category']);
    const problemDesc = pick(b, ['problemDescription', 'problem_description', 'issue']);
    const solutionDesc = pick(b, ['solutionDescription', 'solution_description']);
    const secondaryName = pick(b, ['secondaryName', 'secondary_name']);
    const secondaryPhone = pick(b, ['secondaryPhone', 'secondary_phone']);
    const secondaryEmail = pick(b, ['secondaryEmail', 'secondary_email']);
    const accessories = pick(b, ['accessories']);
    const bodyDamage = pick(b, ['bodyDamage', 'body_damage']);
    const dataBackup = pick(b, ['dataBackup', 'data_backup']);
    const estimatedCost = pick(b, ['estimatedCost', 'estimated_cost']);
    const estimatedPrice = pick(b, ['estimatedPrice', 'estimated_price']);
    const advancePayment = pick(b, ['advancePayment', 'advance_payment']);
    const lineItemsRaw = pick(b, ['lineItems', 'line_items', 'invoiceItems', 'invoice_items']);
    const taxRate = pick(b, ['taxRate', 'tax_rate']);
    const discount = pick(b, ['discount']);
    const priority = pick(b, ['priority']);
    const location = pick(b, ['location', 'asset_location']);
    const warranty = pick(b, ['warranty']);
    const company = pick(b, ['company']);
    const storeId = pick(b, ['storeId', 'store_id']);
    const createdBy = pick(b, ['createdBy', 'created_by', 'checkedInBy', 'checked_in_by', 'technician']);
    const assignedTechnician = pick(b, ['assignedTechnician', 'assigned_technician']);
    const status = pick(b, ['status']) || 'New';
    const isReplacement = pick(b, ['isReplacement', 'is_replacement']);
    const replacementTakenBy = pick(b, ['replacementTakenBy', 'replacement_taken_by']);
    const replacementServiceCenter = pick(b, ['replacementServiceCenter', 'replacement_service_center']);
    const replacementReceiptNo = pick(b, ['replacementReceiptNo', 'replacement_receipt_no']);
    const replacementInvoiceNo = pick(b, ['replacementInvoiceNo', 'replacement_invoice_no']);
    const replacementGivenDate = pick(b, ['replacementGivenDate', 'replacement_given_date']);

    const phone = primaryPhone;

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

    // Resolve the customer record (match by phone -> email, create if new) so tickets
    // created from the web AND mobile app are linked to the same customer.
    let resolvedCustomer = null;
    if (customerId && /^\d+$/.test(String(customerId))) {
      const existing = await client.query('SELECT * FROM customers WHERE id = $1', [customerId]);
      if (existing.rows.length > 0) resolvedCustomer = existing.rows[0];
    }
    if (!resolvedCustomer) {
      resolvedCustomer = await resolveCustomer(client, {
        name: customerName, phone, email: emailAddr, company,
      });
    }
    const resolvedCustomerId = resolvedCustomer ? resolvedCustomer.id : null;

    const enteredEstimate = (estimatedPrice || estimatedCost) || 0;
    const lineItems = normalizeLineItems(lineItemsRaw, solutionDesc || problemDesc);

    // Replacement tickets are only handled under warranty, so force the
    // service type to 'In Warranty' regardless of what the client sent.
    const effectiveServiceType = isReplacement ? 'In Warranty' : (serviceType || 'Out of Warranty');

    const fields = {
      ticket_id: ticketId, customer_id: resolvedCustomerId,
      customer_name: customerName, customer_phone: phone,
      customer_email: emailAddr, service_address: serviceAddress || '',
      address_line2: addressLine2 || null, city: city || null,
      state: state || null, postcode: postCode || null, country: country || 'India',
      device_type: deviceType || null, brand: brand || null, model: model || null,
      serial_number: serialNumber || null, serial_imei: serialIMEI || null,
      imei: imei || null, mac_address: macAddress || null, device_password: password || null,
      issue_category: issueCategory, custom_issue_category: customIssueCategory || null,
      service_type: effectiveServiceType,
      problem_description: problemDesc, solution_description: solutionDesc || null,
      secondary_name: secondaryName || null, secondary_phone: secondaryPhone || null,
      secondary_email: secondaryEmail || null,
      accessories: accessories || null,
      body_damage: bodyDamage || 'No', data_backup: dataBackup || 'No',
      estimated_cost: enteredEstimate, estimated_price: enteredEstimate, advance_payment: advancePayment || 0,
      line_items: lineItems.length > 0 ? JSON.stringify(lineItems) : null,
      tax_rate: taxRate, discount: discount,
      priority: priority || 'Medium', asset_location: location || 'In Shop',
      warranty: warranty ? true : false, company: company || null,
      store_id: resolvedStoreId,
      checked_in_by: createdBy || null,
      assigned_technician: assignedTechnician || null,
      created_by_user_id: req.user ? req.user.id : null,
      is_replacement: isReplacement ? true : false,
      replacement_taken_by: replacementTakenBy || null,
      replacement_service_center: replacementServiceCenter || null,
      replacement_receipt_no: replacementReceiptNo || null,
      replacement_invoice_no: replacementInvoiceNo || null,
      replacement_given_date: replacementGivenDate || null,
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
        await getOrCreateConversation(insertId, resolvedCustomerId, phone);
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
            await sendTextMessage(phone, fallbackText, { ticketId: insertId, customerId: resolvedCustomerId, phone, sender: 'System', conversationId: custConvId });
          }
        }
      } catch (e) {
        console.error('WhatsApp notification failed:', e.message);
      }
      // Wait 30 seconds before sending the receipt
      try {
        await new Promise(resolve => setTimeout(resolve, 30000));
        const pdf = await generateInwardReceiptFromHTML(insertId);
        await createPdfMessage({
          conversationId: custConvId,
          ticketId: insertId,
          customerId: resolvedCustomerId,
          sender: 'System',
          fileName: pdf.fileName,
          fileSize: pdf.fileSize,
          documentType: 'inward_receipt',
          event: 'Receipt generated',
          phone: phone,
        });
        // Auto-send the receipt via WhatsApp template (always delivers). Falls
        // back to the raw PDF document if the template is not approved yet.
        if (phone && pdf.filePath) {
          sendInwardReceiptLink(newTicket.rows[0], pdf.filePath)
            .catch(e => console.error('Auto-send inward receipt failed:', e.message));
        }
      } catch (e) {
        console.error('Auto-generate inward receipt failed:', e.message);
      }
    });

    scheduleServiceInvoiceGeneration(insertId, status);

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
      await recordStatusChange(req.params.id, oldTicket.status, updates.status, updates.changedBy || 'System', client, oldTicket.ticket_id);
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
      expected_completion_date: 'expected_completion_date',
      isReplacement: 'is_replacement', is_replacement: 'is_replacement',
      replacementTakenBy: 'replacement_taken_by', replacement_taken_by: 'replacement_taken_by',
      replacementServiceCenter: 'replacement_service_center', replacement_service_center: 'replacement_service_center',
      replacementReceiptNo: 'replacement_receipt_no', replacement_receipt_no: 'replacement_receipt_no',
      replacementInvoiceNo: 'replacement_invoice_no', replacement_invoice_no: 'replacement_invoice_no',
      replacementGivenDate: 'replacement_given_date', replacement_given_date: 'replacement_given_date'
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

    // Keep estimated_cost and estimated_price in sync so the same amount is
    // used everywhere (print preview, PDF, PDFs generated later).
    if (updates.estimatedCost !== undefined || updates.estimatedPrice !== undefined) {
      const est = updates.estimatedCost !== undefined ? updates.estimatedCost : updates.estimatedPrice;
      if (!seenCols.has('estimated_cost')) {
        seenCols.add('estimated_cost');
        setClauses.push(`estimated_cost = $${setClauses.length + 1}`);
        updateValues.push(est);
      }
      if (!seenCols.has('estimated_price')) {
        seenCols.add('estimated_price');
        setClauses.push(`estimated_price = $${setClauses.length + 1}`);
        updateValues.push(est);
      }
    }

    // Replacement tickets are always under warranty; force the service type.
    const replacementFlag = updates.isReplacement !== undefined ? updates.isReplacement : updates.is_replacement;
    if (replacementFlag !== undefined && replacementFlag !== false && !seenCols.has('service_type')) {
      seenCols.add('service_type');
      setClauses.push(`service_type = $${setClauses.length + 1}`);
      updateValues.push('In Warranty');
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
          await createStatusEvent(parseInt(req.params.id), oldTicket.status, effectiveStatus, updates.changedBy || 'System');
        } catch (e) {
          console.error('Auto-create status event failed:', e.message);
        }
        try {
          const store = await getStoreInfo(updated.rows[0]?.store_id);
          const waResult = await sendTicketStatusTemplate(updated.rows[0], effectiveStatus, store);
          if (!waResult.success) {
            console.error('Status change WhatsApp template failed:', waResult.error || waResult.reason || JSON.stringify(waResult));
            // Fallback: send text notification
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
          // After the template message, auto-send the collection link when the
          // ticket is marked Completed so the customer can collect the device.
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

    const status = normalizeStatus(req.body.status);
    const changedBy = req.body.changedBy || 'System';
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
    const lineItemsRaw = pick(req.body, ['lineItems', 'line_items', 'invoiceItems', 'invoice_items']);
    if (lineItemsRaw !== undefined) {
      const normalized = normalizeLineItems(lineItemsRaw, oldTicket.solution_description || oldTicket.problem_description);
      await client.query(
        `UPDATE tickets SET line_items = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [normalized.length > 0 ? JSON.stringify(normalized) : null, req.params.id]
      );
    }
    await recordStatusChange(req.params.id, oldStatus, status, changedBy || 'System', client, oldTicket.ticket_id);

    await client.query('COMMIT');

    const updated = await client.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);

    scheduleServiceInvoiceGeneration(parseInt(req.params.id), status);

    // Handle status change: create event and send WhatsApp template (fire-and-forget)
    if (status !== oldStatus || (status === 'Partially Completed' && partialTouched)) {
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
              let fallbackText = `*Status Update: ${status}*\n\nTicket: ${ticketData.ticket_id || ticketData.id}\nCustomer: ${ticketData.customer_name || 'N/A'}\nDevice: ${ticketData.device_type || ''} ${ticketData.brand || ''} ${ticketData.model || ''}`.trim();
              if (status === 'Partially Completed') {
                fallbackText += `\n\nRemaining Work: ${ticketData.remaining_work || 'Details will be shared soon.'}\nPending Amount: ₹${parseFloat(ticketData.pending_amount || 0).toFixed(2)}`;
              }
              await sendTextMessage(ticketData.customer_phone, fallbackText, { ticketId: parseInt(req.params.id), customerId: ticketData.customer_id, phone: ticketData.customer_phone, sender: 'System', conversationId: convId });
            }
          }
          // After the template message, auto-send the collection link when the
          // ticket is marked Completed so the customer can collect the device.
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