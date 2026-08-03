require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2024</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml)
  .then(r => {
    require('fs').writeFileSync('./tally_daybook.xml', r.body);
    console.log('Saved tally_daybook.xml, size:', r.body.length);

    const { XMLParser } = require('fast-xml-parser');
    const parser = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
      isArray: (name) => ['VOUCHER','BATCHALLOCATIONS.LIST','ALLLEDGERENTRIES.LIST','ALLINVENTORYENTRIES.LIST','SERIALNUMBERLIST','SERIALNUMBER'].includes(name)
    });
    const parsed = parser.parse(r.body);
    const messages = parsed?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE
      || parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE || [];
    const msgArr = Array.isArray(messages) ? messages : [messages];

    const items = [];
    for (const msg of msgArr) {
      const vouchers = msg?.VOUCHER || [];
      const vchArr = Array.isArray(vouchers) ? vouchers : [vouchers];
      for (const v of vchArr) {
        const vchType = v?.['@_VCHTYPE'] || '';
        const partyName = v?.PARTYLEDGERNAME || '';
        const vchDate = v?.DATE || '';
        const vchNum = v?.VOUCHERNUMBER || '';
        const invAll = v?.['ALLINVENTORYENTRIES.LIST'] || [];
        const invArr = Array.isArray(invAll) ? invAll : [invAll];
        for (const inv of invArr) {
          const stockName = inv?.STOCKITEMNAME || '';
          const qty = inv?.BILLEDQTY || inv?.ACTUALQTY || '';
          const rate = inv?.RATE || '';
          const batches = inv?.['BATCHALLOCATIONS.LIST'] || [];
          const batchArr = Array.isArray(batches) ? batches : [batches];
          for (const batch of batchArr) {
            const serialNos = batch?.SERIALNUMBERLIST?.SERIALNUMBER || [];
            const serialArr = Array.isArray(serialNos) ? serialNos : [serialNos];
            for (const serial of serialArr) {
              const s = (typeof serial === 'string' ? serial : serial?.['#text'] || '').trim();
              if (s && stockName) {
                items.push({ stockName, serial: s, qty, rate, vchType, partyName, vchDate, vchNum });
              }
            }
            // also check batch name as serial
            const batchName = (batch?.BATCHNAME || '').trim();
            if (batchName && batchName !== 'Primary' && stockName) {
              const alreadyAdded = items.find(i => i.serial === batchName && i.stockName === stockName);
              if (!alreadyAdded) {
                items.push({ stockName, serial: batchName, qty, rate, vchType, partyName, vchDate, vchNum });
              }
            }
          }
        }
      }
    }

    console.log('\n=== TALLY STOCK ITEMS WITH SERIALS ===');
    items.forEach(i => console.log(JSON.stringify(i)));
    console.log('\nTotal:', items.length);
  })
  .catch(e => console.error(e.message));
