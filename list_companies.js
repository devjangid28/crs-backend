require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

// Try to get list of companies from Tally
const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml)
  .then(r => {
    console.log('RESPONSE:', r.body.substring(0, 5000));
  })
  .catch(e => console.error(e.message));
