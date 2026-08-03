require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const fs = require('fs');

async function fetchVouchers(voucherType) {
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2024</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE><VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml);
  return r.body;
}

async function main() {
  const { XMLParser } = require('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
    isArray: (name) => ['VOUCHER','BATCHALLOCATIONS.LIST','ALLLEDGERENTRIES.LIST','ALLINVENTORYENTRIES.LIST','SERIALNUMBERLIST','SERIALNUMBER'].includes(name)
  });

  const voucherTypes = ['Purchase Asus', 'Purchases', 'Purchase', 'Sales Asus', 'Sales'];
  const allItems = {};

  for (const vt of voucherTypes) {
    console.log(`\nFetching: ${vt}`);
    try {
      const body = await fetchVouchers(vt);
      fs.writeFileSync(`./tally_${vt.replace(/ /g,'_')}.xml`, body);

      const parsed = parser.parse(body);
      const messages = parsed?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE
        || parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE || [];
      const msgArr = Array.isArray(messages) ? messages : [messages];

      let count = 0;
      for (const msg of msgArr) {
        const vouchers = msg?.VOUCHER || [];
        const vchArr = Array.isArray(vouchers) ? vouchers : [vouchers];
        for (const v of vchArr) {
          const actualVchType = v?.['@_VCHTYPE'] || '';
          const partyName = v?.PARTYLEDGERNAME || '';
          const vchDate = String(v?.DATE || '');
          const vchNum = v?.VOUCHERNUMBER || '';
          const isSale = actualVchType.toLowerCase().includes('sale');

          const invAll = v?.['ALLINVENTORYENTRIES.LIST'] || [];
          const invArr = Array.isArray(invAll) ? invAll : [invAll];
          for (const inv of invArr) {
            const stockName = inv?.STOCKITEMNAME || '';
            const rate = (inv?.RATE || '').replace('/Qty','').replace('/Nos','').trim();
            const batches = inv?.['BATCHALLOCATIONS.LIST'] || [];
            const batchArr = Array.isArray(batches) ? batches : [batches];
            for (const batch of batchArr) {
              const serialNos = batch?.SERIALNUMBERLIST?.SERIALNUMBER || [];
              const serialArr = Array.isArray(serialNos) ? serialNos : [serialNos];
              for (const serial of serialArr) {
                const s = (typeof serial === 'string' ? serial : serial?.['#text'] || '').trim();
                if (s && stockName) {
                  allItems[s] = { stockName, serial: s, rate, status: isSale ? 'Sold' : 'Available', vchType: actualVchType, partyName, vchDate, vchNum };
                  count++;
                }
              }
              const bn = (batch?.BATCHNAME || '').trim();
              if (bn && bn !== 'Primary' && stockName && !allItems[bn]) {
                allItems[bn] = { stockName, serial: bn, rate, status: isSale ? 'Sold' : 'Available', vchType: actualVchType, partyName, vchDate, vchNum };
                count++;
              }
            }
          }
        }
      }
      console.log(`  -> ${count} serial items found`);
    } catch(e) {
      console.log(`  -> Error: ${e.message}`);
    }
  }

  console.log('\n=== FINAL STOCK LIST ===');
  Object.values(allItems).forEach(i => console.log(JSON.stringify(i)));
  console.log('\nTotal:', Object.keys(allItems).length);
  fs.writeFileSync('./tally_stock_final.json', JSON.stringify(Object.values(allItems), null, 2));
  console.log('Saved to tally_stock_final.json');
}

main().catch(console.error);
