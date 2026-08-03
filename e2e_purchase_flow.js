require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const { XMLParser } = require('fast-xml-parser');

const TOKEN = '32ab146a498e4d01b5ef332274a62031e42fa6578cd149f193ef300769686594';
const BASE = 'http://localhost:5000/api';
const COMPANY = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, ...(opts.headers || {}) },
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch (e) { return { status: res.status, body: text }; }
}

async function tallyVerify(name) {
  const xml = `<ENVELOPE>
    <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CRSVerifyE2E</ID></HEADER>
    <BODY><DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL><TDLMESSAGE>
        <COLLECTION NAME="CRSVerifyE2E" ISINITIALIZE="Yes">
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
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: (n) => ['STOCKITEM'].includes(n) });
  const parsed = parser.parse(r.body);
  const coll = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  const list = Array.isArray(coll) ? coll : [coll];
  for (const c of list) {
    const es = c?.STOCKITEM;
    if (!es) continue;
    const arr = Array.isArray(es) ? es : [es];
    for (const e of arr) {
      const nm = e?.NAME || e?.['@_NAME'] || '';
      if (nm === name) {
        return { parent: e?.PARENT?.['#text'] || e?.PARENT || '', closing: e?.CLOSINGBALANCE?.['#text'] ?? e?.CLOSINGBALANCE ?? '' };
      }
    }
  }
  return null;
}

async function main() {
  console.log('=== 1. GET /api/tally/purchase-orders ===');
  const pos = await api('/tally/purchase-orders');
  console.log('status:', pos.status, 'count:', pos.body.count, 'purchaseOrders:', JSON.stringify(pos.body.purchaseOrders));

  console.log('\n=== 2. GET /api/tally/purchase-ledgers ===');
  const pls = await api('/tally/purchase-ledgers');
  console.log('status:', pls.status, 'count:', pls.body.count);
  console.log('ledgers:', JSON.stringify(pls.body.purchaseLedgers));

  console.log('\n=== 3. GET /api/tally/ledger-balance?name=COMPU CRAFTS ===');
  const bal = await api('/tally/ledger-balance?name=' + encodeURIComponent('COMPU CRAFTS'));
  console.log('status:', bal.status, JSON.stringify(bal.body));

  const TEST_NAME = 'TEST PURCHASE E2E LAPTOP';
  const SERIAL = 'TE2E-SER-778899';
  const SUPPLIER = 'TEST PURCHASE E2E SUP';

  console.log('\n=== 4. POST /api/inventory (add item with purchase details) ===');
  const inv = await api('/inventory', {
    method: 'POST',
    body: JSON.stringify({
      productName: TEST_NAME,
      brand: 'TEST', model: 'E2E', category: 'Laptop',
      serialNumber: SERIAL,
      purchasePrice: 45000, sellingPrice: 54000,
      storeId: 1, supplier: SUPPLIER,
      tallyCategory: 'Desktop', tallyCategoryType: 'category',
      gstApplicability: 'Applicable', hsnCode: '84713000', hsnDescription: 'Laptop Computer',
      gstRate: 18, typeOfSupply: 'Goods', gstTaxability: 'Taxable',
      purchaseOrderNo: '', supplierInvoiceNo: 'INV-E2E-778899', purchaseLedger: 'PURCHASE @ 18%'
    }),
  });
  console.log('status:', inv.status, 'message:', inv.body.message, 'id:', inv.body.data?.id, 'serial:', inv.body.data?.serial_number);

  console.log('\n=== 5. Wait for background push, then verify in Tally ===');
  await new Promise(r => setTimeout(r, 8000));
  const found = await tallyVerify(TEST_NAME);
  console.log('TALLY STOCK ITEM:', JSON.stringify(found));
  if (found) console.log('CATEGORY OK:', found.parent === 'Desktop', '| CLOSING QTY:', found.closing);
}

main().catch((e) => console.error('ERROR:', e.message));
