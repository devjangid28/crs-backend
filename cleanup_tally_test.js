require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const COMPANY = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

async function deleteMasters(kind, tag, name) {
  const parent = kind === 'stock' ? 'Primary' : 'Sundry Creditors';
  const xml = `<ENVELOPE>
    <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
    <BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY></STATICVARIABLES>
    </REQUESTDESC><REQUESTDATA>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <${tag} NAME="${name}" ACTION="Delete">
          <NAME>${name}</NAME>
          <PARENT>${parent}</PARENT>
        </${tag}>
      </TALLYMESSAGE>
    </REQUESTDATA></IMPORTDATA></BODY>
  </ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 30000);
  const created = (r.body.match(/<CREATED>(\d+)<\/CREATED>/) || [])[1];
  const errors = (r.body.match(/<ERRORS>(\d+)<\/ERRORS>/) || [])[1];
  const err = (r.body.match(/<LINEERROR>(.*?)<\/LINEERROR>/) || [])[1] || '';
  console.log(`${tag} DELETE ${name}: created=${created} errors=${errors} ${err ? '| ' + err.slice(0, 120) : ''}`);
}

async function main() {
  const names = [
    ['stock', 'STOCKITEM', 'TEST PURCHASE FLOW LAPTOP'],
    ['ledger', 'LEDGER', 'TEST PURCHASE SUPPLIER'],
    ['stock', 'STOCKITEM', 'TEST PURCHASE E2E LAPTOP'],
    ['ledger', 'LEDGER', 'TEST PURCHASE E2E SUP'],
    ['stock', 'STOCKITEM', 'TEST PO FIELD LAPTOP'],
    ['ledger', 'LEDGER', 'TEST PO FIELD SUP'],
    ['stock', 'STOCKITEM', 'TEST FINAL FLOW LAPTOP'],
    ['ledger', 'LEDGER', 'TEST FINAL FLOW SUP'],
  ];
  for (const [k, tag, n] of names) {
    await deleteMasters(k, tag, n);
  }
}

main().catch((e) => console.error('ERROR:', e.message));
