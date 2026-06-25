const config = require('../config');
const { query } = require('../config/database');
const { createTextMessage } = require('./messagingService');
const { wa } = require('./logger');

const API_VERSION = 'v21.0';

function getBaseUrl() {
  const phoneNumberId = config.whatsapp.phoneNumberId;
  if (!phoneNumberId) {
    wa.error('getBaseUrl', new Error('WHATSAPP_PHONE_NUMBER_ID is not configured'));
    return null;
  }
  return `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}`;
}

function formatPhone(phone) {
  if (!phone) {
    wa.warn('formatPhone: empty input', { input: phone });
    return null;
  }
  const original = phone;
  let cleaned = phone.replace(/[\s\-\+\(\)]/g, '');
  wa.info('formatPhone: after cleaning', { original, cleaned });

  if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
  if (cleaned.startsWith('91') && cleaned.length > 10) {
    wa.info('formatPhone: valid with country code', { result: cleaned });
    return cleaned;
  }
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  if (cleaned.length === 10) {
    const result = '91' + cleaned;
    wa.info('formatPhone: added country code', { result });
    return result;
  }
  wa.warn('formatPhone: could not format', { original, cleaned });
  return null;
}

function isEnabled() {
  const enabled = !!(config.whatsapp.enabled &&
    config.whatsapp.phoneNumberId &&
    config.whatsapp.accessToken);
  return enabled;
}

async function saveMessagesRecord(text, context, providerMessageId) {
  try {
    const convId = context.ticketId != null ? String(context.ticketId) : (context.orderId != null ? String(context.orderId) : 'wa_' + (context.phone || 'unknown'));
    wa.info('saveMessagesRecord', { convId, ticketId: context.ticketId, customerId: context.customerId });
    await createTextMessage({
      conversationId: convId,
      ticketId: context.ticketId || null,
      customerId: context.customerId || null,
      sender: 'System',
      text: text,
    });
    wa.info('saveMessagesRecord: success');
  } catch (e) {
    wa.error('saveMessagesRecord failed', e, { convId: context.ticketId });
  }
}

async function logMessage(recipientPhone, messageBody, status, providerMessageId, errorMessage, ticketId, messageType) {
  try {
    await query(
      `INSERT INTO whatsapp_message_log
       (ticket_id, message_type, recipient_phone, message_body, status, provider_message_id, error_message, sent_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        ticketId || null,
        messageType || 'text',
        recipientPhone,
        messageBody,
        status,
        providerMessageId || null,
        errorMessage || null,
        status === 'sent' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      ]
    );
    wa.info('logMessage: inserted', { recipientPhone, status, messageType, ticketId });
  } catch (e) {
    wa.error('logMessage failed', e, { recipientPhone, status, ticketId });
  }
}

async function callWhatsAppApi(payload) {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    return { success: false, error: 'Phone Number ID not configured' };
  }

  const url = `${baseUrl}/messages`;
  const token = config.whatsapp.accessToken;

  wa.info('callWhatsAppApi: starting request', {
    url,
    tokenPrefix: token?.substring(0, 20) + '...',
  });
  wa.payload('request body', payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      wa.error('callWhatsAppApi: failed to parse JSON response', parseErr, { status: response.status, statusText: response.statusText });
      return { success: false, error: `HTTP ${response.status}: Non-JSON response` };
    }

    wa.response(`HTTP ${response.status}`, response.status, data);

    if (!response.ok) {
      const errorCode = data?.error?.code || 0;
      const errorMessage = data?.error?.message || 'Unknown API error';
      const errorType = data?.error?.type || '';
      const fbtrace = data?.error?.fbtrace_id || '';

      wa.error('callWhatsAppApi: API returned error', new Error(errorMessage), {
        httpStatus: response.status,
        errorCode,
        errorType,
        fbtrace,
        fullResponse: data,
      });

      return { success: false, error: errorMessage, code: errorCode, type: errorType };
    }

    const msgId = data?.messages?.[0]?.id;
    wa.info('callWhatsAppApi: success', { messageId: msgId, fullResponse: data });

    return { success: true, messageId: msgId, data };
  } catch (err) {
    clearTimeout(timeout);

    if (err.name === 'AbortError') {
      wa.error('callWhatsAppApi: request timed out after 30s', err);
      return { success: false, error: 'Request timed out after 30 seconds' };
    }

    wa.error('callWhatsAppApi: fetch failed', err, { url });
    return { success: false, error: err.message };
  }
}

async function sendTextMessage(to, text, context = {}) {
  wa.info('sendTextMessage called', { to, textPreview: text?.slice(0, 60), context });

  if (!isEnabled()) {
    wa.warn('sendTextMessage: WhatsApp disabled, would send', { to, text: text?.slice(0, 60) });
    return { success: false, skipped: true };
  }

  const phone = formatPhone(to);
  if (!phone) {
    wa.error('sendTextMessage: invalid phone', new Error('Invalid phone number'), { original: to });
    return { success: false, error: 'Invalid phone number' };
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: text },
  };

  const result = await callWhatsAppApi(payload);

  if (result.success) {
    await logMessage(phone, text, 'sent', result.messageId, null, context.ticketId, 'text');
    await saveMessagesRecord(text, context, result.messageId);
  } else {
    await logMessage(phone, text, 'failed', null, result.error, context.ticketId, 'text');
  }

  return result;
}

async function sendTemplateMessage(to, templateName, params, context = {}) {
  wa.info('sendTemplateMessage called', {
    to,
    templateName,
    params,
    context,
  });

  if (!isEnabled()) {
    wa.warn('sendTemplateMessage: WhatsApp disabled, would send template', { to, templateName, params });
    return { success: false, skipped: true };
  }

  const phone = formatPhone(to);
  if (!phone) {
    wa.error('sendTemplateMessage: invalid phone', new Error('Invalid phone number'), { original: to });
    return { success: false, error: 'Invalid phone number' };
  }

  const bodyParams = (params || []).map(p => ({ type: 'text', text: String(p) }));
  const displayText = `[Template: ${templateName}] ` + (params || []).join(' | ');

  wa.info('sendTemplateMessage: formatted', { phone, templateName, bodyParams, displayText });

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: bodyParams,
        },
      ],
    },
  };

  wa.payload('template request payload', payload);

  const result = await callWhatsAppApi(payload);

  if (result.success) {
    wa.info('sendTemplateMessage: API success', { phone, templateName, messageId: result.messageId });
    await logMessage(phone, displayText, 'sent', result.messageId, null, context.ticketId, 'template');
    await saveMessagesRecord(displayText, context, result.messageId);
  } else {
    wa.error('sendTemplateMessage: API failed', new Error(result.error), {
      phone,
      templateName,
      code: result.code,
      type: result.type,
      fullResult: result,
    });
    await logMessage(phone, displayText, 'failed', null, result.error, context.ticketId, 'template');
  }

  return result;
}

async function sendTicketTemplate(ticket, store) {
  const params = [
    ticket.customer_name || 'Valued Customer',
    ticket.ticket_id || '',
    `${ticket.device_type || ''} ${ticket.brand || ''} ${ticket.model || ''}`.trim() || 'Device',
  ];

  wa.info('sendTicketTemplate', {
    customerName: ticket.customer_name,
    ticketId: ticket.ticket_id,
    phone: ticket.customer_phone,
    ticketDbId: ticket.id,
    params,
    templateName: config.whatsapp.templateName,
  });

  if (!ticket.customer_phone) {
    wa.error('sendTicketTemplate: no customer phone', new Error('Missing phone'), { ticketId: ticket.id });
    return { success: false, error: 'No customer phone' };
  }

  const phone = ticket.customer_phone;
  const context = { ticketId: ticket.id, customerId: ticket.customer_id, phone };
  return sendTemplateMessage(phone, config.whatsapp.templateName, params, context);
}

async function sendWelcome(phone, customerName, storeName, context) {
  const text = `Thank you for choosing ${storeName || 'Bluechip Computer System'}.\n\nWe sincerely appreciate your trust and confidence in our services.\n\nYour request has been successfully registered, and our technical team will begin processing it shortly.\n\nWe will keep you informed about every important update regarding your repair/order through WhatsApp.\n\nThank you for your continued support.`;
  return sendTextMessage(phone, text, context);
}

async function sendTicketDetails(phone, ticket, store) {
  const lines = [
    `*Ticket Confirmation*`,
    ``,
    `Customer: ${ticket.customer_name || 'N/A'}`,
    `Ticket No: ${ticket.ticket_id || 'N/A'}`,
    `Device: ${ticket.device_type || ''} ${ticket.brand || ''} ${ticket.model || ''}`.trim(),
  ];
  if (ticket.serial_number) lines.push(`Serial: ${ticket.serial_number}`);
  lines.push(`Issue: ${ticket.problem_description || ticket.issue_category || ''}`);
  lines.push(`Status: ${ticket.status || 'New'}`);
  lines.push(`Date: ${new Date(ticket.created_at).toLocaleString('en-IN')}`);
  if (ticket.estimated_completion_date) {
    lines.push(`Est. Delivery: ${new Date(ticket.estimated_completion_date).toLocaleDateString('en-IN')}`);
  }
  lines.push(``);
  lines.push(`*${store?.company_name || 'Bluechip Computer System'}*`);
  if (store?.phone) lines.push(`Contact: ${store.phone}`);
  lines.push(``);
  lines.push(`We will notify you of all status updates.`);
  const context = { ticketId: ticket.id, customerId: ticket.customer_id };
  return sendTextMessage(phone, lines.join('\n'), context);
}

async function sendOrderDetails(phone, order, store) {
  const lines = [
    `*Order Confirmation*`,
    ``,
    `Customer: ${order.customer_name || 'N/A'}`,
    `Order No: ${order.order_number || 'N/A'}`,
    `Device: ${order.device_type || ''} ${order.brand || ''} ${order.model || ''}`.trim(),
  ];
  if (order.serial_number) lines.push(`Serial: ${order.serial_number}`);
  if (order.problem_description) lines.push(`Issue: ${order.problem_description}`);
  lines.push(`Status: ${order.payment_status || 'Unpaid'}`);
  lines.push(`Date: ${new Date(order.created_at).toLocaleString('en-IN')}`);
  if (order.delivery_date) {
    lines.push(`Est. Delivery: ${new Date(order.delivery_date).toLocaleDateString('en-IN')}`);
  }
  lines.push(``);
  lines.push(`*${store?.company_name || 'Bluechip Computer System'}*`);
  if (store?.phone) lines.push(`Contact: ${store.phone}`);
  lines.push(``);
  lines.push(`We will notify you of all status updates.`);
  const context = { orderId: order.id };
  return sendTextMessage(phone, lines.join('\n'), context);
}

async function notifyTicketCreated(ticket, store) {
  wa.info('notifyTicketCreated called', {
    ticketId: ticket.id,
    ticketNumber: ticket.ticket_id,
    customerPhone: ticket.customer_phone,
    customerName: ticket.customer_name,
  });

  const phone = ticket.customer_phone;
  if (!phone) {
    wa.error('notifyTicketCreated: no customer phone', new Error('Missing phone'), { ticketId: ticket.id });
    return { success: false, error: 'No customer phone' };
  }

  const result = await sendTicketTemplate(ticket, store);
  wa.info('notifyTicketCreated result', result);
  return { template: result };
}

async function notifyOrderCreated(order, store) {
  wa.info('notifyOrderCreated called', {
    orderId: order.id,
    customerPhone: order.mobile_number,
    customerName: order.customer_name,
  });

  const phone = order.mobile_number;
  if (!phone) {
    wa.error('notifyOrderCreated: no customer phone', new Error('Missing phone'), { orderId: order.id });
    return { success: false, error: 'No customer phone' };
  }

  const ctx = { orderId: order.id };
  const welcome = await sendWelcome(phone, order.customer_name, store?.company_name, ctx);
  const details = await sendOrderDetails(phone, order, store);
  return { welcome, details };
}

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  sendTicketTemplate,
  sendWelcome,
  sendTicketDetails,
  sendOrderDetails,
  notifyTicketCreated,
  notifyOrderCreated,
  formatPhone,
};
