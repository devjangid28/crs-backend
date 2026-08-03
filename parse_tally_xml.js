require('dotenv').config({ path: '.env' });
const fs = require('fs');

const body = fs.readFileSync('./tally_daybook.xml', 'utf-8');

const { XMLParser } = require('fast-xml-parser');
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
  isArray: (name) => ['VOUCHER','BATCHALLOCATIONS.LIST','ALLLEDGERENTRIES.LIST',
    'ALLINVENTORYENTRIES.LIST','SERIALNUMBERLIST','SERIALNUMBER','TALLYMESSAGE'].includes(name)
});

const parsed = parser.parse(body);

// Dig into all possible paths
const body2 = parsed?.ENVELOPE?.BODY;
console.log('BODY keys:', Object.keys(body2 || {}));

const importData = body2?.IMPORTDATA;
console.log('IMPORTDATA keys:', Object.keys(importData || {}));

const reqData = importData?.REQUESTDATA;
console.log('REQUESTDATA keys:', Object.keys(reqData || {}));

const messages = reqData?.TALLYMESSAGE;
const msgArr = Array.isArray(messages) ? messages : (messages ? [messages] : []);
console.log('TALLYMESSAGE count:', msgArr.length);

// Collect all vouchers
const allVouchers = [];
for (const msg of msgArr) {
  const vouchers = msg?.VOUCHER;
  if (!vouchers) continue;
  const vchArr = Array.isArray(vouchers) ? vouchers : [vouchers];
  allVouchers.push(...vchArr);
}
console.log('Total vouchers:', allVouchers.length);

// Show all unique voucher types
const vchTypes = [...new Set(allVouchers.map(v => v?.['@_VCHTYPE'] || 'unknown'))];
console.log('Voucher types:', vchTypes.join(' | '));

// Extract all stock items with details
const stockItems = {};
for (const v of allVouchers) {
  const vchType = v?.['@_VCHTYPE'] || '';
  const partyName = v?.PARTYLEDGERNAME || '';
  const vchDate = String(v?.DATE || '');
  const vchNum = v?.VOUCHERNUMBER || '';
  const isSale = vchType.toLowerCase().includes('sale');

  const invAll = v?.['ALLINVENTORYENTRIES.LIST'] || [];
  const invArr = Array.isArray(invAll) ? invAll : [invAll];

  for (const inv of invArr) {
    const stockName = inv?.STOCKITEMNAME || '';
    const rate = (inv?.RATE || '').replace('/Qty','').replace('/Nos','').trim();
    const qty = inv?.BILLEDQTY || inv?.ACTUALQTY || '1';

    const batches = inv?.['BATCHALLOCATIONS.LIST'] || [];
    const batchArr = Array.isArray(batches) ? batches : [batches];

    for (const batch of batchArr) {
      // Check SERIALNUMBERLIST
      const snList = batch?.SERIALNUMBERLIST;
      const serialNos = snList?.SERIALNUMBER || [];
      const serialArr = Array.isArray(serialNos) ? serialNos : [serialNos];

      for (const serial of serialArr) {
        const s = (typeof serial === 'string' ? serial : serial?.['#text'] || '').trim();
        if (s && stockName) {
          stockItems[s] = { stockName, serial: s, rate, qty, status: isSale ? 'Sold' : 'Available', vchType, partyName, vchDate, vchNum };
        }
      }

      // Also check batch name
      const bn = (batch?.BATCHNAME || '').trim();
      if (bn && bn !== 'Primary' && stockName && !stockItems[bn]) {
        stockItems[bn] = { stockName, serial: bn, rate, qty, status: isSale ? 'Sold' : 'Available', vchType, partyName, vchDate, vchNum };
      }
    }

    // If no batches but has stock item, add without serial
    if (stockName && invArr.length > 0) {
      const key = `${stockName}_${vchNum}`;
      if (!stockItems[key]) {
        stockItems[key] = { stockName, serial: '', rate, qty, status: isSale ? 'Sold' : 'Available', vchType, partyName, vchDate, vchNum };
      }
    }
  }
}

console.log('\n=== ALL STOCK ITEMS FROM TALLY ===');
Object.values(stockItems).forEach(i => console.log(JSON.stringify(i)));
console.log('\nTotal:', Object.keys(stockItems).length);

// Save for import
fs.writeFileSync('./tally_items_to_import.json', JSON.stringify(Object.values(stockItems).filter(i => i.serial), null, 2));
console.log('Saved serial items to tally_items_to_import.json');
