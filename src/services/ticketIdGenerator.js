const { query } = require('../config/database');

const generateTicketId = async (client = null) => {
  const year = new Date().getFullYear();

  const execute = client ? client.query.bind(client) : query;

  const result = await execute(`SELECT nextval('ticket_id_seq') AS next_val`);
  const nextVal = parseInt(result.rows[0]?.next_val) || 1;

  return `TKT-${year}-${String(nextVal).padStart(6, '0')}`;
};

const peekNextTicketId = async () => {
  const year = new Date().getFullYear();
  const result = await query(`SELECT last_value, is_called FROM ticket_id_seq`);
  const lastValue = parseInt(result.rows[0]?.last_value) || 0;
  const isCalled = result.rows[0]?.is_called;
  const nextVal = isCalled ? lastValue + 1 : (lastValue || 1);
  return `TKT-${year}-${String(nextVal).padStart(6, '0')}`;
};

module.exports = { generateTicketId, peekNextTicketId };
