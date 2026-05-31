const { query } = require('../config/database');

const recordStatusChange = async (ticketId, oldStatus, newStatus, changedBy = 'System', connection = null, ticketIdentifier = null) => {
  if (oldStatus === newStatus) return;

  const execute = connection ? connection.query.bind(connection) : query;

  const result = await execute(
    `INSERT INTO ticket_status_history (ticket_id, ticket_identifier, old_status, new_status, changed_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [ticketId, ticketIdentifier, oldStatus || null, newStatus, changedBy]
  );

  return { ticketId, oldStatus, newStatus, changedBy };
};

const getStatusHistory = async (ticketId) => {
  const rows = await query(
    `SELECT * FROM ticket_status_history WHERE ticket_id = ? ORDER BY changed_at DESC`,
    [ticketId]
  );
  return rows.rows;
};

const getRecentActivity = async (limit = 10) => {
  const rows = await query(
    `SELECT h.*, t.customer_name, t.id as ticket_id_display
     FROM ticket_status_history h
     JOIN tickets t ON h.ticket_id = t.id
     ORDER BY h.changed_at DESC
     LIMIT ?`,
    [limit]
  );
  return rows.rows;
};

module.exports = { recordStatusChange, getStatusHistory, getRecentActivity };
