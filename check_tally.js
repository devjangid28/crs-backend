require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const xml = '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2026</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>';

t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml)
  .then(r => {
    const vchTypes = [...new Set((r.body.match(/VCHTYPE="([^"]+)"/g) || []))];
    const dates = (r.body.match(/<DATE>[^<]+<\/DATE>/g) || []).slice(0, 3);
    console.log('VCHTYPES:', vchTypes.join(' | '));
    console.log('DATE SAMPLES:', dates.join(' | '));
  })
  .catch(e => console.error(e.message));
