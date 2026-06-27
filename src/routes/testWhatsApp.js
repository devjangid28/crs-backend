const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { sendTemplateMessage, formatPhone, sendTextMessage } = require('../services/whatsappService');
const { wa } = require('../services/logger');

// POST /api/test-whatsapp - Send a test template message
router.post('/test-whatsapp', async (req, res) => {
  try {
    const { phone, templateName, params } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }

    wa.info('=== TEST ENDPOINT CALLED ===', { phone, templateName, params });

    const formatted = formatPhone(phone);
    wa.info('Test: formatted phone', { original: phone, formatted });

    const name = templateName || process.env.WHATSAPP_TEMPLATE_NAME || 'ticket_created';
    const templateParams = params || ['Test Customer', 'TKT-0000', 'Test Device'];

    wa.info('Test: sending template', { name, templateParams });

    const result = await sendTemplateMessage(phone, name, templateParams, {});

    wa.info('Test: result', result);

    res.json({
      success: result.success,
      data: result,
      meta: {
        phoneOriginal: phone,
        phoneFormatted: formatted,
        templateName: name,
        templateParams,
      },
    });
  } catch (err) {
    wa.error('Test endpoint error', err);
    res.status(500).json({ success: false, message: err.message, stack: err.stack });
  }
});

// GET /api/test-whatsapp - Simple health/status for the test endpoint
router.get('/test-whatsapp', (req, res) => {
  const config = require('../config');
  res.json({
    success: true,
    message: 'WhatsApp test endpoint ready',
    config: {
      enabled: config.whatsapp.enabled,
      hasPhoneNumberId: !!config.whatsapp.phoneNumberId,
      hasAccessToken: !!config.whatsapp.accessToken,
      phoneNumberId: config.whatsapp.phoneNumberId ? config.whatsapp.phoneNumberId.substring(0, 5) + '...' : null,
      templateName: config.whatsapp.templateName,
    },
  });
});

// GET /api/test-db-ticket/:id - Retrieve a ticket by ID to inspect its data
router.get('/test-db-ticket/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await query('SELECT id, ticket_id, customer_name, customer_phone, device_type, brand, model, issue_category, status, created_at FROM tickets WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/test-whatsapp-log - View recent WhatsApp log entries
router.get('/test-whatsapp-log', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM whatsapp_message_log ORDER BY created_at DESC LIMIT 20'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/test-whatsapp-log-file - Read the WhatsApp log file
router.get('/test-whatsapp-log-file', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const logFile = path.join(__dirname, '../../logs/whatsapp.log');

  if (fs.existsSync(logFile)) {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const tail = lines.slice(-100); // last 100 lines

    // Also get the raw file for download
    res.json({
      success: true,
      data: {
        totalLines: lines.length,
        tail: tail,
        filePath: logFile,
      },
    });
  } else {
    res.json({ success: true, data: { totalLines: 0, tail: [], filePath: logFile, message: 'Log file not yet created' } });
  }
});

// POST /api/test-whatsapp-incoming - Simulate an incoming webhook message
router.post('/test-whatsapp-incoming', async (req, res) => {
  try {
    const { from, text, profileName } = req.body;
    if (!from) {
      return res.status(400).json({ success: false, message: 'from (phone number) is required' });
    }

    const { storeIncomingMessage } = require('../services/messagingService');

    wa.info('=== TEST INCOMING WEBHOOK ===', { from, text, profileName });

    const result = await storeIncomingMessage({
      from,
      waId: 'test_' + Date.now(),
      text: text || 'Test message from WhatsApp',
      profileName: profileName || 'Test Customer',
    });

    wa.info('=== TEST INCOMING RESULT ===', result);

    res.json({
      success: true,
      data: result,
      message: `Simulated incoming message from ${from}. Refresh the Messaging page to see it.`,
    });
  } catch (err) {
    wa.error('Test incoming endpoint error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
