require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2026</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml)
  .then(r => {
    const ledgers = [...new Set((r.body.match(/<LEDGERNAME>[^<]+<\/LEDGERNAME>/g) || []).map(n => n.replace(/<\/?LEDGERNAME>/g, '').trim()))];
    const stockItems = [...new Set((r.body.match(/<STOCKITEMNAME>[^<]+<\/STOCKITEMNAME>/g) || []).map(n => n.replace(/<\/?STOCKITEMNAME>/g, '').trim()))];
    const parties = [...new Set((r.body.match(/<PARTYLEDGERNAME>[^<]+<\/PARTYLEDGERNAME>/g) || []).map(n => n.replace(/<\/?PARTYLEDGERNAME>/g, '').trim()))];
    console.log('LEDGER NAMES:', ledgers.join(' | '));
    console.log('STOCK ITEMS:', stockItems.join(' | '));
    console.log('PARTY LEDGERS:', parties.join(' | '));
  })
  .catch(e => console.error(e.message));
