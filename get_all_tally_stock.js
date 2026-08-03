require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const fs = require('fs');

// Fetch ALL vouchers (no voucher type filter) from beginning of year
const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2024</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;

t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml)
  .then(r => {
    fs.writeFileSync('./tally_all.xml', r.body);

    const { XMLParser } = require('fast-xml-parser');
    const parser = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
      isArray: (name) => ['VOUCHER','BATCHALLOCATIONS.LIST','ALLLEDGERENTRIES.LIST','ALLINVENTORYENTRIES.LIST','SERIALNUMBERLIST','SERIALNUMBER'].includes(name)
    });
    const parsed = parser.parse(r.body);
    const messages = parsed?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE
      || parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE || [];
    const msgArr = Array.isArray(messages) ? messages : [messages];

    // Track all stock movements: purchases (+) and sales (-)
    const stockMap = {}; // serial -> { stockName, qty, rate, status, vchType, partyName, vchDate }

    for (const msg of msgArr) {
      const vouchers = msg?.VOUCHER || [];
      const vchArr = Array.isArray(vouchers) ? vouchers : [vouchers];
      for (const v of vchArr) {
        const vchType = (v?.['@_VCHTYPE'] || '').toLowerCase();
        const partyName = v?.PARTYLEDGERNAME || '';
        const vchDate = String(v?.DATE || '');
        const vchNum = v?.VOUCHERNUMBER || '';
        const isSale = vchType.includes('sales') || vchType.includes('sale');
        const isPurchase = vchType.includes('purchase') || vchType.includes('receipt');

        const invAll = v?.['ALLINVENTORYENTRIES.LIST'] || [];
        const invArr = Array.isArray(invAll) ? invAll : [invAll];
        for (const inv of invArr) {
          const stockName = inv?.STOCKITEMNAME || '';
          const rate = inv?.RATE || '';
          const batches = inv?.['BATCHALLOCATIONS.LIST'] || [];
          const batchArr = Array.isArray(batches) ? batches : [batches];
          for (const batch of batchArr) {
            const serialNos = batch?.SERIALNUMBERLIST?.SERIALNUMBER || [];
            const serialArr = Array.isArray(serialNos) ? serialNos : [serialNos];
            for (const serial of serialArr) {
              const s = (typeof serial === 'string' ? serial : serial?.['#text'] || '').trim();
              if (s && stockName) {
                stockMap[s] = {
                  stockName, serial: s, rate,
                  status: isSale ? 'Sold' : 'Available',
                  vchType: v?.['@_VCHTYPE'] || '',
                  partyName, vchDate, vchNum
                };
              }
            }
            const batchName = (batch?.BATCHNAME || '').trim();
            if (batchName && batchName !== 'Primary' && stockName && !stockMap[batchName]) {
              stockMap[batchName] = {
                stockName, serial: batchName, rate,
                status: isSale ? 'Sold' : 'Available',
                vchType: v?.['@_VCHTYPE'] || '',
                partyName, vchDate, vchNum
              };
            }
          }
        }
      }
    }

    console.log('\n=== ALL TALLY STOCK ITEMS ===');
    Object.values(stockMap).forEach(i => console.log(JSON.stringify(i)));
    console.log('\nTotal unique serials:', Object.keys(stockMap).length);
  })
  .catch(e => console.error(e.message));
