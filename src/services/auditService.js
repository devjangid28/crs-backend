const { query } = require('../config/database');

const actions = {
  PDF_GENERATED: 'pdf_generated',
  PDF_VIEWED: 'pdf_viewed',
  MESSAGE_SENT: 'message_sent',
  TRACKING_VIEWED: 'tracking_viewed',
  COLLECTION_STARTED: 'collection_started',
  COLLECTION_CONFIRMED: 'collection_confirmed',
  SIGNATURE_SUBMITTED: 'signature_submitted',
  FEEDBACK_SUBMITTED: 'feedback_submitted',
};

async function logAudit({ action, ticketId = null, entityType = null, entityId = null, performedBy = 'System', ipAddress = null, userAgent = null, details = null }) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    // Try the enhanced schema first
    const { query: dbQuery } = require('../config/database');
    await dbQuery(
      `INSERT INTO audit_logs (action, ticket_id, entity_type, entity_id, performed_by, ip_address, user_agent, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [action, ticketId, entityType, entityId, performedBy, ipAddress, userAgent, details ? JSON.stringify(details) : null, now]
    );
  } catch (err) {
    // Fallback to basic schema if enhanced columns don't exist
    try {
      const { query: dbQuery } = require('../config/database');
      // Check if this table has the basic or enhanced schema
      const colCheck = await dbQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'entity_type'"
      );
      if (colCheck.rows.length === 0) {
        // Basic schema fallback
        await dbQuery(
          `INSERT INTO audit_logs (action, ticket_id, details, created_at)
           VALUES ($1, $2, $3, $4)`,
          [action, ticketId, details ? JSON.stringify(details) : null, now]
        );
      } else {
        throw err;
      }
    } catch (fallbackErr) {
      console.error('Audit log failed:', fallbackErr.message);
    }
  }
}

module.exports = { logAudit, actions };
