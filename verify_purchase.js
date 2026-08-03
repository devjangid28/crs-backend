require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const { XMLParser } = require('fast-xml-parser');

const xml = `<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CRSVerify</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="CRSVerify" ISINITIALIZE="Yes">
        <TYPE>StockItem</TYPE>
        <NATIVEMETHOD>Name</NATIVEMETHOD>
        <NATIVEMETHOD>Parent</NATIVEMETHOD>
        <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;

async function main() {
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
      const name = e?.NAME || e?.['@_NAME'] || '';
      if (name === 'TEST PURCHASE FLOW LAPTOP') {
        console.log('FOUND:', name);
        console.log('  parent =', JSON.stringify(e?.PARENT));
        console.log('  closing =', JSON.stringify(e?.CLOSINGBALANCE));
      }
    }
  }
  // Also verify supplier ledger + purchase voucher exist in day book
}

main().catch((e) => console.error('ERROR:', e.message));
