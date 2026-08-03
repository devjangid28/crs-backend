require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const xml = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES/>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE>
          <COMPANY NAME="Test_company" ACTION="Create">
            <NAME>Test_company</NAME>
            <PARENT/>
            <STARTINGFROM>01-Apr-2026</STARTINGFROM>
            <FINANCIALYEARFROM>01-Apr-2026</FINANCIALYEARFROM>
            <BOOKSYEARFROM>01-Apr-2026</BOOKSYEARFROM>
            <ISDEMO>Yes</ISDEMO>
            <CURRENCYSYMBOL>Rs.</CURRENCYSYMBOL>
            <CURRENCYNAME>Rupee</CURRENCYNAME>
            <FORMALNAME>Rupees</FORMALNAME>
            <ISOCURRENCYCODE>INR</ISOCURRENCYCODE>
            <ADDRESS.LIST>
              <ADDRESS>Test Address, Vadodara</ADDRESS>
            </ADDRESS.LIST>
            <CITY>Vadodara</CITY>
            <STATE>Gujarat</STATE>
            <COUNTRY>India</COUNTRY>
            <PINCODE>390001</PINCODE>
            <PHONE>9998245013</PHONE>
          </COMPANY>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

console.log('Sending company creation request...');
t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
  'Content-Type': 'text/xml',
  'Content-Length': Buffer.byteLength(xml)
}, xml, 60000)
  .then(r => {
    console.log('Status:', r.statusCode);
    console.log('Response:', r.body.substring(0, 2000));
  })
  .catch(e => console.error('Error:', e.message));
