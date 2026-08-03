require('dotenv').config({ path: 'C:/Users/DELL/OneDrive/Desktop/CRS Software/crs-backend/.env' });
const t = require('C:/Users/DELL/OneDrive/Desktop/CRS Software/crs-backend/src/services/tallyService');
const { XMLParser } = require('C:/Users/DELL/OneDrive/Desktop/CRS Software/crs-backend/node_modules/fast-xml-parser');

const xml = `<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>CRSVerify</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>${process.env.TALLY_COMPANY}</SVCURRENTCOMPANY>
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

(async () => {
  const url = `http://${process.env.TALLY_HOST}:${process.env.TALLY_PORT}`;
  const r = await t.rawHttpRequest(url, 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml, 60000);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', isArray: (n) => ['STOCKITEM', 'COLLECTION'].includes(n) });
  const parsed = parser.parse(r.body);
  const coll = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION || [];
  let found = 0;
  for (const c of coll) {
    const es = c?.STOCKITEM || [];
    for (const e of es) {
      const name = e?.NAME || e?.['@_NAME'] || '';
      const parent = e?.PARENT?.['#text'] || e?.PARENT || '';
      const closing = e?.CLOSINGBALANCE?.['#text'] || e?.CLOSINGBALANCE || '';
      if (name && (name.includes('PM3406CKA') || (name + '').toLowerCase().includes('t8nxlp') || (parent + '').toLowerCase().includes('t8nxlp'))) {
        found++;
        console.log('STOCKITEM:', JSON.stringify({ name, parent, closing }));
      }
    }
  }
  if (found === 0) console.log('NO PM3406CKA MATCHES FOUND IN STOCK ITEMS');
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
