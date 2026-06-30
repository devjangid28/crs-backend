const config = require('../config');
const { query } = require('../config/database');
const { createTextMessage, createTemplateMessage, createPdfMessage } = require('./messagingService');
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

  if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
  if (cleaned.startsWith('91') && cleaned.length > 10) {
    return cleaned;
  }
  if (cleaned.startsWith('0')) cleaned = cleaned.slice(1);
  if (cleaned.length === 10) {
    return '91' + cleaned;
  }
  return null;
}

function isEnabled() {
  return !!(config.whatsapp.enabled &&
    config.whatsapp.phoneNumberId &&
    config.whatsapp.accessToken);
}

async function saveMessagesRecord(text, context, providerMessageId, messageType = 'text') {
  try {
    const convId = context.conversationId
      || (context.ticketId != null ? String(context.ticketId) : null)
      || (context.orderId != null ? String(context.orderId) : null)
      || ('wa_' + (context.phone || 'unknown'));

    if (messageType === 'template') {
      await createTemplateMessage({
        conversationId: convId,
        ticketId: context.ticketId || null,
        orderId: context.orderId || null,
        customerId: context.customerId || null,
        sender: context.sender || 'System',
        templateName: context.templateName || 'unknown',
        text: text,
        providerMessageId,
        phone: context.phone || null,
        status: 'sent',
      });
    } else {
      await createTextMessage({
        conversationId: convId,
        ticketId: context.ticketId || null,
        orderId: context.orderId || null,
        customerId: context.customerId || null,
        sender: context.sender || 'System',
        text: text,
        providerMessageId,
        phone: context.phone || null,
        status: 'sent',
      });
    }
  } catch (e) {
    wa.error('saveMessagesRecord failed', e, { convId: context.ticketId });
  }
}

async function logMessage(recipientPhone, messageBody, status, providerMessageId, errorMessage, ticketId, messageType, orderId) {
  try {
    await query(
      `INSERT INTO whatsapp_message_log
       (ticket_id, order_id, message_type, recipient_phone, message_body, status, provider_message_id, error_message, sent_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        ticketId || null,
        orderId || null,
        messageType || 'text',
        recipientPhone,
        messageBody,
        status,
        providerMessageId || null,
        errorMessage || null,
        status === 'sent' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      ]
    );
  } catch (e) {
    wa.error('logMessage failed', e, { recipientPhone, status, ticketId });
  }
}

const fs = require('fs');

async function uploadMedia(filePath, mimeType = 'application/pdf') {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    return { success: false, error: 'Phone Number ID not configured' };
  }

  const url = `${baseUrl}/media`;
  const token = config.whatsapp.accessToken;

  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'File not found at: ' + filePath };
  }

  const stats = fs.statSync(filePath);
  wa.info('uploadMedia: starting upload', {
    filePath,
    fileSize: stats.size,
    mimeType,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = filePath.split('\\').pop().split('/').pop();

    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="messaging_product"\r\n\r\n`;
    body += `whatsapp\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
    body += `Content-Type: ${mimeType}\r\n\r\n`;

    const bodyBuffer = Buffer.concat([
      Buffer.from(body, 'utf-8'),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'),
    ]);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: bodyBuffer,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      return { success: false, error: `HTTP ${response.status}: Non-JSON response` };
    }

    if (!response.ok) {
      const errorMessage = data?.error?.message || 'Unknown upload error';
      wa.error('WhatsApp media upload error', {
        status: response.status,
        error: data?.error,
        fullResponse: JSON.stringify(data).slice(0, 2000),
      });
      return { success: false, error: errorMessage, code: data?.error?.code };
    }

    const mediaId = data?.id;
    wa.info('uploadMedia: success', { mediaId });
    return { success: true, mediaId };
  } catch (err) {
    clearTimeout(timeout);
    wa.error('uploadMedia: exception', err);
    return { success: false, error: err.message };
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
      return { success: false, error: `HTTP ${response.status}: Non-JSON response` };
    }

    if (!response.ok) {
      const errorMessage = data?.error?.message || 'Unknown API error';
      wa.error('WhatsApp API error response', {
        status: response.status,
        statusText: response.statusText,
        error: data?.error,
        fullResponse: JSON.stringify(data).slice(0, 2000),
      });
      return { success: false, error: errorMessage, code: data?.error?.code, type: data?.error?.type, details: data?.error?.error_data || data?.error?.details };
    }

    const msgId = data?.messages?.[0]?.id;
    return { success: true, messageId: msgId, data };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { success: false, error: 'Request timed out after 30 seconds' };
    }
    return { success: false, error: err.message };
  }
}

async function sendTextMessage(to, text, context = {}, options = {}) {
  wa.info('sendTextMessage called', { to, textPreview: text?.slice(0, 60), context, options });

  if (!isEnabled()) {
    return { success: false, skipped: true };
  }

  const phone = formatPhone(to);
  if (!phone) {
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
    await logMessage(phone, text, 'sent', result.messageId, null, context.ticketId, 'text', context.orderId);
    if (!options.skipSave) {
      await saveMessagesRecord(text, { ...context, phone }, result.messageId, 'text');
    }
  } else {
    await logMessage(phone, text, 'failed', null, result.error, context.ticketId, 'text', context.orderId);
  }

  return result;
}

async function sendTemplateMessage(to, templateName, params, context = {}) {
  wa.info('sendTemplateMessage called', { to, templateName, params, context });

  if (!isEnabled()) {
    return { success: false, skipped: true };
  }

  const phone = formatPhone(to);
  if (!phone) {
    return { success: false, error: 'Invalid phone number' };
  }

  const bodyParams = (params || []).map(p => ({ type: 'text', text: String(p) }));
  const displayText = `[Template: ${templateName}] ` + (params || []).join(' | ');

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: config.whatsapp.templateLanguages[templateName] || 'en_GB' },
      components: [
        {
          type: 'body',
          parameters: bodyParams,
        },
      ],
    },
  };

  const result = await callWhatsAppApi(payload);

  if (result.success) {
    await logMessage(phone, displayText, 'sent', result.messageId, null, context.ticketId, 'template', context.orderId);
    await saveMessagesRecord(displayText, { ...context, phone, templateName, sender: context.sender || 'System' }, result.messageId, 'template');
  } else {
    await logMessage(phone, displayText, 'failed', null, result.error, context.ticketId, 'template', context.orderId);
  }

  return result;
}

async function sendMediaMessage(to, mediaUrl, mediaType, caption, context = {}) {
  wa.info('sendMediaMessage called', { to, mediaUrl, mediaType, caption });

  if (!isEnabled()) {
    return { success: false, skipped: true };
  }

  const phone = formatPhone(to);
  if (!phone) {
    return { success: false, error: 'Invalid phone number' };
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: mediaType,
    [mediaType]: {
      link: mediaUrl,
      caption: caption || '',
    },
  };

  const result = await callWhatsAppApi(payload);

  if (result.success) {
    await logMessage(phone, `[${mediaType}] ${caption || mediaUrl}`, 'sent', result.messageId, null, context.ticketId, mediaType, context.orderId);
  } else {
    await logMessage(phone, `[${mediaType}] ${caption || mediaUrl}`, 'failed', null, result.error, context.ticketId, mediaType, context.orderId);
  }

  return result;
}

async function sendTicketTemplate(ticket, store) {
  const estimatedPrice = ticket.estimated_price || '0';
  const formattedPrice = typeof estimatedPrice === 'number'
    ? `\u20B9${estimatedPrice.toLocaleString('en-IN')}`
    : `\u20B9${parseFloat(estimatedPrice).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  const params = [
    ticket.customer_name || 'Valued Customer',
    ticket.ticket_id || '',
    `${ticket.device_type || ''} ${ticket.brand || ''} ${ticket.model || ''}`.trim() || 'Device',
    formattedPrice,
  ];

  if (!ticket.customer_phone) {
    return { success: false, error: 'No customer phone' };
  }

  const context = { ticketId: ticket.id, customerId: ticket.customer_id, phone: ticket.customer_phone, sender: 'System' };
  const result = await sendTemplateMessage(ticket.customer_phone, config.whatsapp.templateName, params, context);
  return result;
}

async function sendTicketStatusTemplate(ticket, newStatus, store) {
  const templateMap = {
    'Pending': config.whatsapp.templatePending,
    'In Progress': config.whatsapp.templateInProgress,
    'Ready for Pickup': config.whatsapp.templateReadyForPickup,
    'Completed': config.whatsapp.templateCompleted,
    'Cancelled': config.whatsapp.templateCancelled,
  };

  const templateName = templateMap[newStatus];
  if (!templateName) {
    wa.info('sendTicketStatusTemplate: no template mapped for status', { newStatus });
    return { success: false, skipped: true, reason: 'No template mapped for status: ' + newStatus };
  }

  const phone = ticket.customer_phone;
  if (!phone) {
    return { success: false, error: 'No customer phone on ticket' };
  }

  const params = [
    ticket.customer_name || 'Valued Customer',
    ticket.ticket_id || '',
    `${ticket.device_type || ''} ${ticket.brand || ''} ${ticket.model || ''}`.trim() || 'Device',
  ];

  const context = { ticketId: ticket.id, customerId: ticket.customer_id, phone, templateName, sender: 'System' };
  const result = await sendTemplateMessage(phone, templateName, params, context);
  return result;
}

async function sendWelcome(phone, customerName, storeName, context) {
  const text = `Thank you for choosing ${storeName || 'Bluechip Computer System'}.\n\nWe sincerely appreciate your trust and confidence in our services.\n\nYour request has been successfully registered, and our technical team will begin processing it shortly.\n\nWe will keep you informed about every important update regarding your repair/order through WhatsApp.\n\nThank you for your continued support.`;
  return sendTextMessage(phone, text, context);
}

async function sendTicketDetails(phone, ticket, store) {
  const estimatedPrice = ticket.estimated_price || '0';
  const formattedPrice = typeof estimatedPrice === 'number'
    ? `\u20B9${estimatedPrice.toLocaleString('en-IN')}`
    : `\u20B9${parseFloat(estimatedPrice).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  const lines = [
    `*Ticket Confirmation*`,
    ``,
    `Customer: ${ticket.customer_name || 'N/A'}`,
    `Ticket No: ${ticket.ticket_id || 'N/A'}`,
    `Device: ${ticket.device_type || ''} ${ticket.brand || ''} ${ticket.model || ''}`.trim(),
  ];
  if (ticket.serial_number) lines.push(`Serial: ${ticket.serial_number}`);
  lines.push(`Issue: ${ticket.problem_description || ticket.issue_category || ''}`);
  lines.push(`Estimated Price: ${formattedPrice}`);
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
  const context = { ticketId: ticket.id, customerId: ticket.customer_id, sender: 'System' };
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
  const context = { orderId: order.id, sender: 'System' };
  return sendTextMessage(phone, lines.join('\n'), context);
}

async function notifyTicketCreated(ticket, store) {
  const phone = ticket.customer_phone;
  if (!phone) {
    return { success: false, error: 'No customer phone' };
  }

  const result = await sendTicketTemplate(ticket, store);
  return { success: result.success, template: result };
}

async function sendOrderTemplate(order, store) {
  const totalAmt = parseFloat(order.total_amount || 0);
  const formattedPrice = `\u20B9${totalAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  const params = [
    order.customer_name || 'Valued Customer',
    order.order_number || '',
    `${order.device_type || ''} ${order.brand || ''} ${order.model || ''}`.trim() || 'Device',
    formattedPrice,
  ];

  if (!order.mobile_number) {
    return { success: false, error: 'No customer phone' };
  }

  const context = { orderId: order.id, sender: 'System' };
  return sendTemplateMessage(order.mobile_number, config.whatsapp.orderTemplateName, params, context);
}

async function sendDocumentFile(to, filePath, caption, context = {}) {
  wa.info('sendDocumentFile called', { to, filePath, caption });

  if (!isEnabled()) {
    return { success: false, skipped: true };
  }

  const phone = formatPhone(to);
  if (!phone) {
    return { success: false, error: 'Invalid phone number' };
  }

  // Upload the file to WhatsApp servers first
  const uploadResult = await uploadMedia(filePath, 'application/pdf');
  if (!uploadResult.success) {
    wa.error('sendDocumentFile: media upload failed', { error: uploadResult.error });
    await logMessage(phone, `[document] upload failed: ${uploadResult.error}`, 'failed', null, uploadResult.error, context.ticketId, 'document', context.orderId);
    return { success: false, error: 'Media upload failed: ' + uploadResult.error };
  }

  const mediaId = uploadResult.mediaId;

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'document',
    document: {
      id: mediaId,
      caption: caption || '',
      filename: filePath.split('\\').pop().split('/').pop(),
    },
  };

  const result = await callWhatsAppApi(payload);

  if (result.success) {
    await logMessage(phone, `[document] ${caption || filePath}`, 'sent', result.messageId, null, context.ticketId, 'document', context.orderId);
  } else {
    await logMessage(phone, `[document] ${caption || filePath}`, 'failed', null, result.error, context.ticketId, 'document', context.orderId);
  }

  return result;
}

async function notifyOrderCreated(order, store) {
  const phone = order.mobile_number;
  if (!phone) {
    wa.error('notifyOrderCreated: no customer phone', { orderId: order.id, orderNumber: order.order_number });
    return { success: false, error: 'No customer phone' };
  }

  const templateResult = await sendOrderTemplate(order, store);
  if (templateResult.success) {
    wa.info('order_created template sent successfully', { orderId: order.id, orderNumber: order.order_number, messageId: templateResult.messageId });
    return { template: templateResult };
  }

  wa.error('order_created template send failed, falling back to text messages', {
    orderId: order.id,
    orderNumber: order.order_number,
    error: templateResult.error,
    code: templateResult.code,
    type: templateResult.type,
    details: templateResult.details,
    fullResponse: templateResult,
  });

  const ctx = { orderId: order.id, sender: 'System' };
  const welcome = await sendWelcome(phone, order.customer_name, store?.company_name, ctx);
  const details = await sendOrderDetails(phone, order, store);
  return { welcome, details, templateFallback: true, templateError: templateResult.error };
}

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  uploadMedia,
  sendDocumentFile,
  sendTicketTemplate,
  sendTicketStatusTemplate,
  sendOrderTemplate,
  sendWelcome,
  sendTicketDetails,
  sendOrderDetails,
  notifyTicketCreated,
  notifyOrderCreated,
  isEnabled,
  formatPhone,
};