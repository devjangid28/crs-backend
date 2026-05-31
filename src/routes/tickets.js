const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/database');
const { generateTicketId } = require('../services/ticketIdGenerator');
const { recordStatusChange, getStatusHistory } = require('../services/statusHistoryService');
const { validateTicket } = require('../middleware/validation');

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

    const ticketId = await generateTicketId();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const {
      customerId, customerName,
      primaryPhone, customerPhone,
      email, customerEmail, serviceAddress,
      addressLine2, city, state, postcode, pincode, country,
      deviceType, brand, model, serialNumber, serialIMEI, imei, macAddress, password,
      issueCategory, customIssueCategory, problemDescription, issue, solutionDescription,
      secondaryName, secondaryPhone, secondaryEmail,
      accessories, estimatedCost, advancePayment, priority, location, warranty, company,
      status = 'New'
    } = req.body;

    const phone = primaryPhone || customerPhone;
    const emailAddr = email || customerEmail;
    const problemDesc = problemDescription || issue;
    const postCode = postcode || pincode;

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
      problem_description: problemDesc, solution_description: solutionDescription,
      secondary_name: secondaryName || null, secondary_phone: secondaryPhone || null,
      secondary_email: secondaryEmail || null,
      accessories: accessories || null,
      estimated_cost: estimatedCost || 0, advance_payment: advancePayment || 0,
      priority: priority || 'Medium', asset_location: location || 'In Shop',
      warranty: warranty ? true : false, company: company || null,
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

    if (updates.status && updates.status !== oldTicket.status) {
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
      problemDescription: 'problem_description', issue: 'problem_description', solutionDescription: 'solution_description',
      secondaryName: 'secondary_name', secondaryPhone: 'secondary_phone',
      secondaryEmail: 'secondary_email',
      accessories: 'accessories', estimatedCost: 'estimated_cost',
      advancePayment: 'advance_payment', priority: 'priority',
      location: 'asset_location', warranty: 'warranty', company: 'company',
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

    const existing = await client.query('SELECT status, ticket_id FROM tickets WHERE id = $1', [req.params.id]);
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
    res.json({ success: true, message: 'Status updated successfully', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
