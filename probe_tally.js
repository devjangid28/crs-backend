require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const { XMLParser } = require('fast-xml-parser');

const COMPANY = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

async function exportCollection(type, methods, tagName) {
  const methodsXml = methods.map(m => `            <NATIVEMETHOD>${m}</NATIVEMETHOD>`).join('\n');
  const xml = `<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CRS_${tagName}</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="CRS_${tagName}" ISINITIALIZE="Yes">
        <TYPE>${type}</TYPE>
${methodsXml}
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 40000);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: (n) => [tagName].includes(n) });
  const parsed = parser.parse(r.body);
  const coll = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  const list = Array.isArray(coll) ? coll : [coll];
  const out = [];
  for (const c of list) {
    const es = c?.[tagName];
    if (!es) continue;
    const arr = Array.isArray(es) ? es : [es];
    for (const e of arr) {
      const rec = {};
      for (const m of methods) {
        const key = m.toUpperCase();
        const v = e?.[key];
        rec[m] = (v && typeof v === 'object') ? (v['#text'] ?? JSON.stringify(v)) : (v ?? '');
      }
      out.push(rec);
    }
  }
  return out;
}

async function main() {
  const which = process.argv[2] || 'all';

  if (which === 'vchtypes' || which === 'all') {
    const vts = await exportCollection('VoucherType', ['Name', 'Parent', 'VoucherType'], 'VOUCHERTYPE');
    console.log('=== VOUCHER TYPES ===');
    console.log(JSON.stringify(vts, null, 1));
  }

  if (which === 'purchaseledgers' || which === 'all') {
    const ledgers = await exportCollection('Ledger', ['Name', 'Parent'], 'LEDGER');
    const purchase = ledgers.filter(l => /PURCHASE|INPUT|CST|IGST/i.test(l.Name) && !/SALES/i.test(l.Name));
    console.log('=== PURCHASE/INPUT LEDGERS ===');
    console.log(JSON.stringify(purchase, null, 1));
  }

  if (which === 'po' || which === 'all') {
    try {
      const pos = await exportCollection('Voucher', ['VoucherNumber', 'Date', 'VoucherTypeName', 'PartyLedgerName'], 'VOUCHER');
      const purchaseOrders = (pos || []).filter(v => /purchase order/i.test(v.VoucherTypeName || ''));
      console.log('=== PURCHASE ORDER VOUCHERS (sample) ===');
      console.log(JSON.stringify(purchaseOrders.slice(0, 15), null, 1));
    } catch (e) {
      console.log('PO fetch error:', e.message);
    }
  }
}

main().catch((e) => console.error('ERROR:', e.message));
