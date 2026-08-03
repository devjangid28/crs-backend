require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const { XMLParser } = require('fast-xml-parser');

const COMPANY = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

async function dayBook(from, to) {
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY><SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 60000);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: (n) => ['VOUCHER'].includes(n) });
  const parsed = parser.parse(r.body);
  const body = parsed?.ENVELOPE?.BODY;
  let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE || body?.DATA?.TALLYMESSAGE;
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
        date: v?.DATE || v?.['@_DATE'] || '',
        party: v?.PARTYLEDGERNAME || v?.PARTYNAME || '',
        type: v?.VOUCHERTYPENAME || v?.['@_VOUCHERTYPENAME'] || '',
        guid: v?.['@_REMOTEID'] || '',
      });
    }
  }
  return out;
}

async function main() {
  const all = await dayBook('01-Apr-2025', '31-Mar-2026');
  console.log('TOTAL VOUCHERS (FY 25-26):', all.length);
  const byType = {};
  for (const v of all) byType[v.type] = (byType[v.type] || 0) + 1;
  console.log('BY TYPE:', JSON.stringify(byType));
  const pos = all.filter(v => /purchase order/i.test(v.type));
  console.log('PO SAMPLE:', JSON.stringify(pos.slice(0, 15), null, 1));
}

main().catch((e) => console.error('ERROR:', e.message));
