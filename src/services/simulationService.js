const { query } = require('../config/database');
const { logAudit, actions } = require('./auditService');

const SIMULATION_PREFIX = '[SIMULATION MODE]';

async function createSimulationEvent({
  conversationId,
  ticketId,
  customerId,
  itemType,
  itemName,
}) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const result = await query(
    `INSERT INTO messages (conversation_id, sender, customer_id, ticket_id, type, event, text, description, status, created_at)
     VALUES ($1, 'System', $2, $3, 'event', 'simulation_delivery', $4, $5, 'sent', $6) RETURNING id`,
    [conversationId, customerId, ticketId, `${SIMULATION_PREFIX} ${itemName} Delivered`, `${itemType} delivery simulated. No actual WhatsApp message was sent.`, now]
  );
  return result.rows[0];
}

async function simulateDelivery({ conversationId, ticketId, customerId, itemType, itemName, performedBy = 'System' }) {
  const event = await createSimulationEvent({
    conversationId,
    ticketId,
    customerId,
    itemType,
    itemName,
  });

  await logAudit({
    action: actions.MESSAGE_SENT,
    ticketId,
    entityType: 'simulation',
    entityId: String(event.id),
    performedBy,
    details: { simulation: true, itemType, itemName, messageId: event.id },
  });
}

module.exports = { simulateDelivery, SIMULATION_PREFIX };
