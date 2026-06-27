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
  providerMessageId = null,
  phone = null,
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, event, text, description, file_name, file_size, document_type, link_type, link_url, status, provider_message_id, phone, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'sent', $14, $15, $16) RETURNING id`,
    [conversationId, sender, customerId, ticketId, type, event, text, description, fileName, fileSize, documentType, linkType, linkUrl, providerMessageId, phone, now]
  );

  return result.rows[0];
}

async function createTextMessage({
  conversationId,
  ticketId,
  customerId,
  sender = 'Staff',
  text = '',
  providerMessageId = null,
  phone = null,
  status = 'sending',
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, text, status, provider_message_id, phone, created_at)
     VALUES ($1, $2, $3, $4, 'text', $5, $6, $7, $8, $9) RETURNING id`,
    [conversationId, sender, customerId, ticketId, text, status, providerMessageId, phone, now]
  );

  return result.rows[0];
}

async function createTemplateMessage({
  conversationId,
  ticketId,
  customerId,
  sender = 'System',
  templateName,
  text = '',
  providerMessageId = null,
  phone = null,
  status = 'sending',
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, template_name, text, status, provider_message_id, phone, created_at)
     VALUES ($1, $2, $3, $4, 'template', $5, $6, $7, $8, $9, $10) RETURNING id`,
    [conversationId, sender, customerId, ticketId, templateName, text, status, providerMessageId, phone, now]
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
  providerMessageId = null,
  phone = null,
  status = 'sending',
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, event, file_name, file_size, document_type, status, provider_message_id, phone, created_at)
     VALUES ($1, $2, $3, $4, 'file', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [conversationId, sender, customerId, ticketId, event, fileName, fileSize, documentType, status, providerMessageId, phone, now]
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
  providerMessageId = null,
  phone = null,
  status = 'sending',
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, link_type, link_url, text, description, status, provider_message_id, phone, created_at)
     VALUES ($1, $2, $3, $4, 'link', $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [conversationId, sender, customerId, ticketId, linkType, linkUrl, text, description, status, providerMessageId, phone, now]
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
  'Ready for Pickup': { event: 'ready_for_pickup', text: 'Ready For Pickup', description: 'Device is ready for pickup.' },
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

  let customerId = null;
  try {
    const cleanPhone = from.replace(/^0+/, '');
    const suffixes = [from, cleanPhone, from.replace(/^91/, ''), '91' + cleanPhone.replace(/^91/, '')];
    for (const s of [...new Set(suffixes)]) {
      const customerRes = await query(
        `SELECT id FROM customers WHERE phone LIKE $1 OR phone LIKE $2 LIMIT 1`,
        [`%${s}`, `${s}%`]
      );
      if (customerRes.rows.length > 0) {
        customerId = customerRes.rows[0].id;
        break;
      }
    }
  } catch (e) {
    // Silent
  }

  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, type, text, status, provider_message_id, phone, is_read, created_at)
     VALUES ($1, 'Customer', $2, 'text', $3, 'delivered', $4, $5, false, $6) RETURNING id`,
    [convId, customerId, text, waId, from, now]
  );

  return { id: result.rows[0].id, customerId, convId };
}

async function getOrCreateConversation(ticketId, customerId, customerPhone) {
  const tRes = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  if (tRes.rows.length === 0) return null;
  const ticket = tRes.rows[0];

  const convId = String(ticketId);

  const existingConv = await query(
    'SELECT conversation_id FROM messages WHERE conversation_id = $1 LIMIT 1',
    [convId]
  );

  if (existingConv.rows.length > 0) {
    return { conversationId: convId, isNew: false };
  }

  const systemMsg = `Ticket #${ticket.ticket_id || ticketId} created for ${ticket.customer_name || 'Customer'}. Status: ${ticket.status || 'New'}`;
  await createSystemMessage({
    conversationId: convId,
    ticketId,
    customerId,
    sender: 'System',
    event: 'conversation_created',
    text: systemMsg,
    description: '',
    type: 'event',
    phone: customerPhone,
  });

  return { conversationId: convId, isNew: true };
}

async function markConversationRead(conversationId, sender = 'Staff') {
  const result = await query(
    `UPDATE messages SET is_read = true WHERE conversation_id = $1 AND is_read = false AND sender != $2`,
    [conversationId, sender]
  );
  return result.rowCount;
}

async function getUnreadCount(conversationId) {
  const result = await query(
    `SELECT COUNT(*) as count FROM messages WHERE conversation_id = $1 AND is_read = false AND sender = 'Customer'`,
    [conversationId]
  );
  return parseInt(result.rows[0]?.count) || 0;
}

async function getAllUnreadCounts() {
  const result = await query(
    `SELECT conversation_id, COUNT(*) as count FROM messages WHERE is_read = false AND sender = 'Customer' GROUP BY conversation_id`
  );
  const counts = {};
  result.rows.forEach(r => {
    counts[r.conversation_id] = parseInt(r.count) || 0;
  });
  return counts;
}

async function getConversationsWithDetails({ search, filter, customerId } = {}) {
  let whereClause = 'WHERE 1=1';
  const params = [];

  if (customerId) {
    whereClause += ' AND m.customer_id = $' + (params.length + 1);
    params.push(customerId);
  }

  if (filter === 'unread') {
    whereClause += ` AND m.conversation_id IN (SELECT conversation_id FROM messages WHERE is_read = false AND sender = 'Customer')`;
  }

  let searchJoin = '';
  if (search) {
    searchJoin = `
    LEFT JOIN tickets t ON m.ticket_id = t.id
    LEFT JOIN customers c ON m.customer_id::text = c.id::text
    `;
    whereClause += ` AND (
      m.conversation_id ILIKE $${params.length + 1}
      OR t.ticket_id ILIKE $${params.length + 1}
      OR t.customer_name ILIKE $${params.length + 1}
      OR t.customer_phone ILIKE $${params.length + 1}
      OR c.name ILIKE $${params.length + 1}
      OR c.phone ILIKE $${params.length + 1}
    )`;
    params.push(`%${search}%`);
  }

  const sql = `
    SELECT DISTINCT ON (m.conversation_id)
           m.conversation_id,
           m.customer_id,
           m.ticket_id,
           m.phone,
           m.created_at as last_message_at,
           (SELECT text FROM messages WHERE conversation_id = m.conversation_id ORDER BY created_at DESC LIMIT 1) as last_text,
           (SELECT type FROM messages WHERE conversation_id = m.conversation_id ORDER BY created_at DESC LIMIT 1) as last_type,
           (SELECT sender FROM messages WHERE conversation_id = m.conversation_id ORDER BY created_at DESC LIMIT 1) as last_sender,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = m.conversation_id AND is_read = false AND sender = 'Customer') as unread_count,
           (SELECT t2.customer_name FROM tickets t2 WHERE t2.id = m.ticket_id::integer LIMIT 1) as ticket_customer_name,
           (SELECT t2.customer_phone FROM tickets t2 WHERE t2.id = m.ticket_id::integer LIMIT 1) as ticket_customer_phone,
           (SELECT c2.name FROM customers c2 WHERE c2.id::text = m.customer_id::text LIMIT 1) as saved_customer_name,
           (SELECT c2.phone FROM customers c2 WHERE c2.id::text = m.customer_id::text LIMIT 1) as saved_customer_phone
    FROM messages m
    ${searchJoin}
    ${whereClause}
    ORDER BY m.conversation_id, m.created_at DESC
  `;

  const result = await query(sql, params);
  const conversations = result.rows;

  if (filter === 'customers') {
    return conversations.filter(c => c.conversation_id && !c.conversation_id.startsWith('wa_'));
  }
  if (filter === 'team') {
    return conversations.filter(c => c.conversation_id && c.conversation_id.startsWith('wa_'));
  }
  if (filter === 'unread') {
    return conversations;
  }

  return conversations.sort((a, b) => {
    const dateA = new Date(a.last_message_at || 0);
    const dateB = new Date(b.last_message_at || 0);
    return dateB - dateA;
  });
}

async function saveCustomerContact(customerId, name, phone) {
  const numericId = customerId && /^\d+$/.test(String(customerId)) ? parseInt(customerId) : null;

  if (numericId) {
    const existing = await query('SELECT id FROM customers WHERE id = $1', [numericId]);
    if (existing.rows.length > 0) {
      await query(`UPDATE customers SET name = $1, phone = COALESCE(NULLIF($2, ''), phone), updated_at = NOW() WHERE id = $3`,
        [name, phone, numericId]);
      return { id: numericId, name, phone };
    }
  }

  const result = await query(
    `INSERT INTO customers (name, phone, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id`,
    [name, phone]
  );
  return { id: result.rows[0].id, name, phone };
}

async function updateMessageStatus(providerMessageId, status) {
  if (!providerMessageId) return;
  await query(
    `UPDATE messages SET status = $1 WHERE provider_message_id = $2`,
    [status, providerMessageId]
  );
}

async function getConversationByPhone(phone) {
  const cleanPhone = phone.replace(/[^\d]/g, '');
  const convId = 'wa_' + cleanPhone;
  const result = await query(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
    [convId]
  );
  return result.rows;
}

module.exports = {
  createSystemMessage,
  createTextMessage,
  createTemplateMessage,
  createPdfMessage,
  createLinkMessage,
  createStatusEvent,
  storeIncomingMessage,
  getOrCreateConversation,
  markConversationRead,
  getUnreadCount,
  getAllUnreadCounts,
  getConversationsWithDetails,
  saveCustomerContact,
  updateMessageStatus,
  getConversationByPhone,
  EVENT_MAP,
};