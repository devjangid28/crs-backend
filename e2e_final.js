require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const TOKEN = '32ab146a498e4d01b5ef332274a62031e42fa6578cd149f193ef300769686594';
const BASE = 'http://localhost:5000/api';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, ...(opts.headers || {}) },
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch (e) { return { status: res.status, body: text }; }
}

async function dayBookFind(party) {
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2026</SVFROMDATE><SVTODATE>31-Mar-2027</SVTODATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 60000);
  const body = r.body;
  const idx = body.indexOf(party);
  if (idx < 0) return null;
  const chunk = body.substring(idx, idx + 2500);
  const num = (chunk.match(/<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/) || [])[1] || '';
  const ref = (chunk.match(/<REFERENCE>([^<]*)<\/REFERENCE>/) || [])[1] || '';
  return { num, ref };
}

async function tallyItem(name) {
  const xml = `<ENVELOPE>
    <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CRSV2</ID></HEADER>
    <BODY><DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL><TDLMESSAGE>
        <COLLECTION NAME="CRSV2" ISINITIALIZE="Yes">
          <TYPE>StockItem</TYPE>
          <NATIVEMETHOD>Name</NATIVEMETHOD>
          <NATIVEMETHOD>Parent</NATIVEMETHOD>
          <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
        </COLLECTION>
      </TDLMESSAGE></TDL>
    </DESC></BODY>
  </ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 40000);
  const { XMLParser } = require('fast-xml-parser');
  const p = new XMLParser({ ignoreAttributes: false, textNodeName: '#text', isArray: (n) => ['STOCKITEM'].includes(n) });
  const parsed = p.parse(r.body);
  const coll = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  const list = Array.isArray(coll) ? coll : [coll];
  for (const c of list) {
    const es = c?.STOCKITEM;
    if (!es) continue;
    const arr = Array.isArray(es) ? es : [es];
    for (const e of arr) {
      if ((e?.NAME || '') === name) return { parent: e?.PARENT?.['#text'] || '', closing: e?.CLOSINGBALANCE?.['#text'] ?? '' };
    }
  }
  return null;
}

async function main() {
  const NAME = 'TEST FINAL FLOW LAPTOP';
  const SERIAL = 'TFF-SER-112233';
  const SUP = 'TEST FINAL FLOW SUP';
  const inv = await api('/inventory', {
    method: 'POST',
    body: JSON.stringify({
      productName: NAME, brand: 'TEST', model: 'FIN', category: 'Laptop',
      serialNumber: SERIAL, purchasePrice: 32000, sellingPrice: 39999, storeId: 1,
      supplier: SUP, tallyCategory: 'Notebook', tallyCategoryType: 'category',
      gstApplicability: 'Applicable', hsnCode: '84713000', hsnDescription: 'Laptop Computer',
      gstRate: 18, typeOfSupply: 'Goods', gstTaxability: 'Taxable',
      purchaseOrderNo: 'PO-99', supplierInvoiceNo: 'SUP-INV-112233', purchaseLedger: 'PURCHASE @ 18%'
    }),
  });
  console.log('ADD:', inv.status, inv.body.message, 'id:', inv.body.data?.id);
  await new Promise(r => setTimeout(r, 8000));
  const item = await tallyItem(NAME);
  console.log('STOCK:', JSON.stringify(item), '| CATEGORY OK:', item?.parent === 'Notebook', '| QTY:', item?.closing);
  const vch = await dayBookFind(SUP);
  console.log('VOUCHER:', JSON.stringify(vch), '| REF=supplier invoice OK:', vch?.ref === 'SUP-INV-112233');
}

main().catch((e) => console.error('ERROR:', e.message));
