require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const { XMLParser } = require('fast-xml-parser');

const xml = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>List of Stock Items</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY>
          <SVINCLUDEBATCHES>Yes</SVINCLUDEBATCHES>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

async function main() {
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml',
    'Content-Length': Buffer.byteLength(xml),
  }, xml, 30000);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    isArray: (n) => ['STOCKITEM', 'BATCHALLOCATIONS.LIST', 'SERIALNUMBERLIST', 'SERIALNUMBER'].includes(n),
  });
  const parsed = parser.parse(r.body);
  const body = parsed?.ENVELOPE?.BODY;
  let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
  if (!messages) messages = body?.DATA?.TALLYMESSAGE;
  const items = [];
  const msgArr = Array.isArray(messages) ? messages : [messages];
  for (const msg of msgArr) {
    const si = msg?.STOCKITEM;
    if (!si) continue;
    const arr = Array.isArray(si) ? si : [si];
    for (const it of arr) {
      const name = it.NAME || it['@_NAME'] || '';
      const parent = it.PARENT?.['#text'] || it.PARENT || '';
      const cat = it.CATEGORY?.['#text'] || it.CATEGORY || '';
      const n = String(name);
      if (n.includes('ACROCK') || n.includes('NESTED') || n.includes('UNDER TEST') || n.includes('CATEG TEST') || n.includes('JBFVUA') || n.includes('RACE') || n.includes('E2E')) {
        items.push({ name, parent, cat });
      }
    }
  }
  console.log(JSON.stringify(items, null, 1));
  console.log('Total matching:', items.length);
  console.log('Response length:', r.body.length);
}

main().catch((e) => console.error('ERROR:', e.message));
