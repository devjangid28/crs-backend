const { query } = require('../config/database');
const { generateServiceInvoiceFromHTML } = require('./pdfGenerator');
const {
  createPdfMessage,
  createSystemMessage,
  getOrCreateConversation,
  updateMessageStatusById,
} = require('./messagingService');
const { sendServiceInvoiceTemplate } = require('./whatsappService');

/**
 * Generates the Service Invoice for a Completed ticket, records it in the
 * conversation and delivers it to the customer through the approved
 * `service_invoice` WhatsApp template.
 *
 * This used to be a fire-and-forget helper that swallowed every error, which is
 * how a broken PDF renderer could stop the customer ever receiving their bill
 * while the staff member still saw "Status updated successfully". It now returns
 * an explicit outcome and, on failure, writes a visible note into the
 * conversation so the Messaging tab shows that the invoice was NOT sent.
 *
 * Never throws: the caller decides how loud the failure should be.
 */

// Coalesces simultaneous requests (double tap, mobile retry racing the original)
// into one send, without blocking a genuine later retry.
const inFlight = new Map();

async function noteFailure(ticketId, reason) {
  try {
    const tRes = await query('SELECT id, customer_name, customer_phone FROM tickets WHERE id = $1', [ticketId]);
    const ticket = tRes.rows[0];
    if (!ticket) return;
    // Same conversation the rest of the ticket's messages land in, so the note
    // is visible right where staff look for the invoice.
    const conv = await getOrCreateConversation(ticketId);
    await createSystemMessage({
      conversationId: conv ? conv.conversationId : 'conv_ticket_' + ticketId,
      ticketId,
      sender: 'System',
      event: 'service_invoice_failed',
      text: 'Service invoice NOT sent',
      description:
        `The invoice for ${ticket.customer_name || 'this ticket'} was NOT delivered to the customer. `
        + `Reason: ${reason} `
        + 'Use "Service Invoice" in Quick Actions to retry once this is fixed.',
      type: 'event',
      phone: ticket.customer_phone || null,
    });
  } catch (e) {
    console.error('Could not record service invoice failure:', e.message);
  }
}

async function dispatch(ticketId) {
  const key = String(ticketId);
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    let fileMsg = null;
    try {
      const pdf = await generateServiceInvoiceFromHTML(ticketId);
      const conv = await getOrCreateConversation(ticketId);
      fileMsg = await createPdfMessage({
        conversationId: conv ? conv.conversationId : null,
        ticketId,
        sender: 'System',
        fileName: pdf.fileName,
        fileSize: pdf.fileSize,
        documentType: 'service_invoice',
        event: 'Service invoice generated',
      });

      const tRes = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
      const ticket = tRes.rows[0];

      if (!ticket || !ticket.customer_phone || !pdf.filePath) {
        await updateMessageStatusById(fileMsg.id, null, 'failed');
        const reason = !ticket ? 'Ticket not found'
          : !ticket.customer_phone ? 'The customer has no phone number on the ticket'
            : 'The invoice file could not be located';
        await noteFailure(ticketId, reason);
        return { generated: true, delivered: false, invoiceNumber: pdf.invoiceNumber, reason };
      }

      const sendResult = await sendServiceInvoiceTemplate(ticket, pdf.filePath)
        .catch((e) => ({ success: false, error: e.message }));

      if (sendResult && sendResult.success && sendResult.messageId) {
        await updateMessageStatusById(fileMsg.id, sendResult.messageId, 'sent');
        return { generated: true, delivered: true, invoiceNumber: pdf.invoiceNumber };
      }

      // `skipped` means WhatsApp is disabled on this server (local/dev), which
      // is not a failure worth alarming anyone about.
      if (sendResult && sendResult.skipped) {
        await updateMessageStatusById(fileMsg.id, null, 'sending');
        return { generated: true, delivered: false, skipped: true, invoiceNumber: pdf.invoiceNumber };
      }

      const reason = (sendResult && (sendResult.error || sendResult.reason))
        || 'WhatsApp did not accept the invoice template';
      await updateMessageStatusById(fileMsg.id, null, 'failed');
      await noteFailure(ticketId, reason);
      return { generated: true, delivered: false, invoiceNumber: pdf.invoiceNumber, reason };
    } catch (e) {
      const reason = e && e.message ? e.message : String(e);
      console.error('Auto-generate service invoice failed:', reason);
      if (fileMsg) await updateMessageStatusById(fileMsg.id, null, 'failed').catch(() => {});
      await noteFailure(ticketId, reason);
      return { generated: false, delivered: false, reason };
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

module.exports = { dispatch };