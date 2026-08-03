require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const COMPANY = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

async function main() {
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2025</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 40000);
  console.log('SIZE:', r.body.length);
  const fs = require('fs');
  fs.writeFileSync('probe_purchase_daybook.xml', r.body);
  // Find the first <VOUCHER ...> ... </VOUCHER> block
  const m = r.body.match(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/);
  if (m) {
    console.log('=== FIRST PURCHASE VOUCHER ===');
    console.log(m[0].slice(0, 6000));
  } else {
    console.log('No <VOUCHER> found. Raw head:', r.body.slice(0, 2000));
  }
}

main().catch((e) => console.error('ERROR:', e.message));
