const { query } = require('../config/database');

async function createSystemMessage({
  conversationId,
  ticketId,
  customerId,
  sender = 'System',
  event,
  text = '',
  description = '',
  type = 'event',
  fileName = null,
  fileSize = null,
  documentType = null,
  linkType = null,
  linkUrl = null,
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, event, text, description, file_name, file_size, document_type, link_type, link_url, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'sent', $14) RETURNING id`,
    [conversationId, sender, customerId, ticketId, type, event, text, description, fileName, fileSize, documentType, linkType, linkUrl, now]
  );

  return result.rows[0];
}

async function createTextMessage({
  conversationId,
  ticketId,
  customerId,
  sender = 'Staff',
  text = '',
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, text, status, created_at)
     VALUES ($1, $2, $3, $4, 'text', $5, 'sent', $6) RETURNING id`,
    [conversationId, sender, customerId, ticketId, text, now]
  );

  return result.rows[0];
}

async function createPdfMessage({
  conversationId,
  ticketId,
  customerId,
  sender = 'Staff',
  fileName,
  fileSize,
  documentType,
  event = '',
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, event, file_name, file_size, document_type, status, created_at)
     VALUES ($1, $2, $3, $4, 'file', $5, $6, $7, $8, 'sent', $9) RETURNING id`,
    [conversationId, sender, customerId, ticketId, event, fileName, fileSize, documentType, now]
  );

  return result.rows[0];
}

async function createLinkMessage({
  conversationId,
  ticketId,
  customerId,
  sender = 'Staff',
  linkType,
  linkUrl,
  text = '',
  description = '',
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, link_type, link_url, text, description, status, created_at)
     VALUES ($1, $2, $3, $4, 'link', $5, $6, $7, $8, 'sent', $9) RETURNING id`,
    [conversationId, sender, customerId, ticketId, linkType, linkUrl, text, description, now]
  );

  return result.rows[0];
}

const EVENT_MAP = {
  'New': { event: 'repair_received', text: 'Repair Received', description: 'Device has been received for repair.' },
  'Diagnosed': { event: 'device_diagnosed', text: 'Device Diagnosed', description: 'Device has been diagnosed by technician.' },
  'Awaiting Approval': { event: 'awaiting_approval', text: 'Awaiting Approval', description: 'Estimate sent. Awaiting customer approval.' },
  'In Progress': { event: 'repair_in_progress', text: 'Repair In Progress', description: 'Repair work is in progress.' },
  'Waiting For Parts': { event: 'parts_ordered', text: 'Parts Ordered', description: 'Parts have been ordered for the repair.' },
  'Completed': { event: 'repair_completed', text: 'Repair Completed', description: 'Repair has been completed.' },
  'Ready For Pickup': { event: 'ready_for_pickup', text: 'Ready For Pickup', description: 'Device is ready for pickup.' },
  'Delivered': { event: 'delivered', text: 'Delivered', description: 'Device has been delivered to customer.' },
  'Collected': { event: 'collected', text: 'Collected', description: 'Device has been collected.' },
  'Cancelled': { event: 'cancelled', text: 'Cancelled', description: 'Repair has been cancelled.' },
};

async function createStatusEvent(ticketId, oldStatus, newStatus, changedBy = 'System') {
  const tRes = await query('SELECT id, customer_id, customer_name, customer_phone FROM tickets WHERE id = $1', [ticketId]);
  if (tRes.rows.length === 0) return null;
  const t = tRes.rows[0];

  const eventInfo = EVENT_MAP[newStatus];
  if (!eventInfo) return null;

  const conversationId = String(t.id);

  return createSystemMessage({
    conversationId,
    ticketId,
    customerId: t.customer_id,
    sender: changedBy || 'System',
    event: eventInfo.event,
    text: eventInfo.text,
    description: eventInfo.description,
    type: 'event',
  });
}

async function storeIncomingMessage({ from, waId, text, profileName }) {
  const convId = 'wa_' + from;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // Try to match phone number to an existing customer
  let customerId = null;
  try {
    const cleanPhone = from.replace(/^0+/, '');
    const customerRes = await query(
      `SELECT id FROM customers WHERE phone LIKE $1 OR phone LIKE $2 OR phone LIKE $3 LIMIT 1`,
      [`%${from}`, `%${cleanPhone}`, `${cleanPhone}%`]
    );
    if (customerRes.rows.length > 0) {
      customerId = customerRes.rows[0].id;
    }
  } catch (e) {
    // Silent fail on lookup
  }

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, type, text, status, created_at)
     VALUES ($1, 'Customer', $2, 'text', $3, 'delivered', $4) RETURNING id`,
    [convId, customerId, text, now]
  );

  return { id: result.rows[0].id, customerId, convId };
}

module.exports = { createSystemMessage, createTextMessage, createPdfMessage, createLinkMessage, createStatusEvent, storeIncomingMessage };
