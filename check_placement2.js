require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const { XMLParser } = require('fast-xml-parser');

const company = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

function buildCollXml(type, collName, methods) {
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>${collName}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="${collName}" ISINITIALIZE="Yes">
            <TYPE>${type}</TYPE>
            ${methods.map((m) => `            <NATIVEMETHOD>${m}</NATIVEMETHOD>`).join('\n')}
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

async function main() {
  const url = 'http://192.168.2.2:9000';
  const xml = buildCollXml('StockItem', 'CRSAllStockItems', ['Name', 'Parent', 'Category', 'BaseUnits', 'OpeningQuantity']);
  const r = await t.rawHttpRequest(url, 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml, 30000);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    isArray: (n) => ['STOCKITEM', 'STOCKGROUP'].includes(n),
  });
  const parsed = parser.parse(r.body);
  const data = parsed?.ENVELOPE?.BODY?.DATA;
  const colls = data?.COLLECTION;
  const collArr = Array.isArray(colls) ? colls : [colls];
  const items = [];
  for (const coll of collArr) {
    const entries = coll?.STOCKITEM;
    if (!entries) continue;
    const list = Array.isArray(entries) ? entries : [entries];
    for (const e of list) {
      const name = e?.NAME || e?.['@_NAME'] || '';
      const parent = e?.PARENT?.['#text'] || e?.PARENT || '';
      const cat = e?.CATEGORY?.['#text'] || e?.CATEGORY || '';
      const units = e?.BASEUNITS?.['#text'] || e?.BASEUNITS || '';
      items.push({ name, parent, cat, units });
    }
  }
  const wanted = items.filter((i) =>
    /ACROCK|NESTED|UNDER TEST|CATEG TEST|JBFVUA|RACE|E2E|TEST/i.test(i.name)
  );
  console.log(JSON.stringify(wanted, null, 1));
  console.log('Matching:', wanted.length, 'Total items:', items.length);
}

main().catch((e) => console.error('ERROR:', e.message));
