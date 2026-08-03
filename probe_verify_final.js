require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const { XMLParser } = require('fast-xml-parser');

async function main() {
  const xml = `<ENVELOPE>
    <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CRSV3</ID></HEADER>
    <BODY><DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL><TDLMESSAGE>
        <COLLECTION NAME="CRSV3" ISINITIALIZE="Yes">
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
  console.log('body has FINAL FLOW:', r.body.includes('TEST FINAL FLOW LAPTOP'));
  console.log('body size:', r.body.length);
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: (n) => ['STOCKITEM'].includes(n) });
  const parsed = p.parse(r.body);
  const i = r.body.indexOf('TEST FINAL FLOW LAPTOP');
  if (i >= 0) {
    console.log('RAW AROUND ITEM:', r.body.substring(i - 150, i + 300).replace(/\s+/g, ' '));
  }
  const coll = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
  const list = Array.isArray(coll) ? coll : [coll];
  let count = 0;
  for (const c of list) {
    const es = c?.STOCKITEM;
    if (!es) continue;
    const arr = Array.isArray(es) ? es : [es];
    for (const e of arr) {
      count++;
      const nm = String(e?.NAME?.['#text'] ?? e?.NAME ?? '');
      if (nm.includes('FINAL') || nm.includes('PURCHASE') || nm.includes('PO FIELD')) {
        console.log('MATCH:', nm, '| parent:', e?.PARENT?.['#text'] ?? e?.PARENT, '| closing:', JSON.stringify(e?.CLOSINGBALANCE?.['#text'] ?? e?.CLOSINGBALANCE));
      }
    }
  }
  console.log('total stock items returned:', count);
}

main().catch((e) => console.error('ERR:', e.message));
