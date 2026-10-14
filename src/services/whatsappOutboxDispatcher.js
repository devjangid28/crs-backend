/**
 * Outbox dispatcher.
 *
 * Turns a claimed outbox row into an actual WhatsApp send.
 *
 * CONTENT IS RE-LOADED FROM THE DATABASE, NOT FROM THE ROW.
 * The outbox stores only identifiers (source_type / source_id / recipient).
 * At send time we re-read the order or ticket and call the SAME notify* helper
 * the inline path uses today. Two consequences:
 *
 *   1. Messages are byte-identical to the current inline behaviour, because we
 *      reuse sendOrderTemplate / sendTicketTemplate unchanged.
 *   2. Corrections made between enqueue and send are picked up automatically,
 *      and no customer name, device or price is persisted in the outbox.
 *
 * Trade-off we accepted: if the source row is deleted before the send, the
 * message cannot be built. That becomes a terminal `failed` row (visible,
 * alertable) rather than a silently dropped notification.
 */

const { query } = require('../config/database');

class DispatchError extends Error {
  /**
   * @param {string} message
   * @param {object} meta
   * @param {'retry'|'failed'|'ambiguous'} meta.kind  outcome class
   * @param {number}  [meta.status]  provider HTTP status, when there was one
   * @param {string}  [meta.ambiguous] true = may have been delivered, do NOT retry
   */
  constructor(message, { kind = 'retry', status, ambiguous = false } = {}) {
    super(message);
    this.name = 'DispatchError';
    this.dispatchKind = kind;
    if (status !== undefined) this.status = status;
    if (ambiguous) this.ambiguous = true;
  }
}

async function loadStore(storeId) {
  if (storeId === null || storeId === undefined) return null;
  const r = await query('SELECT * FROM stores WHERE id = $1 LIMIT 1', [storeId]);
  return r.rows[0] || null;
}

async function loadOrder(orderId) {
  const r = await query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId]);
  return r.rows[0] || null;
}

async function loadTicket(ticketId) {
  const r = await query('SELECT * FROM tickets WHERE id = $1 LIMIT 1', [ticketId]);
  return r.rows[0] || null;
}

/**
 * Pull a provider status out of the shapes sendTemplateMessage returns.
 * It can be `{success:false, code, type, details}` or `{success:true, messageId}`.
 */
function describeFailure(result) {
  if (!result || result.success !== false) return null;
  const code = result.code || result.status || null;
  const type = result.type || null;
  return {
    code: code === null ? null : String(code),
    type: type === null ? null : String(type),
    message: String(result.error || 'template send failed'),
  };
}

/** Meta's re-engagement window errors are deterministic - never worth retrying. */
function isReengagement(meta) {
  const text = `${meta.type || ''} ${meta.message || ''}`.toLowerCase();
  return text.includes('1310') || text.includes('131026') || text.includes('re-engage')
    || text.includes('reengage') || text.includes('24 hour') || text.includes('service window');
}

async function sendOrderCreated(row) {
  const wa = require('./whatsappService');
  const order = await loadOrder(row.source_id);
  if (!order) {
    throw new DispatchError(`order ${row.source_id} no longer exists`, { kind: 'failed' });
  }
  const store = await loadStore(order.store_id);

  // Same helper the inline route uses. Its internal fallback chain
  // (template -> welcome + details text) is preserved verbatim.
  const result = await wa.notifyOrderCreated(order, store);

  const template = result && result.template;
  if (template && template.success) {
    return { messageId: template.messageId || null };
  }

  const meta = describeFailure(template);
  if (meta) {
    if (isReengagement(meta)) {
      throw new DispatchError(`order_created rejected: ${meta.message}`, { kind: 'failed' });
    }
    // notifyOrderCreated already fell back to plain text when the template
    // failed, so the customer was still reached. Do not re-send.
    throw new DispatchError(
      `order_created template failed and text fallback was used: ${meta.message}`,
      { kind: 'failed', status: 400 }
    );
  }
  if (result && result.templateFallback) {
    return { messageId: null, fallback: true };
  }
  throw new DispatchError('order_created produced no template result', { kind: 'retry' });
}

async function sendTicketCreated(row) {
  const wa = require('./whatsappService');
  const ticket = await loadTicket(row.source_id);
  if (!ticket) {
    throw new DispatchError(`ticket ${row.source_id} no longer exists`, { kind: 'failed' });
  }
  const store = await loadStore(ticket.store_id);

  const result = await wa.notifyTicketCreated(ticket, store);

  const template = result && result.template;
  if (template && template.success) {
    return { messageId: template.messageId || null };
  }

  const meta = describeFailure(template);
  if (meta) {
    throw new DispatchError(`ticket_created rejected: ${meta.message}`, {
      kind: 'failed',
      status: 400,
    });
  }
  throw new DispatchError('ticket_created produced no template result', { kind: 'retry' });
}

/** message_type -> handler. */
const HANDLERS = {
  order_created: sendOrderCreated,
  ticket_created: sendTicketCreated,
};

/**
 * Dispatch one claimed row.
 * Resolves to { messageId, fallback? } on success.
 * Throws DispatchError carrying the outcome class.
 */
async function dispatch({ row }) {
  const handler = HANDLERS[row.message_type];
  if (!handler) {
    throw new DispatchError(`no handler for message_type "${row.message_type}"`, { kind: 'failed' });
  }
  return handler(row);
}

module.exports = {
  dispatch,
  HANDLERS,
  DispatchError,
  loadOrder,
  loadTicket,
  loadStore,
  describeFailure,
  isReengagement,
};