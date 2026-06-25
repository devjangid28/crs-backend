const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
const WA_LOG = path.join(LOG_DIR, 'whatsapp.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function ts() {
  return new Date().toISOString();
}

function append(filepath, lines) {
  try {
    fs.appendFileSync(filepath, lines, 'utf8');
  } catch (e) {
    console.error('[Logger] Failed to write log:', e.message);
  }
}

const wa = {
  info(msg, data) {
    const line = `[${ts()}] [INFO] ${msg} ${data ? JSON.stringify(data, null, 2) : ''}\n`;
    console.log(line.trimEnd());
    append(WA_LOG, line);
  },
  warn(msg, data) {
    const line = `[${ts()}] [WARN] ${msg} ${data ? JSON.stringify(data, null, 2) : ''}\n`;
    console.warn(line.trimEnd());
    append(WA_LOG, line);
  },
  error(msg, err, extra) {
    const errObj = {
      message: err?.message || err,
      stack: err?.stack || undefined,
      ...(extra || {}),
    };
    const line = `[${ts()}] [ERROR] ${msg} ${JSON.stringify(errObj, null, 2)}\n`;
    console.error(line.trimEnd());
    append(WA_LOG, line);
  },
  payload(label, body) {
    const line = `[${ts()}] [PAYLOAD] ${label}\n${JSON.stringify(body, null, 2)}\n`;
    console.log(`[WhatsApp] ${label}:`, JSON.stringify(body).slice(0, 200) + '...');
    append(WA_LOG, line);
  },
  response(label, status, body) {
    const line = `[${ts()}] [RESPONSE] ${label} | Status: ${status}\n${JSON.stringify(body, null, 2)}\n`;
    console.log(`[WhatsApp] ${label} | Status: ${status}`, JSON.stringify(body).slice(0, 300));
    append(WA_LOG, line);
  },
};

module.exports = { wa, LOG_DIR, WA_LOG };
