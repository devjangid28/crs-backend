const http = require('http');
const { XMLParser } = require('fast-xml-parser');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const HOST = process.env.TALLY_HOST || 'localhost';
const PORT = parseInt(process.env.TALLY_PORT, 10) || 9000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

const xmlBody = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Voucher Register</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVCURRENTCOMPANY>$$SM Current Company</SVCURRENTCOMPANY>
          <SVFROMDATE>01-Apr-2024</SVFROMDATE>
          <SVTODATE>$$SysName:Today</SVTODATE>
          <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

console.log(`Testing Tally connection at ${HOST}:${PORT}...`);

const body = Buffer.from(xmlBody, 'utf-8');
const options = {
  hostname: HOST,
  port: PORT,
  path: '/',
  method: 'POST',
  headers: {
    'Content-Type': 'text/xml',
    'Content-Length': body.length,
  },
  timeout: 10000,
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log(`\nResponse status: ${res.statusCode}`);
    console.log(`Response length: ${data.length} bytes`);
    try {
      const parsed = parser.parse(data);
      const vouchers = parsed?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE;
      if (vouchers) {
        const count = Array.isArray(vouchers) ? vouchers.length : 1;
        console.log(`\nSUCCESS: Found ${count} voucher(s) in Tally response.`);
        if (count <= 3) {
          console.log('\nRaw response:\n', JSON.stringify(parsed, null, 2).substring(0, 2000));
        }
      } else {
        console.log('\nResponse received but no vouchers found.');
        console.log('This may mean:');
        console.log('  - No sales vouchers exist after 01-Apr-2024');
        console.log('  - Tally company name differs from expected');
        console.log('\nRaw response (first 1000 chars):\n', data.substring(0, 1000));
      }
    } catch (err) {
      console.error('Parse error:', err.message);
      console.log('\nRaw response (first 1000 chars):\n', data.substring(0, 1000));
    }
  });
});

req.on('error', (err) => {
  console.error(`\nFAILED: ${err.message}`);
  console.log('\nMake sure:');
  console.log('  1. Tally.ERP 9 / TallyPrime is running');
  console.log('  2. HTTP Interface is enabled (F12 > Advanced Configuration > Enable HTTP Interface)');
  console.log(`  3. Tally is listening on port ${PORT}`);
  console.log(`  4. No firewall blocking port ${PORT}`);
});

req.on('timeout', () => {
  req.destroy();
  console.error('\nFAILED: Request timed out (10s)');
});

req.write(body);
req.end();
