const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { query, getConnection } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

async function generateAmcNumber(client) {
  const today = new Date();
  const y = today.getFullYear();
  const month = MONTHS[today.getMonth()];
  const prefix = `AMC-${y}-${month}-`;
  const result = await client.query(
    `SELECT amc_number FROM amc_contracts WHERE amc_number LIKE $1 ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );
  let nextNum = 1;
  if (result.rows.length > 0) {
    const last = result.rows[0].amc_number;
    const parts = last.split('-');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

async function addTimelineEntry(contractId, eventType, title, description, createdBy, client) {
  const q = client ? client.query.bind(client) : query;
  await q(
    `INSERT INTO amc_timeline (contract_id, event_type, title, description, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [contractId, eventType, title, description || null, createdBy || 'System']
  );
}

async function updateContractCounts(contractId) {
  const visitCounts = await query(
    `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'Completed') as completed, COUNT(*) FILTER (WHERE status = 'Scheduled' OR status = 'In Progress') as pending FROM amc_visits WHERE contract_id = $1 AND is_active = true`,
    [contractId]
  );
  const { total, completed, pending } = visitCounts.rows[0];
  await query(
    `UPDATE amc_contracts SET total_visits = $1, completed_visits = $2, pending_visits = $3 WHERE id = $4`,
    [parseInt(total) || 0, parseInt(completed) || 0, parseInt(pending) || 0, contractId]
  );
}

// GET /api/amc/dashboard - Dashboard stats
router.get('/dashboard', authenticate, async (req, res, next) => {
  try {
    const [
      totalContracts, activeContracts, expiredContracts, upcomingRenewals,
      todayVisits, pendingVisits, completedVisits, openIssues, closedIssues,
      monthlyVisits, engineerPerformance, contractStatusCounts, issueStatusCounts
    ] = await Promise.all([
      query(`SELECT COUNT(*) as count FROM amc_contracts WHERE is_active = true`),
      query(`SELECT COUNT(*) as count FROM amc_contracts WHERE status = 'Active' AND is_active = true`),
      query(`SELECT COUNT(*) as count FROM amc_contracts WHERE status = 'Expired' AND is_active = true`),
      query(`SELECT COUNT(*) as count FROM amc_contracts WHERE renewal_date IS NOT NULL AND renewal_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '30 days') AND is_active = true`),
      query(`SELECT COUNT(*) as count FROM amc_visits WHERE visit_date = CURRENT_DATE AND is_active = true`),
      query(`SELECT COUNT(*) as count FROM amc_visits WHERE status IN ('Scheduled', 'In Progress') AND is_active = true`),
      query(`SELECT COUNT(*) as count FROM amc_visits WHERE status = 'Completed' AND is_active = true`),
      query(`SELECT COUNT(*) as count FROM amc_issues WHERE status = 'Open' AND is_active = true`),
      query(`SELECT COUNT(*) as count FROM amc_issues WHERE status = 'Closed' AND is_active = true`),
      query(`SELECT TO_CHAR(visit_date, 'YYYY-Mon') as month, COUNT(*) as count FROM amc_visits WHERE visit_date >= (CURRENT_DATE - INTERVAL '12 months') AND is_active = true GROUP BY TO_CHAR(visit_date, 'YYYY-Mon'), EXTRACT(YEAR FROM visit_date), EXTRACT(MONTH FROM visit_date) ORDER BY EXTRACT(YEAR FROM visit_date), EXTRACT(MONTH FROM visit_date)`),
      query(`SELECT engineer_name, COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'Completed') as completed FROM amc_visits WHERE engineer_name IS NOT NULL AND visit_date >= (CURRENT_DATE - INTERVAL '3 months') AND is_active = true GROUP BY engineer_name ORDER BY completed DESC LIMIT 10`),
      query(`SELECT status, COUNT(*) as count FROM amc_contracts WHERE is_active = true GROUP BY status`),
      query(`SELECT status, COUNT(*) as count FROM amc_issues WHERE is_active = true GROUP BY status`),
    ]);

    res.json({
      success: true,
      data: {
        totalContracts: parseInt(totalContracts.rows[0]?.count) || 0,
        activeContracts: parseInt(activeContracts.rows[0]?.count) || 0,
        expiredContracts: parseInt(expiredContracts.rows[0]?.count) || 0,
        upcomingRenewals: parseInt(upcomingRenewals.rows[0]?.count) || 0,
        todayVisits: parseInt(todayVisits.rows[0]?.count) || 0,
        pendingVisits: parseInt(pendingVisits.rows[0]?.count) || 0,
        completedVisits: parseInt(completedVisits.rows[0]?.count) || 0,
        openIssues: parseInt(openIssues.rows[0]?.count) || 0,
        closedIssues: parseInt(closedIssues.rows[0]?.count) || 0,
        monthlyVisits: monthlyVisits.rows,
        engineerPerformance: engineerPerformance.rows,
        contractStatusCounts: contractStatusCounts.rows,
        issueStatusCounts: issueStatusCounts.rows,
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/amc/chart-data - Chart data
router.get('/chart-data', authenticate, async (req, res, next) => {
  try {
    const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    const weeklyVisits = await Promise.all(
      days.map((_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        const dateStr = d.toISOString().slice(0, 10);
        return query(
          `SELECT COUNT(*) as count FROM amc_visits WHERE visit_date = $1 AND is_active = true`,
          [dateStr]
        ).then(r => ({
          day: days[i],
          visits: parseInt(r.rows[0]?.count) || 0,
        }));
      })
    );

    const contractsByType = await query(
      `SELECT contract_type, COUNT(*) as count FROM amc_contracts WHERE is_active = true GROUP BY contract_type`
    );

    res.json({
      success: true,
      data: {
        weeklyVisits,
        contractsByType: contractsByType.rows,
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/amc/contracts - List contracts
router.get('/contracts', authenticate, async (req, res, next) => {
  try {
    const { search, status, page = 1, limit = 50 } = req.query;
    let whereClause = 'WHERE c.is_active = true';
    const params = [];

    if (search) {
      whereClause += ` AND (c.company_name ILIKE $${params.length + 1} OR c.contact_person ILIKE $${params.length + 2} OR c.mobile ILIKE $${params.length + 3} OR c.amc_number ILIKE $${params.length + 4})`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    if (status) {
      whereClause += ` AND c.status = $${params.length + 1}`;
      params.push(status);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countResult = await query(`SELECT COUNT(*) as total FROM amc_contracts c ${whereClause}`, params);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    const dataResult = await query(
      `SELECT c.*, COALESCE(json_agg(json_build_object(
        'id', v.id, 'visit_number', v.visit_number, 'visit_date', v.visit_date,
        'visit_time', v.visit_time, 'engineer_name', v.engineer_name,
        'status', v.status
      ) ORDER BY v.visit_date DESC) FILTER (WHERE v.id IS NOT NULL), '[]'::json) AS recent_visits
      FROM amc_contracts c
      LEFT JOIN LATERAL (SELECT * FROM amc_visits WHERE contract_id = c.id AND is_active = true ORDER BY visit_date DESC LIMIT 5) v ON true
      ${whereClause}
      GROUP BY c.id
      ORDER BY c.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/amc/contracts/:id - Single contract
router.get('/contracts/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*, 
        COALESCE(json_agg(json_build_object(
          'id', v.id, 'visit_number', v.visit_number, 'title', v.title,
          'visit_date', v.visit_date, 'visit_time', v.visit_time, 'visit_end_time', v.visit_end_time,
          'engineer_name', v.engineer_name, 'visit_type', v.visit_type,
          'issues_found', v.issues_found, 'work_performed', v.work_performed,
          'spare_parts_used', v.spare_parts_used, 'recommendations', v.recommendations,
          'customer_signature', v.customer_signature, 'notes', v.notes,
          'next_visit_date', v.next_visit_date, 'status', v.status, 'created_at', v.created_at
        ) ORDER BY v.visit_date DESC) FILTER (WHERE v.id IS NOT NULL), '[]'::json) AS visits,
        COALESCE(json_agg(DISTINCT jsonb_build_object(
          'id', i.id, 'title', i.title, 'description', i.description,
          'priority', i.priority, 'status', i.status, 'created_at', i.created_at
        )) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS issues,
        COALESCE(json_agg(DISTINCT jsonb_build_object(
          'id', t.id, 'event_type', t.event_type, 'title', t.title,
          'description', t.description, 'created_by', t.created_by, 'created_at', t.created_at
        )) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS timeline
      FROM amc_contracts c
      LEFT JOIN amc_visits v ON v.contract_id = c.id AND v.is_active = true
      LEFT JOIN amc_issues i ON i.contract_id = c.id AND i.is_active = true
      LEFT JOIN amc_timeline t ON t.contract_id = c.id
      WHERE c.id = $1
      GROUP BY c.id`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'AMC contract not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/amc/contracts - Create contract
router.post('/contracts', authenticate, async (req, res, next) => {
  const errors = [];

  const {
    customerId, companyName, contactPerson, mobile, email, address,
    contractType = 'Basic', billingCycle = 'Yearly', contractValue = 0,
    gstPercentage = 18, startDate, endDate, renewalDate,
    description, termsConditions, assignedTo, assignedUserId, notes
  } = req.body;

  if (!companyName || !companyName.trim()) errors.push('Company name is required');
  if (mobile && !/^[+]?[\d\s()-]{7,20}$/.test(mobile)) errors.push('Invalid mobile number format');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Invalid email format');
  if (customerId !== undefined && customerId !== null && customerId !== '' && (isNaN(customerId) || parseInt(customerId) < 1)) errors.push('Invalid customer ID');
  if (!startDate) errors.push('Start date is required');
  if (!endDate) errors.push('End date is required');
  if (startDate && endDate && new Date(endDate) <= new Date(startDate)) errors.push('End date must be after start date');
  if (contractValue !== undefined && contractValue !== '' && (isNaN(contractValue) || parseFloat(contractValue) < 0)) errors.push('Contract value must be a positive number');
  if (gstPercentage !== undefined && gstPercentage !== '' && (isNaN(gstPercentage) || parseFloat(gstPercentage) < 0 || parseFloat(gstPercentage) > 100)) errors.push('GST percentage must be between 0 and 100');

  const VALID_TYPES = ['Basic', 'Standard', 'Premium', 'Comprehensive', 'Custom'];
  if (contractType && !VALID_TYPES.includes(contractType)) errors.push(`Invalid contract type. Must be one of: ${VALID_TYPES.join(', ')}`);

  const VALID_CYCLES = ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'One-Time'];
  if (billingCycle && !VALID_CYCLES.includes(billingCycle)) errors.push(`Invalid billing cycle. Must be one of: ${VALID_CYCLES.join(', ')}`);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join('; '), errors });
  }

  const client = await getConnection();
  try {
    await client.query('BEGIN');
    const amcNumber = await generateAmcNumber(client);

    const cValue = parseFloat(contractValue) || 0;
    const gstPct = parseFloat(gstPercentage) || 0;
    const gstAmount = cValue * (gstPct / 100);
    const totalValue = cValue + gstAmount;

    const result = await client.query(
      `INSERT INTO amc_contracts (
        amc_number, customer_id, company_name, contact_person, mobile, email, address,
        contract_type, billing_cycle, contract_value, gst_percentage, total_value,
        start_date, end_date, renewal_date, description, terms_conditions,
        assigned_to, assigned_user_id, notes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [
        amcNumber, customerId || null, companyName, contactPerson || null, mobile || null, email || null, address || null,
        contractType, billingCycle, cValue, gstPct, totalValue,
        startDate, endDate, renewalDate || null, description || null, termsConditions || null,
        assignedTo || null, assignedUserId || null, notes || null, req.user.full_name || 'System'
      ]
    );

    await addTimelineEntry(result.rows[0].id, 'contract_created', `AMC Contract ${amcNumber} Created`, `Contract created for ${companyName}`, req.user.full_name, client);

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'AMC contract created successfully', data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/amc/contracts/:id - Update contract
router.put('/contracts/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await query('SELECT * FROM amc_contracts WHERE id = $1 AND is_active = true', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'AMC contract not found' });
    }

    const updates = req.body;
    const allowedFields = [
      'company_name', 'contact_person', 'mobile', 'email', 'address',
      'contract_type', 'billing_cycle', 'contract_value', 'gst_percentage',
      'start_date', 'end_date', 'renewal_date', 'status',
      'description', 'terms_conditions', 'assigned_to', 'assigned_user_id', 'notes'
    ];
    const fieldMapping = {
      companyName: 'company_name', contactPerson: 'contact_person',
      mobile: 'mobile', email: 'email', address: 'address',
      contractType: 'contract_type', billingCycle: 'billing_cycle',
      contractValue: 'contract_value', gstPercentage: 'gst_percentage',
      startDate: 'start_date', endDate: 'end_date', renewalDate: 'renewal_date',
      status: 'status', description: 'description', termsConditions: 'terms_conditions',
      assignedTo: 'assigned_to', assignedUserId: 'assigned_user_id', notes: 'notes'
    };

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [front, db] of Object.entries(fieldMapping)) {
      if (updates[front] !== undefined) {
        setClauses.push(`${db} = $${idx++}`);
        values.push(updates[front]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    // Recalculate total if contract value or gst changed
    if (updates.contractValue !== undefined || updates.gstPercentage !== undefined) {
      const cValue = parseFloat(updates.contractValue ?? existing.rows[0].contract_value) || 0;
      const gstPct = parseFloat(updates.gstPercentage ?? existing.rows[0].gst_percentage) || 0;
      const totalValue = cValue + (cValue * (gstPct / 100));
      setClauses.push(`total_value = $${idx++}`);
      values.push(totalValue);
    }

    values.push(req.params.id);
    await query(
      `UPDATE amc_contracts SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      values
    );

    await addTimelineEntry(req.params.id, 'contract_updated', 'AMC Contract Updated', 'Contract details were updated', req.user.full_name);

    const updated = await query('SELECT * FROM amc_contracts WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'AMC contract updated successfully', data: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/amc/contracts/:id - Soft delete
router.delete('/contracts/:id', authenticate, async (req, res, next) => {
  try {
    await query('UPDATE amc_contracts SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'AMC contract deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// GET /api/amc/visits - List visits
router.get('/visits', authenticate, async (req, res, next) => {
  try {
    const { contractId, engineerId, status, date, page = 1, limit = 50 } = req.query;
    let whereClause = 'WHERE v.is_active = true';
    const params = [];

    if (contractId) { whereClause += ` AND v.contract_id = $${params.length + 1}`; params.push(contractId); }
    if (engineerId) { whereClause += ` AND v.engineer_user_id = $${params.length + 1}`; params.push(engineerId); }
    if (status) { whereClause += ` AND v.status = $${params.length + 1}`; params.push(status); }
    if (date) { whereClause += ` AND v.visit_date = $${params.length + 1}`; params.push(date); }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countResult = await query(`SELECT COUNT(*) as total FROM amc_visits v ${whereClause}`, params);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    const dataResult = await query(
      `SELECT v.*, c.company_name, c.amc_number,
        COALESCE(json_agg(json_build_object(
          'id', img.id, 'image_url', img.image_url, 'thumbnail_url', img.thumbnail_url,
          'caption', img.caption
        )) FILTER (WHERE img.id IS NOT NULL), '[]'::json) AS images
      FROM amc_visits v
      LEFT JOIN amc_contracts c ON c.id = v.contract_id
      LEFT JOIN amc_visit_images img ON img.visit_id = v.id
      ${whereClause}
      GROUP BY v.id, c.company_name, c.amc_number
      ORDER BY v.visit_date DESC, v.visit_time DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/amc/visits/:id - Single visit
router.get('/visits/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT v.*, c.company_name, c.amc_number,
        COALESCE(json_agg(json_build_object(
          'id', img.id, 'image_url', img.image_url, 'thumbnail_url', img.thumbnail_url,
          'caption', img.caption, 'file_size', img.file_size, 'file_type', img.file_type
        )) FILTER (WHERE img.id IS NOT NULL), '[]'::json) AS images
      FROM amc_visits v
      LEFT JOIN amc_contracts c ON c.id = v.contract_id
      LEFT JOIN amc_visit_images img ON img.visit_id = v.id
      WHERE v.id = $1
      GROUP BY v.id, c.company_name, c.amc_number`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'AMC visit not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/amc/visits - Create visit
router.post('/visits', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const month = MONTHS[new Date().getMonth()];
    const year = new Date().getFullYear();
    const prefix = `VIS-${year}-${month}-`;
    const numResult = await client.query(
      `SELECT visit_number FROM amc_visits WHERE visit_number LIKE $1 ORDER BY id DESC LIMIT 1`,
      [`${prefix}%`]
    );
    let nextNum = 1;
    if (numResult.rows.length > 0) {
      const parts = numResult.rows[0].visit_number.split('-');
      const lastNum = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }
    const visitNumber = `${prefix}${String(nextNum).padStart(4, '0')}`;

    const {
      contractId, title, description, visitDate, visitTime, visitEndTime,
      engineerName, engineerUserId, visitType = 'Routine',
      issuesFound, workPerformed, sparePartsUsed, recommendations,
      customerRemarks, notes, customerSignature, gpsLocation, nextVisitDate,
      status = 'Completed', images = []
    } = req.body;

    const result = await client.query(
      `INSERT INTO amc_visits (
        contract_id, visit_number, title, description, visit_date, visit_time, visit_end_time,
        engineer_name, engineer_user_id, visit_type, issues_found, work_performed,
        spare_parts_used, recommendations, customer_remarks, notes, customer_signature,
        gps_location, next_visit_date, status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [
        contractId, visitNumber, title || null, description || null, visitDate, visitTime || null, visitEndTime || null,
        engineerName || null, engineerUserId || null, visitType,
        issuesFound || null, workPerformed || null, sparePartsUsed || null,
        recommendations || null, customerRemarks || null, notes || null, customerSignature || null,
        gpsLocation || null, nextVisitDate || null, status, req.user.full_name || 'System'
      ]
    );

    const visitId = result.rows[0].id;

    // Insert images
    if (Array.isArray(images) && images.length > 0) {
      for (const img of images) {
        await client.query(
          `INSERT INTO amc_visit_images (visit_id, image_url, thumbnail_url, caption, file_size, file_type, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [visitId, img.imageUrl, img.thumbnailUrl || null, img.caption || null, img.fileSize || 0, img.fileType || 'image/jpeg', req.user.full_name]
        );
      }
    }

    // Update contract visit counts
    await updateContractCounts(contractId);

    // Add timeline entry
    await client.query(
      `INSERT INTO amc_timeline (contract_id, event_type, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [contractId, 'visit_created', `Visit ${visitNumber} - ${visitType}`, `Engineer: ${engineerName || 'N/A'}. ${workPerformed ? 'Work: ' + workPerformed : ''}`, req.user.full_name]
    );

    await client.query('COMMIT');

    const fullVisit = await query(
      `SELECT v.*, c.company_name, c.amc_number,
        COALESCE(json_agg(json_build_object(
          'id', img.id, 'image_url', img.image_url, 'thumbnail_url', img.thumbnail_url,
          'caption', img.caption
        )) FILTER (WHERE img.id IS NOT NULL), '[]'::json) AS images
      FROM amc_visits v
      LEFT JOIN amc_contracts c ON c.id = v.contract_id
      LEFT JOIN amc_visit_images img ON img.visit_id = v.id
      WHERE v.id = $1
      GROUP BY v.id, c.company_name, c.amc_number`,
      [visitId]
    );

    // Emit socket event for real-time updates
    if (req.io) {
      req.io.emit('amc_visit_created', fullVisit.rows[0]);
    }

    res.status(201).json({ success: true, message: 'AMC visit created successfully', data: fullVisit.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/amc/visits/:id - Update visit
router.put('/visits/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await query('SELECT * FROM amc_visits WHERE id = $1 AND is_active = true', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'AMC visit not found' });
    }

    const updates = req.body;
    const fieldMapping = {
      title: 'title', description: 'description', visitDate: 'visit_date',
      visitTime: 'visit_time', visitEndTime: 'visit_end_time',
      engineerName: 'engineer_name', engineerUserId: 'engineer_user_id',
      visitType: 'visit_type', issuesFound: 'issues_found',
      workPerformed: 'work_performed', sparePartsUsed: 'spare_parts_used',
      recommendations: 'recommendations', customerRemarks: 'customer_remarks',
      notes: 'notes', customerSignature: 'customer_signature',
      gpsLocation: 'gps_location', nextVisitDate: 'next_visit_date', status: 'status'
    };

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [front, db] of Object.entries(fieldMapping)) {
      if (updates[front] !== undefined) {
        setClauses.push(`${db} = $${idx++}`);
        values.push(updates[front]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(req.params.id);
    await query(
      `UPDATE amc_visits SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      values
    );

    // Update contract counts
    await updateContractCounts(existing.rows[0].contract_id);

    const updated = await query('SELECT * FROM amc_visits WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'AMC visit updated successfully', data: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/amc/upload - Upload visit images
router.post('/upload', authenticate, async (req, res, next) => {
  try {
    const { visitId, images } = req.body;
    if (!visitId || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, message: 'Visit ID and images array are required' });
    }

    const saved = [];
    for (const img of images) {
      const result = await query(
        `INSERT INTO amc_visit_images (visit_id, image_url, thumbnail_url, caption, file_size, file_type, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [visitId, img.imageUrl, img.thumbnailUrl || null, img.caption || null, img.fileSize || 0, img.fileType || 'image/jpeg', req.user.full_name]
      );
      saved.push(result.rows[0]);
    }

    res.json({ success: true, message: 'Images uploaded successfully', data: saved });
  } catch (err) {
    next(err);
  }
});

// GET /api/amc/timeline/:contractId
router.get('/timeline/:contractId', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM amc_timeline WHERE contract_id = $1 ORDER BY created_at DESC`,
      [req.params.contractId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/amc/issues
router.get('/issues', authenticate, async (req, res, next) => {
  try {
    const { contractId, status, page = 1, limit = 50 } = req.query;
    let whereClause = 'WHERE i.is_active = true';
    const params = [];

    if (contractId) { whereClause += ` AND i.contract_id = $${params.length + 1}`; params.push(contractId); }
    if (status) { whereClause += ` AND i.status = $${params.length + 1}`; params.push(status); }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countResult = await query(`SELECT COUNT(*) as total FROM amc_issues i ${whereClause}`, params);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    const dataResult = await query(
      `SELECT i.*, c.company_name, c.amc_number
      FROM amc_issues i
      LEFT JOIN amc_contracts c ON c.id = i.contract_id
      ${whereClause}
      ORDER BY i.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/amc/issues
router.post('/issues', authenticate, async (req, res, next) => {
  try {
    const { contractId, visitId, title, description, priority = 'Medium' } = req.body;
    if (!contractId || !title) {
      return res.status(400).json({ success: false, message: 'Contract ID and title are required' });
    }

    const result = await query(
      `INSERT INTO amc_issues (contract_id, visit_id, title, description, priority, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [contractId, visitId || null, title, description || null, priority, req.user.full_name || 'System']
    );

    await addTimelineEntry(contractId, 'issue_opened', `Issue: ${title}`, description || '', req.user.full_name);

    res.status(201).json({ success: true, message: 'Issue created successfully', data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/amc/issues/:id
router.put('/issues/:id', authenticate, async (req, res, next) => {
  try {
    const { status, resolutionNotes } = req.body;
    const existing = await query('SELECT * FROM amc_issues WHERE id = $1 AND is_active = true', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Issue not found' });
    }

    if (status === 'Closed' && existing.rows[0].status !== 'Closed') {
      await query(
        `UPDATE amc_issues SET status = $1, resolved_at = NOW(), resolved_by = $2, resolution_notes = $3 WHERE id = $4`,
        [status, req.user.full_name, resolutionNotes || null, req.params.id]
      );
      await addTimelineEntry(existing.rows[0].contract_id, 'issue_closed', `Issue Closed: ${existing.rows[0].title}`, resolutionNotes || '', req.user.full_name);
    } else {
      await query(
        `UPDATE amc_issues SET status = $1, resolution_notes = COALESCE($2, resolution_notes) WHERE id = $3`,
        [status, resolutionNotes || null, req.params.id]
      );
    }

    const updated = await query('SELECT * FROM amc_issues WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Issue updated successfully', data: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/amc/my-contracts - Get contracts assigned to current user
router.get('/my-contracts', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM amc_visits WHERE contract_id = c.id AND visit_date = CURRENT_DATE AND is_active = true) as today_visits,
        (SELECT COUNT(*) FROM amc_visits WHERE contract_id = c.id AND visit_date > CURRENT_DATE AND is_active = true) as upcoming_visits,
        (SELECT COUNT(*) FROM amc_visits WHERE contract_id = c.id AND status = 'Completed' AND is_active = true) as completed_visits
      FROM amc_contracts c
      WHERE (c.assigned_user_id = $1 OR c.assigned_to ILIKE $2) AND c.is_active = true AND c.status = 'Active'
      ORDER BY c.company_name`,
      [req.user.id, `%${req.user.full_name}%`]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/amc/report/:contractId - Generate AMC Report as Excel with Charts
router.get('/report/:contractId', authenticate, async (req, res, next) => {
  try {
    const ExcelJS = require('exceljs');

    const contractId = parseInt(req.params.contractId);

    // Fetch contract details
    const contractRes = await query(
      `SELECT * FROM amc_contracts WHERE id = $1 AND is_active = true`,
      [contractId]
    );
    if (contractRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contract not found' });
    }
    const contract = contractRes.rows[0];

    // Fetch visits
    const visitsRes = await query(
      `SELECT * FROM amc_visits WHERE contract_id = $1 AND is_active = true ORDER BY visit_date DESC`,
      [contractId]
    );
    const visits = visitsRes.rows;

    // Fetch internal issues
    const issuesRes = await query(
      `SELECT * FROM amc_issues WHERE contract_id = $1 AND is_active = true ORDER BY created_at DESC`,
      [contractId]
    );
    const issues = issuesRes.rows;

    // Fetch customer issues
    const custIssuesRes = await query(
      `SELECT ci.*,
        COALESCE(json_agg(json_build_object(
          'id', img.id, 'image_url', img.image_url, 'uploaded_by', img.uploaded_by
        )) FILTER (WHERE img.id IS NOT NULL), '[]'::json) AS issue_images
      FROM amc_customer_issues ci
      LEFT JOIN amc_issue_images img ON img.issue_id = ci.id
      WHERE ci.contract_id = $1 AND ci.is_active = true
      GROUP BY ci.id
      ORDER BY ci.created_at DESC`,
      [contractId]
    );
    const customerIssues = custIssuesRes.rows;

    // Fetch timeline
    const timelineRes = await query(
      `SELECT * FROM amc_timeline WHERE contract_id = $1 ORDER BY created_at DESC`,
      [contractId]
    );
    const timeline = timelineRes.rows;

    // ── Calculate derived metrics ──
    const totalVisits = contract.total_visits || visits.length || 0;
    const completedVisits = contract.completed_visits || visits.filter(v => v.status === 'Completed').length;
    const pendingVisits = contract.pending_visits || (totalVisits - completedVisits);
    const scheduledVisits = visits.filter(v => v.status === 'Scheduled').length;
    const cancelledVisits = visits.filter(v => v.status === 'Cancelled' || v.status === 'Cancelled').length;
    const totalIssues = issues.length + customerIssues.length;
    const openIssues = issues.filter(i => i.status === 'Open').length + customerIssues.filter(i => i.status === 'Open').length;
    const inProgressIssues = issues.filter(i => i.status === 'In Progress').length + customerIssues.filter(i => i.status === 'In Progress').length;
    const resolvedIssues = issues.filter(i => i.status === 'Resolved' || i.status === 'Closed').length + customerIssues.filter(i => i.status === 'Resolved' || i.status === 'Closed').length;
    const completionRate = totalVisits > 0 ? Math.round((completedVisits / totalVisits) * 100) : 0;

    // ── Monthly visit breakdown ──
    const monthlyVisits = {};
    for (const v of visits) {
      if (v.visit_date) {
        const d = new Date(v.visit_date);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyVisits[key]) monthlyVisits[key] = { total: 0, completed: 0 };
        monthlyVisits[key].total++;
        if (v.status === 'Completed') monthlyVisits[key].completed++;
      }
    }

    // ── Priority breakdown ──
    const highPriority = issues.filter(i => i.priority === 'High' || i.priority === 'Critical').length + customerIssues.filter(i => i.priority === 'High' || i.priority === 'Critical').length;
    const mediumPriority = issues.filter(i => i.priority === 'Medium').length + customerIssues.filter(i => i.priority === 'Medium').length;
    const lowPriority = issues.filter(i => i.priority === 'Low').length + customerIssues.filter(i => i.priority === 'Low').length;

    // Create Excel workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'CRS Software';
    workbook.created = new Date();

    // ── Style constants ──
    const primaryBlue = 'FF1565C0';
    const darkBlue = 'FF0D47A1';
    const lightBlue = 'FFE3F2FD';
    const successGreen = 'FF2E7D32';
    const lightGreen = 'FFE8F5E9';
    const warningOrange = 'FFF57C00';
    const lightOrange = 'FFFFF3E0';
    const errorRed = 'FFD32F2F';
    const lightRed = 'FFFFEBEE';
    const white = 'FFFFFFFF';
    const grey50 = 'FFFAFAFA';
    const grey100 = 'FFF5F5F5';
    const grey200 = 'FFEEEEEE';
    const grey400 = 'FFBDBDBD';
    const grey600 = 'FF757575';
    const grey800 = 'FF424242';

    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    const headerFont = { bold: true, color: { argb: white }, size: 11 };
    const subHeaderFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lightBlue } };
    const subHeaderFont = { bold: true, color: { argb: primaryBlue }, size: 10 };
    const borderStyle = { style: 'thin', color: { argb: grey400 } };
    const borders = { top: borderStyle, left: borderStyle, bottom: borderStyle, right: borderStyle };
    const noBorder = { top: { style: 'none' }, left: { style: 'none' }, bottom: { style: 'none' }, right: { style: 'none' } };
    const labelFont = { bold: true, size: 10, color: { argb: grey600 } };
    const valueFont = { size: 10, bold: true, color: { argb: grey800 } };

    function formatDate(d) {
      if (!d) return '—';
      try {
        return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      } catch { return '—'; }
    }

    function formatDateTime(d) {
      if (!d) return '—';
      try {
        return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch { return '—'; }
    }

    function currencyFormat(val) {
      const num = parseFloat(val || 0);
      return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    // ══════════════════════════════════════════════════════════
    // SHEET 1: EXECUTIVE SUMMARY
    // ══════════════════════════════════════════════════════════
    const ws1 = workbook.addWorksheet('Executive Summary', { properties: { defaultColWidth: 18 } });

    // Title banner
    ws1.mergeCells('A1:H1');
    ws1.getCell('A1').value = 'ANNUAL MAINTENANCE CONTRACT REPORT';
    ws1.getCell('A1').font = { bold: true, size: 20, color: { argb: white } };
    ws1.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws1.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: darkBlue } };
    ws1.getRow(1).height = 42;

    ws1.mergeCells('A2:H2');
    ws1.getCell('A2').value = `${contract.company_name}  |  ${contract.amc_number}  |  ${contract.contract_type || 'Standard'} AMC`;
    ws1.getCell('A2').font = { bold: true, size: 12, color: { argb: primaryBlue } };
    ws1.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    ws1.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lightBlue } };
    ws1.getRow(2).height = 28;

    ws1.mergeCells('A3:H3');
    ws1.getCell('A3').value = `Report Generated: ${new Date().toLocaleString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    ws1.getCell('A3').font = { size: 9, italic: true, color: { argb: grey600 } };
    ws1.getCell('A3').alignment = { horizontal: 'center' };

    // ── Key Metrics Cards (Row 5-7) ──
    let row = 5;
    ws1.mergeCells(`A${row}:H${row}`);
    ws1.getCell(`A${row}`).value = 'KEY METRICS';
    ws1.getCell(`A${row}`).font = { bold: true, size: 13, color: { argb: white } };
    ws1.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws1.getCell(`A${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    ws1.getRow(row).height = 28;
    row++;

    // Metric cards row 1
    const metricCards = [
      { label: 'Contract Value', value: currencyFormat(contract.contract_value), color: primaryBlue, bg: lightBlue },
      { label: 'Total Value (with GST)', value: currencyFormat(contract.total_value), color: successGreen, bg: lightGreen },
      { label: 'Contract Status', value: contract.status || 'Active', color: contract.status === 'Active' ? successGreen : warningOrange, bg: contract.status === 'Active' ? lightGreen : lightOrange },
      { label: 'Completion Rate', value: `${completionRate}%`, color: completionRate >= 75 ? successGreen : completionRate >= 50 ? warningOrange : errorRed, bg: completionRate >= 75 ? lightGreen : completionRate >= 50 ? lightOrange : lightRed },
    ];

    for (const mc of metricCards) {
      const col = metricCards.indexOf(mc);
      const colStart = String.fromCharCode(65 + col * 2);
      const colEnd = String.fromCharCode(66 + col * 2);
      ws1.mergeCells(`${colStart}${row}:${colEnd}${row}`);
      ws1.getCell(`${colStart}${row}`).value = mc.value;
      ws1.getCell(`${colStart}${row}`).font = { bold: true, size: 14, color: { argb: mc.color } };
      ws1.getCell(`${colStart}${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
      ws1.getCell(`${colStart}${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: mc.bg } };
      ws1.getCell(`${colStart}${row}`).border = { bottom: { style: 'medium', color: { argb: mc.color } } };
    }
    ws1.getRow(row).height = 32;
    row++;

    // Labels for metric cards
    for (const mc of metricCards) {
      const col = metricCards.indexOf(mc);
      const colStart = String.fromCharCode(65 + col * 2);
      const colEnd = String.fromCharCode(66 + col * 2);
      ws1.mergeCells(`${colStart}${row}:${colEnd}${row}`);
      ws1.getCell(`${colStart}${row}`).value = mc.label;
      ws1.getCell(`${colStart}${row}`).font = { size: 9, color: { argb: grey600 } };
      ws1.getCell(`${colStart}${row}`).alignment = { horizontal: 'center', vertical: 'middle' };
    }
    ws1.getRow(row).height = 18;
    row++;

    // ── Visit Progress (Data Bar Chart) ──
    row++;
    ws1.mergeCells(`A${row}:H${row}`);
    ws1.getCell(`A${row}`).value = 'VISIT PROGRESS';
    ws1.getCell(`A${row}`).font = { bold: true, size: 12, color: { argb: white } };
    ws1.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws1.getRow(row).height = 26;
    row++;

    const visitProgressData = [
      ['Completed Visits', completedVisits, successGreen, lightGreen],
      ['Pending Visits', pendingVisits, warningOrange, lightOrange],
      ['Scheduled Visits', scheduledVisits, primaryBlue, lightBlue],
      ['Total Visits', totalVisits, grey800, grey100],
    ];

    for (const [label, value, color, bg] of visitProgressData) {
      ws1.getCell(`A${row}`).value = label;
      ws1.getCell(`A${row}`).font = { bold: true, size: 10, color: { argb: grey800 } };
      ws1.getCell(`A${row}`).border = borders;

      ws1.getCell(`B${row}`).value = value;
      ws1.getCell(`B${row}`).font = { bold: true, size: 11, color: { argb: color } };
      ws1.getCell(`B${row}`).alignment = { horizontal: 'center' };
      ws1.getCell(`B${row}`).border = borders;

      // Percentage bar columns
      const maxVal = Math.max(totalVisits, 1);
      const pct = Math.round((value / maxVal) * 100);
      ws1.getCell(`C${row}`).value = pct;
      ws1.getCell(`C${row}`).font = { size: 9, color: { argb: grey600 } };
      ws1.getCell(`C${row}`).alignment = { horizontal: 'right' };
      ws1.getCell(`C${row}`).border = borders;
      ws1.getCell(`C${row}`).numFmt = '0"%"';

      // Bar visual (using a string of blocks)
      const barLength = Math.round(pct / 5);
      const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength);
      ws1.mergeCells(`D${row}:H${row}`);
      ws1.getCell(`D${row}`).value = bar;
      ws1.getCell(`D${row}`).font = { size: 10, color: { argb: color } };
      ws1.getCell(`D${row}`).border = borders;

      ws1.getRow(row).height = 22;
      row++;
    }

    // Add ExcelJS data bar conditional formatting for the values
    ws1.addConditionalFormatting({
      ref: `B${row - 4}:B${row - 1}`,
      rules: [
        {
          type: 'dataBar',
          priority: 1,
          dataBar: {
            color: { argb: primaryBlue },
            showValue: true,
            minLength: 0,
            maxLength: 100,
          },
        },
      ],
    });

    // ── Contract Details ──
    row++;
    ws1.mergeCells(`A${row}:H${row}`);
    ws1.getCell(`A${row}`).value = 'CONTRACT DETAILS';
    ws1.getCell(`A${row}`).font = { bold: true, size: 12, color: { argb: white } };
    ws1.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws1.getRow(row).height = 26;
    row++;

    const contractFields = [
      ['AMC Number', contract.amc_number, 'Contract Type', contract.contract_type],
      ['Company Name', contract.company_name, 'Contact Person', contract.contact_person || '—'],
      ['Mobile', contract.mobile || '—', 'Email', contract.email || '—'],
      ['Address', contract.address || '—', '', ''],
      ['Start Date', formatDate(contract.start_date), 'End Date', formatDate(contract.end_date)],
      ['Renewal Date', formatDate(contract.renewal_date), 'Status', contract.status],
      ['Billing Cycle', contract.billing_cycle || '—', 'Assigned To', contract.assigned_to || '—'],
    ];

    for (const [label1, val1, label2, val2] of contractFields) {
      if (label1) {
        ws1.getCell(`A${row}`).value = label1;
        ws1.getCell(`A${row}`).font = labelFont;
        ws1.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grey100 } };
        ws1.getCell(`A${row}`).border = borders;
        ws1.mergeCells(`A${row}:B${row}`);
      }
      if (label2) {
        ws1.getCell(`C${row}`).value = val1;
        ws1.getCell(`C${row}`).font = valueFont;
        ws1.getCell(`C${row}`).border = borders;
        ws1.mergeCells(`C${row}:D${row}`);

        ws1.getCell(`E${row}`).value = label2;
        ws1.getCell(`E${row}`).font = labelFont;
        ws1.getCell(`E${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grey100 } };
        ws1.getCell(`E${row}`).border = borders;
        ws1.mergeCells(`E${row}:F${row}`);

        ws1.getCell(`G${row}`).value = val2;
        ws1.getCell(`G${row}`).font = valueFont;
        ws1.getCell(`G${row}`).border = borders;
        ws1.mergeCells(`G${row}:H${row}`);
      } else {
        ws1.getCell(`C${row}`).value = val1;
        ws1.getCell(`C${row}`).font = valueFont;
        ws1.getCell(`C${row}`).border = borders;
        ws1.mergeCells(`C${row}:H${row}`);
      }
      ws1.getRow(row).height = 22;
      row++;
    }

    // ── Financial Summary ──
    row++;
    ws1.mergeCells(`A${row}:H${row}`);
    ws1.getCell(`A${row}`).value = 'FINANCIAL SUMMARY';
    ws1.getCell(`A${row}`).font = { bold: true, size: 12, color: { argb: white } };
    ws1.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws1.getRow(row).height = 26;
    row++;

    const finData = [
      ['Contract Value', currencyFormat(contract.contract_value)],
      ['GST Percentage', `${contract.gst_percentage || 0}%`],
      ['GST Amount', currencyFormat((parseFloat(contract.contract_value || 0) * (parseFloat(contract.gst_percentage || 0) / 100)))],
      ['Total Value (incl. GST)', currencyFormat(contract.total_value)],
    ];

    for (const [label, value] of finData) {
      ws1.getCell(`A${row}`).value = label;
      ws1.getCell(`A${row}`).font = labelFont;
      ws1.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grey100 } };
      ws1.getCell(`A${row}`).border = borders;
      ws1.mergeCells(`A${row}:D${row}`);

      ws1.getCell(`E${row}`).value = value;
      ws1.getCell(`E${row}`).font = { bold: true, size: 11, color: { argb: primaryBlue } };
      ws1.getCell(`E${row}`).alignment = { horizontal: 'right' };
      ws1.getCell(`E${row}`).border = borders;
      ws1.mergeCells(`E${row}:H${row}`);

      ws1.getRow(row).height = 22;
      row++;
    }

    // Description
    if (contract.description) {
      row++;
      ws1.mergeCells(`A${row}:H${row}`);
      ws1.getCell(`A${row}`).value = 'DESCRIPTION';
      ws1.getCell(`A${row}`).font = { bold: true, size: 11, color: { argb: white } };
      ws1.getCell(`A${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
      ws1.getRow(row).height = 24;
      row++;

      ws1.mergeCells(`A${row}:H${row}`);
      ws1.getCell(`A${row}`).value = contract.description;
      ws1.getCell(`A${row}`).font = { size: 10, color: { argb: grey800 } };
      ws1.getCell(`A${row}`).alignment = { wrapText: true, vertical: 'top' };
      ws1.getRow(row).height = 40;
    }

    ws1.columns = [
      { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
      { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }
    ];

    // ══════════════════════════════════════════════════════════
    // SHEET 2: VISIT HISTORY
    // ══════════════════════════════════════════════════════════
    const ws2 = workbook.addWorksheet('Visit History', { properties: { defaultColWidth: 16 } });

    ws2.mergeCells('A1:I1');
    ws2.getCell('A1').value = `VISIT HISTORY — ${contract.company_name}`;
    ws2.getCell('A1').font = { bold: true, size: 14, color: { argb: white } };
    ws2.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws2.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: darkBlue } };
    ws2.getRow(1).height = 32;

    // Visit summary row
    ws2.mergeCells('A2:I2');
    ws2.getCell('A2').value = `Total: ${visits.length} visits  |  Completed: ${completedVisits}  |  Scheduled: ${scheduledVisits}  |  Completion Rate: ${completionRate}%`;
    ws2.getCell('A2').font = { size: 10, italic: true, color: { argb: primaryBlue } };
    ws2.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lightBlue } };
    ws2.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    ws2.getRow(2).height = 22;

    const visitHeaders = ['Visit #', 'Date', 'Time', 'Engineer', 'Type', 'Status', 'Issues Found', 'Work Performed', 'Progress'];
    const visitHeaderRow = ws2.addRow(visitHeaders);
    visitHeaderRow.eachCell(cell => {
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.border = borders;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws2.getRow(3).height = 28;

    const statusColors = {
      'Completed': { font: successGreen, bg: lightGreen },
      'Scheduled': { font: primaryBlue, bg: lightBlue },
      'In Progress': { font: warningOrange, bg: lightOrange },
      'Cancelled': { font: errorRed, bg: lightRed },
    };

    let visitDataStartRow = 4;
    if (visits.length === 0) {
      ws2.mergeCells('A5:I5');
      ws2.getCell('A5').value = 'No visits recorded yet';
      ws2.getCell('A5').font = { italic: true, color: { argb: grey600 } };
      ws2.getCell('A5').alignment = { horizontal: 'center' };
    } else {
      for (let i = 0; i < visits.length; i++) {
        const v = visits[i];
        const statusStyle = statusColors[v.status] || { font: grey800, bg: grey100 };
        const progressPct = v.status === 'Completed' ? 100 : v.status === 'In Progress' ? 50 : v.status === 'Scheduled' ? 0 : 0;
        const barLen = Math.round(progressPct / 10);
        const progressBar = v.status === 'Completed' ? '█'.repeat(10) : v.status === 'In Progress' ? '█'.repeat(5) + '░'.repeat(5) : '░'.repeat(10);

        const vr = ws2.addRow([
          v.visit_number || `V-${i + 1}`,
          formatDate(v.visit_date),
          v.visit_time || '—',
          v.engineer_name || '—',
          v.visit_type || '—',
          v.status,
          v.issues_found || '—',
          v.work_performed || '—',
          progressPct,
        ]);

        vr.eachCell((cell, colNum) => {
          cell.border = borders;
          cell.alignment = { vertical: 'top', wrapText: true };
          cell.font = { size: 10 };
          // Alternate row shading
          if (i % 2 === 1) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grey50 } };
          }
        });

        // Color-code status cell
        vr.getCell(6).font = { size: 10, color: { argb: statusStyle.font }, bold: true };
        vr.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusStyle.bg } };
        vr.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };

        // Progress column
        vr.getCell(9).alignment = { horizontal: 'center', vertical: 'middle' };
        vr.getCell(9).numFmt = '0"%"';
        if (v.status === 'Completed') {
          vr.getCell(9).font = { size: 10, color: { argb: successGreen }, bold: true };
        }
      }

      // Add data bar to progress column
      ws2.addConditionalFormatting({
        ref: `I${visitDataStartRow}:I${visitDataStartRow + visits.length - 1}`,
        rules: [
          {
            type: 'dataBar',
            priority: 2,
            dataBar: {
              color: { argb: successGreen },
              showValue: true,
              minLength: 0,
              maxLength: 100,
            },
          },
        ],
      });
    }

    ws2.columns = [
      { width: 10 }, { width: 14 }, { width: 10 }, { width: 18 },
      { width: 12 }, { width: 14 }, { width: 22 }, { width: 28 }, { width: 12 }
    ];

    // Auto-filter
    if (visits.length > 0) {
      ws2.autoFilter = `A3:I${visitDataStartRow + visits.length - 1}`;
    }

    // ══════════════════════════════════════════════════════════
    // SHEET 3: ISSUES REPORT
    // ══════════════════════════════════════════════════════════
    const ws3 = workbook.addWorksheet('Issues Report', { properties: { defaultColWidth: 16 } });

    ws3.mergeCells('A1:H1');
    ws3.getCell('A1').value = `ISSUES REPORT — ${contract.company_name}`;
    ws3.getCell('A1').font = { bold: true, size: 14, color: { argb: white } };
    ws3.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws3.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: darkBlue } };
    ws3.getRow(1).height = 32;

    // Issue summary bar
    ws3.mergeCells('A2:H2');
    ws3.getCell('A2').value = `Total Issues: ${totalIssues}  |  Open: ${openIssues}  |  In Progress: ${inProgressIssues}  |  Resolved: ${resolvedIssues}  |  High Priority: ${highPriority}`;
    ws3.getCell('A2').font = { size: 10, italic: true, color: { argb: primaryBlue } };
    ws3.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lightBlue } };
    ws3.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    ws3.getRow(2).height = 22;

    // ── Issue Priority Distribution (Chart Data) ──
    let issueRow = 4;
    ws3.mergeCells(`A${issueRow}:H${issueRow}`);
    ws3.getCell(`A${issueRow}`).value = 'ISSUE PRIORITY DISTRIBUTION';
    ws3.getCell(`A${issueRow}`).font = { bold: true, size: 11, color: { argb: white } };
    ws3.getCell(`A${issueRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws3.getRow(issueRow).height = 24;
    issueRow++;

    const priorityData = [
      ['High / Critical', highPriority, errorRed, lightRed],
      ['Medium', mediumPriority, warningOrange, lightOrange],
      ['Low', lowPriority, successGreen, lightGreen],
    ];

    for (const [label, value, color, bg] of priorityData) {
      ws3.getCell(`A${issueRow}`).value = label;
      ws3.getCell(`A${issueRow}`).font = { bold: true, size: 10, color: { argb: color } };
      ws3.getCell(`A${issueRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      ws3.getCell(`A${issueRow}`).border = borders;
      ws3.mergeCells(`A${issueRow}:C${issueRow}`);

      ws3.getCell(`D${issueRow}`).value = value;
      ws3.getCell(`D${issueRow}`).font = { bold: true, size: 11, color: { argb: color } };
      ws3.getCell(`D${issueRow}`).alignment = { horizontal: 'center' };
      ws3.getCell(`D${issueRow}`).border = borders;

      const maxIssue = Math.max(highPriority, mediumPriority, lowPriority, 1);
      const pct = Math.round((value / maxIssue) * 100);
      const barLen = Math.round(pct / 5);
      const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
      ws3.mergeCells(`E${issueRow}:H${issueRow}`);
      ws3.getCell(`E${issueRow}`).value = bar;
      ws3.getCell(`E${issueRow}`).font = { size: 10, color: { argb: color } };
      ws3.getCell(`E${issueRow}`).border = borders;

      ws3.getRow(issueRow).height = 22;
      issueRow++;
    }

    // Add data bar for priority values
    ws3.addConditionalFormatting({
      ref: `D${issueRow - 3}:D${issueRow - 1}`,
      rules: [
        {
          type: 'dataBar',
          priority: 3,
          dataBar: {
            color: { argb: primaryBlue },
            showValue: true,
            minLength: 0,
            maxLength: 100,
          },
        },
      ],
    });

    // ── Issue Status Distribution (Chart Data) ──
    issueRow += 2;
    ws3.mergeCells(`A${issueRow}:H${issueRow}`);
    ws3.getCell(`A${issueRow}`).value = 'ISSUE STATUS DISTRIBUTION';
    ws3.getCell(`A${issueRow}`).font = { bold: true, size: 11, color: { argb: white } };
    ws3.getCell(`A${issueRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws3.getRow(issueRow).height = 24;
    issueRow++;

    const statusData = [
      ['Open', openIssues, errorRed, lightRed],
      ['In Progress', inProgressIssues, warningOrange, lightOrange],
      ['Resolved / Closed', resolvedIssues, successGreen, lightGreen],
    ];

    for (const [label, value, color, bg] of statusData) {
      ws3.getCell(`A${issueRow}`).value = label;
      ws3.getCell(`A${issueRow}`).font = { bold: true, size: 10, color: { argb: color } };
      ws3.getCell(`A${issueRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      ws3.getCell(`A${issueRow}`).border = borders;
      ws3.mergeCells(`A${issueRow}:C${issueRow}`);

      ws3.getCell(`D${issueRow}`).value = value;
      ws3.getCell(`D${issueRow}`).font = { bold: true, size: 11, color: { argb: color } };
      ws3.getCell(`D${issueRow}`).alignment = { horizontal: 'center' };
      ws3.getCell(`D${issueRow}`).border = borders;

      const maxStatus = Math.max(openIssues, inProgressIssues, resolvedIssues, 1);
      const pct = Math.round((value / maxStatus) * 100);
      const barLen = Math.round(pct / 5);
      const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
      ws3.mergeCells(`E${issueRow}:H${issueRow}`);
      ws3.getCell(`E${issueRow}`).value = bar;
      ws3.getCell(`E${issueRow}`).font = { size: 10, color: { argb: color } };
      ws3.getCell(`E${issueRow}`).border = borders;

      ws3.getRow(issueRow).height = 22;
      issueRow++;
    }

    ws3.addConditionalFormatting({
      ref: `D${issueRow - 3}:D${issueRow - 1}`,
      rules: [
        {
          type: 'dataBar',
          priority: 4,
          dataBar: {
            color: { argb: primaryBlue },
            showValue: true,
            minLength: 0,
            maxLength: 100,
          },
        },
      ],
    });

    // ── Internal Issues ──
    issueRow += 2;
    ws3.mergeCells(`A${issueRow}:H${issueRow}`);
    ws3.getCell(`A${issueRow}`).value = `INTERNAL ISSUES (${issues.length})`;
    ws3.getCell(`A${issueRow}`).font = { bold: true, size: 11, color: { argb: white } };
    ws3.getCell(`A${issueRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws3.getRow(issueRow).height = 24;
    issueRow++;

    const intIssueHeaders = ['#', 'Title', 'Description', 'Priority', 'Status', 'Created At', 'Created By', ''];
    const intHeaderRow = ws3.addRow(intIssueHeaders);
    intHeaderRow.eachCell(cell => {
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.border = borders;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    if (issues.length === 0) {
      ws3.addRow(['—', 'No internal issues recorded', '', '', '', '', '', '']);
    } else {
      for (let idx = 0; idx < issues.length; idx++) {
        const i = issues[idx];
        const prColor = (i.priority === 'High' || i.priority === 'Critical') ? errorRed : i.priority === 'Medium' ? warningOrange : successGreen;
        const stColor = i.status === 'Open' ? errorRed : i.status === 'In Progress' ? primaryBlue : successGreen;

        const ir = ws3.addRow([
          idx + 1, i.title, i.description || '—', i.priority, i.status,
          formatDateTime(i.created_at), i.created_by || '—', ''
        ]);
        ir.eachCell((cell, colNum) => {
          cell.border = borders;
          cell.alignment = { vertical: 'top', wrapText: true };
          cell.font = { size: 10 };
          if (idx % 2 === 1) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grey50 } };
          }
        });
        // Color-code priority
        ir.getCell(4).font = { size: 10, color: { argb: prColor }, bold: true };
        ir.getCell(4).alignment = { horizontal: 'center', vertical: 'middle' };
        // Color-code status
        ir.getCell(5).font = { size: 10, color: { argb: stColor }, bold: true };
        ir.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
      }
    }

    // ── Customer Issues ──
    issueRow = ws3.lastRow.number + 2;
    ws3.mergeCells(`A${issueRow}:H${issueRow}`);
    ws3.getCell(`A${issueRow}`).value = `CUSTOMER-REPORTED ISSUES (${customerIssues.length})`;
    ws3.getCell(`A${issueRow}`).font = { bold: true, size: 11, color: { argb: white } };
    ws3.getCell(`A${issueRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws3.getRow(issueRow).height = 24;
    issueRow++;

    const custHeaders = ['#', 'Issue ID', 'Title', 'Description', 'Priority', 'Status', 'Created At', 'Assigned To'];
    const custHeaderRow = ws3.addRow(custHeaders);
    custHeaderRow.eachCell(cell => {
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.border = borders;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    if (customerIssues.length === 0) {
      ws3.addRow(['—', '—', 'No customer issues recorded', '', '', '', '', '']);
    } else {
      for (let idx = 0; idx < customerIssues.length; idx++) {
        const ci = customerIssues[idx];
        const prColor = (ci.priority === 'High' || ci.priority === 'Critical') ? errorRed : ci.priority === 'Medium' ? warningOrange : successGreen;
        const stColor = ci.status === 'Open' ? errorRed : ci.status === 'In Progress' ? primaryBlue : successGreen;

        const cr = ws3.addRow([
          idx + 1, ci.issue_number || '—', ci.title, ci.description || '—', ci.priority, ci.status,
          formatDateTime(ci.created_at), ci.assigned_to_name || 'Unassigned'
        ]);
        cr.eachCell((cell, colNum) => {
          cell.border = borders;
          cell.alignment = { vertical: 'top', wrapText: true };
          cell.font = { size: 10 };
          if (idx % 2 === 1) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grey50 } };
          }
        });
        cr.getCell(5).font = { size: 10, color: { argb: prColor }, bold: true };
        cr.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
        cr.getCell(6).font = { size: 10, color: { argb: stColor }, bold: true };
        cr.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
      }
    }

    ws3.columns = [
      { width: 6 }, { width: 14 }, { width: 22 }, { width: 28 },
      { width: 12 }, { width: 14 }, { width: 20 }, { width: 18 }
    ];

    // ══════════════════════════════════════════════════════════
    // SHEET 4: DASHBOARD (Charts & Analytics)
    // ══════════════════════════════════════════════════════════
    const ws4 = workbook.addWorksheet('Dashboard', { properties: { defaultColWidth: 14 } });

    ws4.mergeCells('A1:H1');
    ws4.getCell('A1').value = `ANALYTICS DASHBOARD — ${contract.company_name}`;
    ws4.getCell('A1').font = { bold: true, size: 14, color: { argb: white } };
    ws4.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws4.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: darkBlue } };
    ws4.getRow(1).height = 32;

    // ── Visit Status Chart ──
    let dashRow = 3;
    ws4.mergeCells(`A${dashRow}:D${dashRow}`);
    ws4.getCell(`A${dashRow}`).value = 'VISIT STATUS BREAKDOWN';
    ws4.getCell(`A${dashRow}`).font = { bold: true, size: 11, color: { argb: white } };
    ws4.getCell(`A${dashRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws4.getRow(dashRow).height = 24;
    dashRow++;

    // Headers
    ['Status', 'Count', 'Percentage', 'Visual'].forEach((h, i) => {
      ws4.getCell(dashRow, i + 1).value = h;
      ws4.getCell(dashRow, i + 1).font = { bold: true, size: 10, color: { argb: white } };
      ws4.getCell(dashRow, i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
      ws4.getCell(dashRow, i + 1).border = borders;
      ws4.getCell(dashRow, i + 1).alignment = { horizontal: 'center' };
    });
    dashRow++;

    const visitStatusData = [
      ['Completed', completedVisits, successGreen, lightGreen],
      ['Scheduled', scheduledVisits, primaryBlue, lightBlue],
      ['Pending', pendingVisits, warningOrange, lightOrange],
      ['Total', totalVisits, grey800, grey100],
    ];

    const dashDataStartRow = dashRow;
    for (const [status, count, color, bg] of visitStatusData) {
      ws4.getCell(`A${dashRow}`).value = status;
      ws4.getCell(`A${dashRow}`).font = { bold: true, size: 10, color: { argb: color } };
      ws4.getCell(`A${dashRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      ws4.getCell(`A${dashRow}`).border = borders;

      ws4.getCell(`B${dashRow}`).value = count;
      ws4.getCell(`B${dashRow}`).font = { bold: true, size: 11, color: { argb: color } };
      ws4.getCell(`B${dashRow}`).alignment = { horizontal: 'center' };
      ws4.getCell(`B${dashRow}`).border = borders;

      const pct = totalVisits > 0 ? Math.round((count / totalVisits) * 100) : 0;
      ws4.getCell(`C${dashRow}`).value = pct;
      ws4.getCell(`C${dashRow}`).font = { size: 10, color: { argb: grey800 } };
      ws4.getCell(`C${dashRow}`).alignment = { horizontal: 'center' };
      ws4.getCell(`C${dashRow}`).border = borders;
      ws4.getCell(`C${dashRow}`).numFmt = '0"%"';

      // Visual bar
      const barLen = Math.round(pct / 5);
      const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
      ws4.getCell(`D${dashRow}`).value = bar;
      ws4.getCell(`D${dashRow}`).font = { size: 10, color: { argb: color } };
      ws4.getCell(`D${dashRow}`).border = borders;

      ws4.getRow(dashRow).height = 22;
      dashRow++;
    }

    // Data bars on the count column
    ws4.addConditionalFormatting({
      ref: `B${dashDataStartRow}:B${dashDataStartRow + 3}`,
      rules: [
        {
          type: 'dataBar',
          priority: 5,
          dataBar: {
            color: { argb: primaryBlue },
            showValue: true,
            minLength: 0,
            maxLength: 100,
          },
        },
      ],
    });

    // ── Issue Status Chart ──
    dashRow += 2;
    ws4.mergeCells(`A${dashRow}:D${dashRow}`);
    ws4.getCell(`A${dashRow}`).value = 'ISSUE STATUS BREAKDOWN';
    ws4.getCell(`A${dashRow}`).font = { bold: true, size: 11, color: { argb: white } };
    ws4.getCell(`A${dashRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
    ws4.getRow(dashRow).height = 24;
    dashRow++;

    ['Status', 'Count', 'Percentage', 'Visual'].forEach((h, i) => {
      ws4.getCell(dashRow, i + 1).value = h;
      ws4.getCell(dashRow, i + 1).font = { bold: true, size: 10, color: { argb: white } };
      ws4.getCell(dashRow, i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
      ws4.getCell(dashRow, i + 1).border = borders;
      ws4.getCell(dashRow, i + 1).alignment = { horizontal: 'center' };
    });
    dashRow++;

    const issueStatusData = [
      ['Open', openIssues, errorRed, lightRed],
      ['In Progress', inProgressIssues, warningOrange, lightOrange],
      ['Resolved / Closed', resolvedIssues, successGreen, lightGreen],
      ['Total', totalIssues, grey800, grey100],
    ];

    const issueDashStartRow = dashRow;
    for (const [status, count, color, bg] of issueStatusData) {
      ws4.getCell(`A${dashRow}`).value = status;
      ws4.getCell(`A${dashRow}`).font = { bold: true, size: 10, color: { argb: color } };
      ws4.getCell(`A${dashRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      ws4.getCell(`A${dashRow}`).border = borders;

      ws4.getCell(`B${dashRow}`).value = count;
      ws4.getCell(`B${dashRow}`).font = { bold: true, size: 11, color: { argb: color } };
      ws4.getCell(`B${dashRow}`).alignment = { horizontal: 'center' };
      ws4.getCell(`B${dashRow}`).border = borders;

      const pct = totalIssues > 0 ? Math.round((count / totalIssues) * 100) : 0;
      ws4.getCell(`C${dashRow}`).value = pct;
      ws4.getCell(`C${dashRow}`).font = { size: 10, color: { argb: grey800 } };
      ws4.getCell(`C${dashRow}`).alignment = { horizontal: 'center' };
      ws4.getCell(`C${dashRow}`).border = borders;
      ws4.getCell(`C${dashRow}`).numFmt = '0"%"';

      const barLen = Math.round(pct / 5);
      const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
      ws4.getCell(`D${dashRow}`).value = bar;
      ws4.getCell(`D${dashRow}`).font = { size: 10, color: { argb: color } };
      ws4.getCell(`D${dashRow}`).border = borders;

      ws4.getRow(dashRow).height = 22;
      dashRow++;
    }

    ws4.addConditionalFormatting({
      ref: `B${issueDashStartRow}:B${issueDashStartRow + 3}`,
      rules: [
        {
          type: 'dataBar',
          priority: 6,
          dataBar: {
            color: { argb: warningOrange },
            showValue: true,
            minLength: 0,
            maxLength: 100,
          },
        },
      ],
    });

    // ── Monthly Visit Trends ──
    const monthKeys = Object.keys(monthlyVisits).sort();
    if (monthKeys.length > 0) {
      dashRow += 2;
      ws4.mergeCells(`A${dashRow}:D${dashRow}`);
      ws4.getCell(`A${dashRow}`).value = 'MONTHLY VISIT TRENDS';
      ws4.getCell(`A${dashRow}`).font = { bold: true, size: 11, color: { argb: white } };
      ws4.getCell(`A${dashRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
      ws4.getRow(dashRow).height = 24;
      dashRow++;

      ['Month', 'Total Visits', 'Completed', 'Completion Rate'].forEach((h, i) => {
        ws4.getCell(dashRow, i + 1).value = h;
        ws4.getCell(dashRow, i + 1).font = { bold: true, size: 10, color: { argb: white } };
        ws4.getCell(dashRow, i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: primaryBlue } };
        ws4.getCell(dashRow, i + 1).border = borders;
        ws4.getCell(dashRow, i + 1).alignment = { horizontal: 'center' };
      });
      dashRow++;

      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthlyStartRow = dashRow;
      for (const mk of monthKeys) {
        const [yr, mo] = mk.split('-');
        const mData = monthlyVisits[mk];
        const mPct = mData.total > 0 ? Math.round((mData.completed / mData.total) * 100) : 0;

        ws4.getCell(`A${dashRow}`).value = `${monthNames[parseInt(mo) - 1]} ${yr}`;
        ws4.getCell(`A${dashRow}`).font = { size: 10, bold: true, color: { argb: grey800 } };
        ws4.getCell(`A${dashRow}`).border = borders;

        ws4.getCell(`B${dashRow}`).value = mData.total;
        ws4.getCell(`B${dashRow}`).font = { size: 10, color: { argb: primaryBlue }, bold: true };
        ws4.getCell(`B${dashRow}`).alignment = { horizontal: 'center' };
        ws4.getCell(`B${dashRow}`).border = borders;

        ws4.getCell(`C${dashRow}`).value = mData.completed;
        ws4.getCell(`C${dashRow}`).font = { size: 10, color: { argb: successGreen }, bold: true };
        ws4.getCell(`C${dashRow}`).alignment = { horizontal: 'center' };
        ws4.getCell(`C${dashRow}`).border = borders;

        ws4.getCell(`D${dashRow}`).value = mPct;
        ws4.getCell(`D${dashRow}`).font = { size: 10, color: { argb: grey800 } };
        ws4.getCell(`D${dashRow}`).alignment = { horizontal: 'center' };
        ws4.getCell(`D${dashRow}`).border = borders;
        ws4.getCell(`D${dashRow}`).numFmt = '0"%"';

        ws4.getRow(dashRow).height = 20;
        dashRow++;
      }

      // Data bar for monthly visits
      ws4.addConditionalFormatting({
        ref: `B${monthlyStartRow}:B${monthlyStartRow + monthKeys.length - 1}`,
        rules: [
          {
            type: 'dataBar',
            priority: 7,
            dataBar: {
              color: { argb: primaryBlue },
              showValue: true,
              minLength: 0,
              maxLength: 100,
            },
          },
        ],
      });

      ws4.addConditionalFormatting({
        ref: `C${monthlyStartRow}:C${monthlyStartRow + monthKeys.length - 1}`,
        rules: [
          {
            type: 'dataBar',
            priority: 8,
            dataBar: {
              color: { argb: successGreen },
              showValue: true,
              minLength: 0,
              maxLength: 100,
            },
          },
        ],
      });
    }

    ws4.columns = [
      { width: 18 }, { width: 14 }, { width: 14 }, { width: 30 },
      { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }
    ];

    // ══════════════════════════════════════════════════════════
    // SHEET 5: ACTIVITY TIMELINE
    // ══════════════════════════════════════════════════════════
    const ws5 = workbook.addWorksheet('Activity Timeline', { properties: { defaultColWidth: 18 } });

    ws5.mergeCells('A1:E1');
    ws5.getCell('A1').value = `ACTIVITY TIMELINE — ${contract.company_name}`;
    ws5.getCell('A1').font = { bold: true, size: 14, color: { argb: white } };
    ws5.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws5.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: darkBlue } };
    ws5.getRow(1).height = 32;

    ws5.mergeCells('A2:E2');
    ws5.getCell('A2').value = `${timeline.length} activity entries recorded`;
    ws5.getCell('A2').font = { size: 10, italic: true, color: { argb: primaryBlue } };
    ws5.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lightBlue } };
    ws5.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
    ws5.getRow(2).height = 22;

    const timeHeaders = ['Date & Time', 'Event Type', 'Title', 'Description', 'Created By'];
    const timeHeaderRow = ws5.addRow(timeHeaders);
    timeHeaderRow.eachCell(cell => {
      cell.font = headerFont;
      cell.fill = headerFill;
      cell.border = borders;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws5.getRow(3).height = 28;

    if (timeline.length === 0) {
      ws5.mergeCells('A5:E5');
      ws5.getCell('A5').value = 'No activity recorded yet';
      ws5.getCell('A5').font = { italic: true, color: { argb: grey600 } };
      ws5.getCell('A5').alignment = { horizontal: 'center' };
    } else {
      for (let idx = 0; idx < timeline.length; idx++) {
        const t = timeline[idx];
        const tr = ws5.addRow([
          formatDateTime(t.created_at), t.event_type, t.title,
          t.description || '—', t.created_by || '—'
        ]);
        tr.eachCell((cell) => {
          cell.border = borders;
          cell.alignment = { vertical: 'top', wrapText: true };
          cell.font = { size: 10 };
          if (idx % 2 === 1) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grey50 } };
          }
        });

        // Color-code event type
        const eventType = (t.event_type || '').toLowerCase();
        if (eventType.includes('created') || eventType.includes('added')) {
          tr.getCell(2).font = { size: 10, color: { argb: successGreen }, bold: true };
        } else if (eventType.includes('updated') || eventType.includes('modified')) {
          tr.getCell(2).font = { size: 10, color: { argb: primaryBlue }, bold: true };
        } else if (eventType.includes('completed') || eventType.includes('resolved')) {
          tr.getCell(2).font = { size: 10, color: { argb: successGreen }, bold: true };
        } else if (eventType.includes('cancelled') || eventType.includes('deleted')) {
          tr.getCell(2).font = { size: 10, color: { argb: errorRed }, bold: true };
        }
      }
    }

    ws5.columns = [
      { width: 22 }, { width: 18 }, { width: 28 }, { width: 35 }, { width: 18 }
    ];

    // Auto-filter on timeline
    if (timeline.length > 0) {
      ws5.autoFilter = `A3:E${3 + timeline.length}`;
    }

    // ── Set response headers for Excel download ──
    const fileName = `AMC_Report_${contract.company_name.replace(/[^a-zA-Z0-9]/g, '_')}_${contract.amc_number.replace(/[^a-zA-Z0-9-]/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
