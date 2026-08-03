require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const company = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

// Create Stock Item 1: Test Laptop
const xml1 = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM ACTION="Create">
            <NAME>Test Laptop Dell Latitude 3420</NAME>
            <OPENINGBALANCE>1 Nos</OPENINGBALANCE>
            <OPENINGVALUE>32000.00</OPENINGVALUE>
          </STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

// Create Stock Item 2: Test Monitor
const xml2 = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM ACTION="Create">
            <NAME>Test Monitor Samsung 24"</NAME>
            <OPENINGBALANCE>1 Nos</OPENINGBALANCE>
            <OPENINGVALUE>10000.00</OPENINGVALUE>
          </STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

async function createStockItem(xml, label) {
  console.log(`Creating stock item: ${label}...`);
  try {
    const result = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml)
    }, xml, 30000);
    console.log(`  Status: ${result.statusCode}`);
    console.log(`  Response: ${result.body.substring(0, 500)}`);
    if (result.body.includes('<CREATED>1</CREATED>')) {
      console.log(`  ✅ ${label} created successfully!`);
    } else if (result.body.includes('<CREATED>0</CREATED>') && !result.body.includes('LINEERROR')) {
      console.log(`  ⚠️  Already exists or unchanged`);
    } else {
      const errMatch = result.body.match(/<LINEERROR>([^<]+)<\/LINEERROR>/);
      if (errMatch) console.log(`  ❌ Error: ${errMatch[1]}`);
    }
  } catch (e) {
    console.error(`  ❌ Failed: ${e.message}`);
  }
}

(async () => {
  await createStockItem(xml1, 'Test Laptop Dell Latitude 3420');
  await createStockItem(xml2, 'Test Monitor Samsung 24"');
  console.log('\nDone creating stock items in Tally.');
})();
