const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { query, getConnection } = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');

const ISSUE_UPLOAD_DIR = path.join(__dirname, '../../uploads/issues');
if (!fs.existsSync(ISSUE_UPLOAD_DIR)) {
  fs.mkdirSync(ISSUE_UPLOAD_DIR, { recursive: true });
}

function saveBase64Image(base64DataUrl, issueId, index) {
  const matches = base64DataUrl.match(/^data:(image\/(\w+));base64,(.+)$/);
  if (!matches) return null;
  const ext = matches[2] === 'jpeg' ? 'jpg' : matches[2];
  const base64 = matches[3];
  const filename = `${issueId}_${Date.now()}_${index}.${ext}`;
  const filePath = path.join(ISSUE_UPLOAD_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return `/uploads/issues/${filename}`;
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// ─── Admin: Generate Portal Token ───────────────────────────────────────────
router.post('/admin/generate-portal-token', authenticate, requireRole('owner'), async (req, res, next) => {
  try {
    const { contractId } = req.body;
    if (!contractId) {
      return res.status(400).json({ success: false, message: 'Contract ID is required' });
    }

    const contract = await query('SELECT * FROM amc_contracts WHERE id = $1 AND is_active = true', [contractId]);
    if (contract.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contract not found' });
    }

    const token = crypto.randomBytes(32).toString('hex');

    await query(
      `INSERT INTO amc_portal_tokens (contract_id, token, created_by) VALUES ($1, $2, $3)`,
      [contractId, token, req.user.full_name || 'System']
    );

    await query('UPDATE amc_contracts SET portal_enabled = true, portal_token = $1 WHERE id = $2', [token, contractId]);

    const baseUrl = config.server.publicUrl || `${req.protocol}://${req.get('host')}`;
    const portalUrl = `${baseUrl}/amc/customer/${token}`;

    res.json({
      success: true,
      message: 'Portal token generated successfully',
      data: {
        token,
        portalUrl,
        contractId,
        companyName: contract.rows[0].company_name,
      }
    });
  } catch (err) {
    next(err);
  }
});

// ─── Public: Get portal info by token (no auth required) ────────────────────
router.get('/portal/:token', async (req, res, next) => {
  try {
    const tokenResult = await query(
      `SELECT pt.*, c.company_name, c.contact_person, c.mobile, c.email, c.address,
              c.contract_type, c.status, c.start_date, c.end_date, c.total_visits,
              c.completed_visits, c.pending_visits, c.amc_number
       FROM amc_portal_tokens pt
       JOIN amc_contracts c ON c.id = pt.contract_id
       WHERE pt.token = $1 AND pt.is_active = true AND c.is_active = true`,
      [req.params.token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired portal token' });
    }

    const portal = tokenResult.rows[0];

    if (portal.expires_at && new Date(portal.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: 'Portal token has expired' });
    }

    await query('UPDATE amc_portal_tokens SET last_accessed_at = NOW() WHERE id = $1', [portal.id]);

    res.json({
      success: true,
      data: {
        companyName: portal.company_name,
        contactPerson: portal.contact_person,
        mobile: portal.mobile,
        email: portal.email,
        address: portal.address,
        contractType: portal.contract_type,
        status: portal.status,
        startDate: portal.start_date,
        endDate: portal.end_date,
        amcNumber: portal.amc_number,
        totalVisits: portal.total_visits,
        completedVisits: portal.completed_visits,
        pendingVisits: portal.pending_visits,
        contractId: portal.contract_id,
      }
    });
  } catch (err) {
    next(err);
  }
});

// ─── Public: Create issue from portal ───────────────────────────────────────
router.post('/portal/:token/issues', async (req, res, next) => {
  try {
    const tokenResult = await query(
      `SELECT pt.* FROM amc_portal_tokens pt
       WHERE pt.token = $1 AND pt.is_active = true`,
      [req.params.token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired portal token' });
    }

    const portal = tokenResult.rows[0];

    if (portal.expires_at && new Date(portal.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: 'Portal token has expired' });
    }

    const { title, description, category, priority, affectedDevice, locationDetails } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    const now = new Date();
    const month = MONTHS[now.getMonth()];
    const year = now.getFullYear();
    const prefix = `CIS-${year}-${month}-`;
    const numResult = await query(
      `SELECT issue_number FROM amc_customer_issues WHERE issue_number LIKE $1 ORDER BY id DESC LIMIT 1`,
      [`${prefix}%`]
    );
    let nextNum = 1;
    if (numResult.rows.length > 0) {
      const parts = numResult.rows[0].issue_number.split('-');
      const lastNum = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }
    const issueNumber = `${prefix}${String(nextNum).padStart(4, '0')}`;

    const result = await query(
      `INSERT INTO amc_customer_issues (contract_id, issue_number, title, description, category, priority, affected_device, location_details, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [portal.contract_id, issueNumber, title.trim(), description || null, category || null, priority || 'Medium', affectedDevice || null, locationDetails || null, 'Customer']
    );

    await query(
      `INSERT INTO amc_timeline (contract_id, event_type, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [portal.contract_id, 'customer_issue', `Customer Issue: ${title}`, description || '', 'Customer Portal']
    );

    res.status(201).json({ success: true, message: 'Issue submitted successfully', data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── Public: Upload images for portal issue ─────────────────────────────────
router.post('/portal/:token/issues/:id/images', async (req, res, next) => {
  try {
    const tokenResult = await query(
      `SELECT pt.* FROM amc_portal_tokens pt
       WHERE pt.token = $1 AND pt.is_active = true`,
      [req.params.token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired portal token' });
    }

    const issue = await query(
      'SELECT * FROM amc_customer_issues WHERE id = $1 AND contract_id = $2',
      [req.params.id, tokenResult.rows[0].contract_id]
    );

    if (issue.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Issue not found' });
    }

    const { images } = req.body;
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, message: 'Images array is required' });
    }

    const saved = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const imageUrl = saveBase64Image(img.imageUrl, req.params.id, i);
      if (!imageUrl) {
        return res.status(400).json({ success: false, message: `Invalid image data at index ${i}` });
      }
      const result = await query(
        `INSERT INTO amc_issue_images (issue_id, image_url, thumbnail_url, file_size, file_type, uploaded_by, image_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.params.id, imageUrl, null, img.fileSize || 0, img.fileType || 'image/jpeg', 'Customer', 'issue_image']
      );
      saved.push(result.rows[0]);
    }

    res.json({ success: true, message: 'Images uploaded successfully', data: saved });
  } catch (err) {
    next(err);
  }
});

// ─── Public: Get visits for portal ──────────────────────────────────────────
router.get('/portal/:token/visits', async (req, res, next) => {
  try {
    const tokenResult = await query(
      `SELECT pt.* FROM amc_portal_tokens pt
       WHERE pt.token = $1 AND pt.is_active = true`,
      [req.params.token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired portal token' });
    }

    const portal = tokenResult.rows[0];

    if (portal.expires_at && new Date(portal.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: 'Portal token has expired' });
    }

    const visits = await query(
      `SELECT v.*, COALESCE(json_agg(json_build_object(
        'id', img.id, 'image_url', img.image_url, 'thumbnail_url', img.thumbnail_url
      )) FILTER (WHERE img.id IS NOT NULL), '[]'::json) AS images
      FROM amc_visits v
      LEFT JOIN amc_visit_images img ON img.visit_id = v.id
      WHERE v.contract_id = $1 AND v.is_active = true
      GROUP BY v.id
      ORDER BY v.visit_date DESC`,
      [portal.contract_id]
    );

    res.json({ success: true, data: visits.rows });
  } catch (err) {
    next(err);
  }
});

// ─── Public: Get timeline for portal ────────────────────────────────────────
router.get('/portal/:token/timeline', async (req, res, next) => {
  try {
    const tokenResult = await query(
      `SELECT pt.* FROM amc_portal_tokens pt
       WHERE pt.token = $1 AND pt.is_active = true`,
      [req.params.token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired portal token' });
    }

    const portal = tokenResult.rows[0];

    if (portal.expires_at && new Date(portal.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: 'Portal token has expired' });
    }

    const timeline = await query(
      `SELECT * FROM amc_timeline WHERE contract_id = $1 ORDER BY created_at DESC`,
      [portal.contract_id]
    );

    res.json({ success: true, data: timeline.rows });
  } catch (err) {
    next(err);
  }
});

// ─── Admin: List staff members for assignment dropdown ─────────────────────
router.get('/admin/staff-members', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, full_name, mobile_number, email, username
       FROM users WHERE role = 'staff' AND is_active = true AND (is_disabled IS NULL OR is_disabled = false)
       ORDER BY full_name`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ─── Admin: Get customer-submitted issues ──────────────────────────────────
router.get('/admin/customer-issues', authenticate, async (req, res, next) => {
  try {
    const { contractId, status, page = 1, limit = 50 } = req.query;
    let whereClause = 'WHERE ci.is_active = true';
    const params = [];

    if (contractId) { whereClause += ` AND ci.contract_id = $${params.length + 1}`; params.push(contractId); }
    if (status) { whereClause += ` AND ci.status = $${params.length + 1}`; params.push(status); }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countResult = await query(`SELECT COUNT(*) as total FROM amc_customer_issues ci ${whereClause}`, params);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    const dataResult = await query(
      `SELECT ci.*, c.company_name, c.amc_number,
        COALESCE(json_agg(json_build_object(
          'id', img.id, 'image_url', img.image_url, 'thumbnail_url', img.thumbnail_url,
          'uploaded_by', img.uploaded_by, 'image_type', img.image_type
        )) FILTER (WHERE img.id IS NOT NULL), '[]'::json) AS issue_images
      FROM amc_customer_issues ci
      LEFT JOIN amc_contracts c ON c.id = ci.contract_id
      LEFT JOIN amc_issue_images img ON img.issue_id = ci.id
      ${whereClause}
      GROUP BY ci.id, c.company_name, c.amc_number
      ORDER BY ci.created_at DESC
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

// ─── Admin: Update customer issue (status, notes, etc.) ────────────────────
router.put('/admin/customer-issues/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await query('SELECT * FROM amc_customer_issues WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Issue not found' });
    }

    const { status, internalNotes, resolutionNotes } = req.body;

    if (status) {
      const validStatuses = ['Open', 'In Progress', 'Resolved', 'Closed'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      }
    }

    const setClauses = [];
    const values = [];
    let idx = 1;

    if (status !== undefined) {
      setClauses.push(`status = $${idx++}`);
      values.push(status);
      if (status === 'Resolved' || status === 'Closed') {
        setClauses.push(`resolved_at = NOW()`);
        setClauses.push(`resolved_by = $${idx++}`);
        values.push(req.user.full_name);
      }
    }
    if (internalNotes !== undefined) { setClauses.push(`internal_notes = $${idx++}`); values.push(internalNotes); }
    if (resolutionNotes !== undefined) { setClauses.push(`resolution_notes = $${idx++}`); values.push(resolutionNotes); }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(req.params.id);
    await query(
      `UPDATE amc_customer_issues SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      values
    );

    const issue = existing.rows[0];
    await query(
      `INSERT INTO amc_timeline (contract_id, event_type, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [issue.contract_id, 'issue_updated', `Issue ${issue.issue_number} status changed to ${status || issue.status}`, internalNotes || '', req.user.full_name]
    );

    const updated = await query('SELECT * FROM amc_customer_issues WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Issue updated successfully', data: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── Admin: Assign staff to customer issue ─────────────────────────────────
router.post('/admin/customer-issues/:id/assign', authenticate, async (req, res, next) => {
  try {
    const { staffUserId } = req.body;
    if (!staffUserId) {
      return res.status(400).json({ success: false, message: 'Staff user ID is required' });
    }

    const issue = await query('SELECT * FROM amc_customer_issues WHERE id = $1', [req.params.id]);
    if (issue.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Issue not found' });
    }

    const staffUser = await query('SELECT * FROM users WHERE id = $1 AND role = $2', [staffUserId, 'staff']);
    if (staffUser.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    await query(
      `UPDATE amc_customer_issues SET assigned_to_user_id = $1, assigned_to_name = $2, assigned_at = NOW(), status = 'In Progress' WHERE id = $3`,
      [staffUserId, staffUser.rows[0].full_name, req.params.id]
    );

    await query(
      `INSERT INTO amc_timeline (contract_id, event_type, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [issue.rows[0].contract_id, 'issue_assigned', `Issue ${issue.rows[0].issue_number} assigned to ${staffUser.rows[0].full_name}`, '', req.user.full_name]
    );

    await query(
      `INSERT INTO amc_notifications (contract_id, issue_id, notification_type, title, message, recipient_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [issue.rows[0].contract_id, req.params.id, 'issue_assigned', `New issue assigned: ${issue.rows[0].title}`, `Issue ${issue.rows[0].issue_number} has been assigned to you.`, parseInt(staffUserId)]
    );

    const updated = await query('SELECT * FROM amc_customer_issues WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Issue assigned successfully', data: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── Admin: Create visit from customer issue ────────────────────────────────
router.post('/admin/customer-issues/:id/create-visit', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const issue = await client.query('SELECT * FROM amc_customer_issues WHERE id = $1', [req.params.id]);
    if (issue.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Issue not found' });
    }

    const issueData = issue.rows[0];

    const now = new Date();
    const month = MONTHS[now.getMonth()];
    const year = now.getFullYear();
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

    const result = await client.query(
      `INSERT INTO amc_visits (contract_id, visit_number, title, description, visit_date, engineer_name, engineer_user_id, visit_type, status, created_by)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7, $8, $9) RETURNING *`,
      [
        issueData.contract_id, visitNumber,
        `Visit from Issue: ${issueData.title}`,
        issueData.description || null,
        issueData.assigned_to_name || null,
        issueData.assigned_to_user_id || null,
        'Repair',
        'Scheduled',
        req.user.full_name || 'System'
      ]
    );

    await client.query(
      `INSERT INTO amc_timeline (contract_id, event_type, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [issueData.contract_id, 'visit_created', `Visit ${visitNumber} created from issue ${issueData.issue_number}`, `Engineer: ${issueData.assigned_to_name || 'N/A'}`, req.user.full_name]
    );

    await client.query('COMMIT');

    const visit = await query(
      `SELECT v.*, c.company_name, c.amc_number
      FROM amc_visits v
      JOIN amc_contracts c ON c.id = v.contract_id
      WHERE v.id = $1`,
      [result.rows[0].id]
    );

    res.status(201).json({ success: true, message: 'Visit created from issue', data: visit.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── Staff: Get issues assigned to logged-in staff ─────────────────────────
router.get('/staff/issues', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT ci.*, c.company_name, c.amc_number,
        COALESCE(json_agg(json_build_object(
          'id', img.id, 'image_url', img.image_url, 'thumbnail_url', img.thumbnail_url
        )) FILTER (WHERE img.id IS NOT NULL), '[]'::json) AS issue_images
      FROM amc_customer_issues ci
      LEFT JOIN amc_contracts c ON c.id = ci.contract_id
      LEFT JOIN amc_issue_images img ON img.issue_id = ci.id
      WHERE (ci.assigned_to_user_id = $1 OR ci.assigned_to_name ILIKE $2) AND ci.is_active = true AND ci.status != 'Closed'
      GROUP BY ci.id, c.company_name, c.amc_number
      ORDER BY ci.created_at DESC`,
      [req.user.id, `%${req.user.full_name}%`]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ─── Staff: Update issue status ─────────────────────────────────────────────
router.put('/staff/issues/:id', authenticate, async (req, res, next) => {
  try {
    const issue = await query('SELECT * FROM amc_customer_issues WHERE id = $1', [req.params.id]);
    if (issue.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Issue not found' });
    }

    if (issue.rows[0].assigned_to_user_id !== req.user.id && !req.user.full_name?.includes(issue.rows[0].assigned_to_name || '')) {
      return res.status(403).json({ success: false, message: 'This issue is not assigned to you' });
    }

    const { status, resolutionNotes } = req.body;
    const validStatuses = ['In Progress', 'Resolved', 'Closed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const setClauses = [`status = $1`];
    const values = [status];
    let idx = 2;

    if (status === 'Resolved' || status === 'Closed') {
      setClauses.push(`resolved_at = NOW()`);
      setClauses.push(`resolved_by = $${idx++}`);
      values.push(req.user.full_name);
    }
    if (resolutionNotes !== undefined) {
      setClauses.push(`resolution_notes = $${idx++}`);
      values.push(resolutionNotes);
    }

    values.push(req.params.id);
    await query(
      `UPDATE amc_customer_issues SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      values
    );

    await query(
      `INSERT INTO amc_timeline (contract_id, event_type, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [issue.rows[0].contract_id, 'issue_updated', `Issue ${issue.rows[0].issue_number} marked as ${status} by staff`, resolutionNotes || '', req.user.full_name]
    );

    const updated = await query('SELECT * FROM amc_customer_issues WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Issue updated successfully', data: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── Staff: Upload images for issue ─────────────────────────────────────────
router.post('/staff/issues/:id/images', authenticate, async (req, res, next) => {
  try {
    const issue = await query('SELECT * FROM amc_customer_issues WHERE id = $1', [req.params.id]);
    if (issue.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Issue not found' });
    }

    const { images } = req.body;
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, message: 'Images array is required' });
    }

    const saved = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const imageUrl = saveBase64Image(img.imageUrl, req.params.id, i);
      if (!imageUrl) {
        return res.status(400).json({ success: false, message: `Invalid image data at index ${i}` });
      }
      const result = await query(
        `INSERT INTO amc_issue_images (issue_id, image_url, thumbnail_url, file_size, file_type, uploaded_by, image_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.params.id, imageUrl, null, img.fileSize || 0, img.fileType || 'image/jpeg', req.user.full_name || 'Staff', 'resolved_image']
      );
      saved.push(result.rows[0]);
    }

    res.json({ success: true, message: 'Images uploaded successfully', data: saved });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
