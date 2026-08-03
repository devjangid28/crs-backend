require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const COMPANY = 'BLUECHIP COMPUTER SYSTEM - 2024-25';
const XML = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2026</SVFROMDATE><SVTODATE>31-Mar-2027</SVTODATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

async function main() {
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(XML),
  }, XML, 60000);
  const body = r.body;
  const parties = ['TEST PURCHASE SUPPLIER', 'TEST PURCHASE E2E SUP', 'TEST PO FIELD SUP', 'TEST FINAL FLOW SUP', 'TEST PURCHASE FLOW LAPTOP'];
  const blocks = body.split('</VOUCHER>');
  for (const b of blocks) {
    for (const p of parties) {
      if (b.includes(p)) {
        const remote = (b.match(/REMOTEID="([^"]+)"/) || [])[1] || '';
        const vchkey = (b.match(/VCHKEY="([^"]+)"/) || [])[1] || '';
        const vchnum = (b.match(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/) || [])[1] || '';
        const type = (b.match(/VCHTYPE="([^"]+)"/) || [])[1] || '';
        console.log(`${p} | num=${vchnum} | type=${type} | REMOTEID=${remote} | VCHKEY=${vchkey}`);
      }
    }
  }
}

main().catch((e) => console.error('ERROR:', e.message));
