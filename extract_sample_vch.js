const t = require('./src/services/tallyService');
const fs = require('fs');
const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY><SVFROMDATE>01-Jul-2026</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>';
t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml)
  .then(r => {
    const match = r.body.match(/<VOUCHER[^>]*VCHTYPE="Sales Asus"[^>]*>[\s\S]*?<\/VOUCHER>/);
    if (match) {
      const vch = match[0];
      console.log('=== SALES ASUS VOUCHER ===');
      console.log(vch);
      fs.writeFileSync('sample_sales_asus.xml', vch);
    } else {
      console.log('No Sales Asus voucher found');
      const idx = r.body.indexOf('VCHTYPE="Sales Asus"');
      if (idx >= 0) {
        const snippet = r.body.substring(Math.max(0, idx - 200), idx + 5000);
        console.log('Context around first occurrence:');
        console.log(snippet);
      }
    }
  })
  .catch(e => console.error(e.message));
