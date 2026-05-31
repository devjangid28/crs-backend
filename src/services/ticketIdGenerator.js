const { query } = require('../config/database');

const generateTicketId = async () => {
  const year = new Date().getFullYear();

  try {
    const rows = await query(
      `SELECT COUNT(*) as count FROM tickets WHERE ticket_id LIKE ?`,
      [`TKT-${year}-%`]
    );

    const count = parseInt(rows.rows[0]?.count) || 0;
    const nextNum = count + 1;
    const ticketId = `TKT-${year}-${String(nextNum).padStart(5, '0')}`;

    const existing = await query('SELECT ticket_id FROM tickets WHERE ticket_id = ?', [ticketId]);
    if (existing.rows.length > 0) {
      const rows2 = await query('SELECT MAX(CAST(SUBSTRING(ticket_id, 12) AS INTEGER)) as max_num FROM tickets WHERE ticket_id LIKE ?', [`TKT-${year}-%`]);
      const maxNum = parseInt(rows2.rows[0]?.max_num) || count;
      return `TKT-${year}-${String(maxNum + 1).padStart(5, '0')}`;
    }

    return ticketId;
  } catch (err) {
    console.warn('Ticket ID generation using ticket_id column failed, falling back to id:', err.message);
    // Fallback: use max id
    const rows = await query('SELECT MAX(id) as max_id FROM tickets');
    const maxId = parseInt(rows.rows[0]?.max_id) || 0;
    return `TKT-${year}-${String(maxId + 1).padStart(5, '0')}`;
  }
};

module.exports = { generateTicketId };
