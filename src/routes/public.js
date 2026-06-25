const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');
const { validateSecureToken, markTokenUsed, getOrCreateToken } = require('../services/tokenService');
const { logAudit, actions } = require('../services/auditService');
const { authenticate } = require('../middleware/auth');

// Helper: serve HTML page
function servePage(res, pageName) {
  const pagePath = path.join(__dirname, '../../public', pageName);
  if (fs.existsSync(pagePath)) {
    res.sendFile(pagePath);
  } else {
    res.status(404).send('Page not found');
  }
}

// ============================================================
// TRACKING ENDPOINTS
// ============================================================

// GET /api/tracking/:ticketId/:token - Get tracking data
router.get('/tracking/:ticketId/:token', async (req, res, next) => {
  try {
    const { ticketId, token } = req.params;

    const tokenRecord = await validateSecureToken(ticketId, token, 'tracking');
    if (!tokenRecord) {
      return res.status(403).json({ success: false, message: 'Invalid or expired tracking link' });
    }

    // Get ticket data
    const tRes = await query('SELECT * FROM tickets WHERE id = $1', [parseInt(ticketId)]);
    if (tRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const ticket = tRes.rows[0];

    // Get status history
    const hRes = await query(
      'SELECT * FROM ticket_status_history WHERE ticket_id = $1 ORDER BY changed_at ASC',
      [parseInt(ticketId)]
    );

    // Get invoices
    const iRes = await query(
      'SELECT invoice_id, total_amount, amount_paid, balance_due, status FROM invoices WHERE ticket_id = $1 AND is_active = TRUE',
      [parseInt(ticketId)]
    );

    await logAudit({
      action: actions.TRACKING_VIEWED,
      ticketId: parseInt(ticketId),
      entityType: 'ticket',
      entityId: ticket.ticket_id,
      performedBy: 'Customer',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      data: {
        ticket: {
          ticketId: ticket.ticket_id,
          customerName: ticket.customer_name,
          customerPhone: ticket.customer_phone,
          deviceType: ticket.device_type,
          brand: ticket.brand,
          model: ticket.model,
          serialNumber: ticket.serial_number,
          problemDescription: ticket.problem_description,
          status: ticket.status,
          estimatedCost: ticket.estimated_cost,
          totalAmount: ticket.total_amount,
          warranty: ticket.warranty,
          warrantyPeriod: ticket.warranty_period,
          warrantyExpiry: ticket.warranty_expiry_date,
          actualCompletionDate: ticket.actual_completion_date,
          createdAt: ticket.created_at,
          updatedAt: ticket.updated_at,
        },
        statusHistory: hRes.rows.map(h => ({
          oldStatus: h.old_status,
          newStatus: h.new_status,
          changedBy: h.changed_by,
          changedAt: h.changed_at,
        })),
        invoices: iRes.rows.map(inv => ({
          invoiceId: inv.invoice_id,
          totalAmount: inv.total_amount,
          amountPaid: inv.amount_paid,
          balanceDue: inv.balance_due,
          status: inv.status,
        })),
      }
    });
  } catch (err) { next(err); }
});

// ============================================================
// COLLECTION ENDPOINTS
// ============================================================

// GET /api/collection/:ticketId/:token - Get collection data
router.get('/collection/:ticketId/:token', async (req, res, next) => {
  try {
    const { ticketId, token } = req.params;

    const tokenRecord = await validateSecureToken(ticketId, token, 'collection');
    if (!tokenRecord) {
      return res.status(403).json({ success: false, message: 'Invalid or expired collection link' });
    }

    const tRes = await query('SELECT * FROM tickets WHERE id = $1', [parseInt(ticketId)]);
    if (tRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const ticket = tRes.rows[0];

    // Get invoices
    const iRes = await query(
      'SELECT invoice_id, total_amount, amount_paid, balance_due, status, created_at FROM invoices WHERE ticket_id = $1 AND is_active = TRUE',
      [parseInt(ticketId)]
    );

    await logAudit({
      action: actions.COLLECTION_STARTED,
      ticketId: parseInt(ticketId),
      entityType: 'ticket',
      entityId: ticket.ticket_id,
      performedBy: 'Customer',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      data: {
        ticket: {
          ticketId: ticket.ticket_id,
          customerName: ticket.customer_name,
          customerPhone: ticket.customer_phone,
          deviceType: ticket.device_type,
          brand: ticket.brand,
          model: ticket.model,
          serialNumber: ticket.serial_number,
          problemDescription: ticket.problem_description,
          status: ticket.status,
          estimatedCost: ticket.estimated_cost,
          totalAmount: ticket.total_amount,
          accessories: ticket.accessories,
        },
        invoices: iRes.rows.map(inv => ({
          invoiceId: inv.invoice_id,
          totalAmount: inv.total_amount,
          amountPaid: inv.amount_paid,
          balanceDue: inv.balance_due,
          status: inv.status,
          date: inv.created_at,
        })),
      }
    });
  } catch (err) { next(err); }
});

// POST /api/collection/:ticketId/:token/confirm - Confirm collection
router.post('/collection/:ticketId/:token/confirm', async (req, res, next) => {
  try {
    const { ticketId, token } = req.params;
    const { receivedCondition, approveClosure, signatureData } = req.body;

    if (!receivedCondition || !approveClosure) {
      return res.status(400).json({ success: false, message: 'Both confirmation fields are required' });
    }

    const tokenRecord = await validateSecureToken(ticketId, token, 'collection');
    if (!tokenRecord) {
      return res.status(403).json({ success: false, message: 'Invalid or expired collection link' });
    }

    const tRes = await query('SELECT * FROM tickets WHERE id = $1', [parseInt(ticketId)]);
    if (tRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const ticket = tRes.rows[0];
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Save collection record
    const tid = parseInt(ticketId, 10);
    const ipAddr = req.ip || req.connection?.remoteAddress || '127.0.0.1';
    const ua = req.headers['user-agent'] || null;
    const c1 = approveClosure === true || approveClosure === 'true';
    const c2 = receivedCondition === true || receivedCondition === 'true';

    await query(
      `INSERT INTO customer_collection_records (ticket_id, confirmation_1, confirmation_2, signature_image, ip_address, user_agent, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tid, c1, c2, signatureData || null, ipAddr, ua, now]
    );

    // Save signature if provided
    if (signatureData) {
      await query(
        `INSERT INTO customer_signatures (ticket_id, signature_type, signature_data, ip_address, user_agent)
         VALUES (?, 'collection', ?, ?, ?)`,
        [tid, signatureData, ipAddr, ua]
      );
    }

    // Update ticket status
    await query(
      "UPDATE tickets SET status = 'Collected', actual_completion_date = ?, updated_at = ? WHERE id = ?",
      [now, now, tid]
    );

    // Record status change
    await query(
      `INSERT INTO ticket_status_history (ticket_id, ticket_identifier, old_status, new_status, changed_by, changed_at)
       VALUES ($1, $2, $3, 'Collected', 'Customer', $4)`,
      [parseInt(ticketId), ticket.ticket_id, ticket.status, now]
    );

    // Mark token as used
    await markTokenUsed(tokenRecord.id, req.ip);

    await logAudit({
      action: actions.COLLECTION_CONFIRMED,
      ticketId: parseInt(ticketId),
      entityType: 'ticket',
      entityId: ticket.ticket_id,
      performedBy: 'Customer',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      details: { oldStatus: ticket.status, newStatus: 'Collected' },
    });

    const googleReviewUrl = 'https://g.page/r/CadbqLfOAXFREBM/review';

    res.json({
      success: true,
      message: 'Collection confirmed successfully! Please leave a review on Google.',
      data: {
        ticketStatus: 'Collected',
        googleReviewUrl,
      }
    });
  } catch (err) { next(err); }
});

// ============================================================
// FEEDBACK ENDPOINTS
// ============================================================

// GET /api/feedback/:ticketId/:token - Get feedback data
router.get('/feedback/:ticketId/:token', async (req, res, next) => {
  try {
    const { ticketId, token } = req.params;

    const tokenRecord = await validateSecureToken(ticketId, token, 'feedback');
    if (!tokenRecord) {
      return res.status(403).json({ success: false, message: 'Invalid or expired feedback link' });
    }

    const tRes = await query('SELECT * FROM tickets WHERE id = $1', [parseInt(ticketId)]);
    if (tRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const ticket = tRes.rows[0];

    // Check if feedback already submitted
    const fRes = await query('SELECT * FROM customer_feedback WHERE ticket_id = $1', [parseInt(ticketId)]);

    res.json({
      success: true,
      data: {
        ticket: {
          ticketId: ticket.ticket_id,
          customerName: ticket.customer_name,
          deviceName: `${ticket.brand} ${ticket.model}`.trim(),
        },
        alreadySubmitted: fRes.rows.length > 0,
        existingFeedback: fRes.rows.length > 0 ? {
          rating: fRes.rows[0].rating,
          comment: fRes.rows[0].comment,
          submittedAt: fRes.rows[0].submitted_at,
        } : null,
      }
    });
  } catch (err) { next(err); }
});

// POST /api/feedback/:ticketId/:token - Submit feedback
router.post('/feedback/:ticketId/:token', async (req, res, next) => {
  try {
    const { ticketId, token } = req.params;
    const { rating, comment } = req.body;

    // Validation
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating is required (1-5)' });
    }
    if (!comment || comment.trim().length < 10) {
      return res.status(400).json({ success: false, message: 'Comment is required (minimum 10 characters)' });
    }

    const tokenRecord = await validateSecureToken(ticketId, token, 'feedback');
    if (!tokenRecord) {
      return res.status(403).json({ success: false, message: 'Invalid or expired feedback link' });
    }

    const tRes = await query('SELECT * FROM tickets WHERE id = $1', [parseInt(ticketId)]);
    if (tRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    const ticket = tRes.rows[0];

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Save feedback
    await query(
      `INSERT INTO customer_feedback (ticket_id, customer_id, customer_name, device_name, rating, comment, ip_address, user_agent, is_mandatory, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)`,
      [parseInt(ticketId), ticket.customer_id, ticket.customer_name,
       `${ticket.brand} ${ticket.model}`.trim(), rating, comment.trim(),
       req.ip, req.headers['user-agent'] || null, now]
    );

    // Mark token as used
    await markTokenUsed(tokenRecord.id, req.ip);

    await logAudit({
      action: actions.FEEDBACK_SUBMITTED,
      ticketId: parseInt(ticketId),
      entityType: 'ticket',
      entityId: ticket.ticket_id,
      performedBy: 'Customer',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      details: { rating, commentLength: comment.length },
    });

    res.json({
      success: true,
      message: 'Feedback submitted successfully. Thank you!',
    });
  } catch (err) { next(err); }
});

// ============================================================
// TOKEN GENERATION (staff-only, auth-protected)
// ============================================================

// POST /api/tokens/generate - Generate a secure token (auth-protected)
router.post('/tokens/generate', authenticate, async (req, res, next) => {
  try {
    const { ticketId, tokenType, expiryHours } = req.body;
    if (!ticketId || !tokenType) {
      return res.status(400).json({ success: false, message: 'ticketId and tokenType are required' });
    }

    const validTypes = ['tracking', 'collection', 'feedback'];
    if (!validTypes.includes(tokenType)) {
      return res.status(400).json({ success: false, message: 'Invalid token type. Valid: tracking, collection, feedback' });
    }

    const token = await getOrCreateToken(ticketId, tokenType, expiryHours || 168);

    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`;
    const urls = {
      tracking: `${baseUrl}/track/${ticketId}/${token.token}`,
      collection: `${baseUrl}/collect/${ticketId}/${token.token}`,
      feedback: `${baseUrl}/feedback/${ticketId}/${token.token}`,
    };

    res.json({
      success: true,
      data: {
        token: token.token,
        expiresAt: token.expiresAt,
        url: urls[tokenType] || `${baseUrl}/${tokenType}/${ticketId}/${token.token}`,
        allUrls: urls,
      }
    });
  } catch (err) { next(err); }
});

module.exports = router;
