require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

// Fetch ledger list from Tally to find exact names for Sales, CGST, SGST
const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Accounts</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml)
  .then(r => {
    // Extract all NAME tags from ledger entries
    const names = (r.body.match(/<NAME>[^<]+<\/NAME>/g) || [])
      .map(n => n.replace(/<\/?NAME>/g, '').trim())
      .filter(n => /sales|cgst|sgst|gst|output|tax/i.test(n));
    console.log('Matching ledgers:');
    names.forEach(n => console.log(' -', n));
    console.log('\nRaw (first 3000):', r.body.substring(0, 3000));
  })
  .catch(e => console.error(e.message));
