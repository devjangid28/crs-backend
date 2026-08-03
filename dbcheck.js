require('dotenv').config();
const t = require('./src/services/tallyService');
const fs = require('fs');

(async () => {
  const cfg = t.getTallyConfig();
  const url = `http://${cfg.host}:${cfg.port}`;
  const exp = t.buildExportRequest(null, cfg.company);
  const r2 = await t.rawHttpRequest(url, 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(exp) }, exp, 60000);
  const body = r2.body;
  const matches = [];
  let idx = 0;
  while (true) {
    const m = body.indexOf('SERIAL', idx);
    if (m === -1) break;
    matches.push(body.substring(Math.max(0, m - 150), m + 200));
    idx = m + 6;
  }
  fs.writeFileSync('serial_matches.txt', matches.slice(0, 12).join('\n\n==========\n\n'));
  console.log('written', Math.min(matches.length, 12), 'matches');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
