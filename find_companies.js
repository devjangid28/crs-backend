require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

// TallyPrime exposes currently loaded companies via a Collection request
const xml = `<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Day Book</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVFROMDATE>01-Apr-2025</SVFROMDATE>
          <SVTODATE>$$SysName:Today</SVTODATE>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

// No company tag = uses currently active company
t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml)
  .then(r => {
    // Extract company name from response
    const compMatch = r.body.match(/<SVCURRENTCOMPANY>([^<]+)<\/SVCURRENTCOMPANY>/);
    const vchTypes = [...new Set((r.body.match(/VCHTYPE="([^"]+)"/g) || []).map(m => m.replace(/VCHTYPE="|"/g, '')))];
    const stockItems = [...new Set((r.body.match(/<STOCKITEMNAME>[^<]+<\/STOCKITEMNAME>/g) || []).map(n => n.replace(/<\/?STOCKITEMNAME>/g, '').trim()))];
    const serials = (r.body.match(/<SERIALNUMBER>[^<]+<\/SERIALNUMBER>/g) || []).map(n => n.replace(/<\/?SERIALNUMBER>/g, '').trim());

    console.log('Active Company:', compMatch ? compMatch[1] : 'not found in response');
    console.log('Voucher Types:', vchTypes.join(' | '));
    console.log('Stock Items:', stockItems.join(' | '));
    console.log('Serials:', serials.join(' | '));
    console.log('Response size:', r.body.length);
    console.log('\nFirst 1000 chars:', r.body.substring(0, 1000));
  })
  .catch(e => console.error(e.message));
