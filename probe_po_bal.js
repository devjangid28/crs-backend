require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const { XMLParser } = require('fast-xml-parser');

const COMPANY = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

async function exportVouchers(typeName) {
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2024</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE><VOUCHERTYPENAME>${typeName}</VOUCHERTYPENAME></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 40000);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: (n) => ['VOUCHER'].includes(n) });
  const parsed = parser.parse(r.body);
  const body = parsed?.ENVELOPE?.BODY;
  let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
  if (!messages) messages = body?.DATA?.TALLYMESSAGE;
  if (!messages) return [];
  const msgArr = Array.isArray(messages) ? messages : [messages];
  const out = [];
  for (const msg of msgArr) {
    const vs = msg?.VOUCHER;
    if (!vs) continue;
    const vArr = Array.isArray(vs) ? vs : [vs];
    for (const v of vArr) {
      out.push({
        number: v?.VOUCHERNUMBER || v?.['@_VOUCHERNUMBER'] || '',
        date: v?.DATE || '',
        party: v?.PARTYLEDGERNAME || v?.PARTYNAME || '',
        type: v?.VOUCHERTYPENAME || '',
      });
    }
  }
  return out;
}

async function exportLedgerBalances() {
  const xml = `<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CRSBal</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="CRSBal" ISINITIALIZE="Yes">
        <TYPE>Ledger</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
        <NATIVEMETHOD>Parent</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 40000);
  console.log('BALANCES SIZE:', r.body.length);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: (n) => ['LEDGER'].includes(n) });
  const parsed = parser.parse(r.body);
  const coll = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  const list = Array.isArray(coll) ? coll : [coll];
  const out = [];
  for (const c of list) {
    const es = c?.LEDGER;
    if (!es) continue;
    const arr = Array.isArray(es) ? es : [es];
    for (const e of arr) {
      const name = e?.NAME || e?.['@_NAME'] || '';
      const bal = e?.CLOSINGBALANCE;
      out.push({ name, parent: e?.PARENT?.['#text'] || e?.PARENT || '', closing: (bal && typeof bal === 'object') ? (bal['#text'] ?? '') : (bal ?? '') });
    }
  }
  return out;
}

async function main() {
  const which = process.argv[2] || 'po';
  if (which === 'po') {
    const pos = await exportVouchers('Purchase Order');
    console.log('=== PURCHASE ORDERS ===');
    console.log(JSON.stringify(pos.slice(0, 20), null, 1));
    console.log('PO count:', pos.length);
  } else if (which === 'bal') {
    const bals = await exportLedgerBalances();
    console.log('total ledger balances:', bals.length);
    const sample = bals.filter(b => b.name === 'COMPU CRAFTS' || b.name === 'ANURAG INFOTECH' || b.name === 'KESARIYA TRADING CO');
    console.log('SAMPLE:', JSON.stringify(sample, null, 1));
    const purchaseAccounts = bals.filter(b => /purchase accounts/i.test(b.parent));
    console.log('PURCHASE ACCOUNTS:', JSON.stringify(purchaseAccounts, null, 1));
  }
}

main().catch((e) => console.error('ERROR:', e.message));
