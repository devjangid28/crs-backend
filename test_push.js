require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

console.log('Config:', JSON.stringify(t.getTallyConfig()));

t.pushSalesVoucher({
  partyName: 'VK',
  voucherNumber: 'CRS-TEST-004',
  items: [{
    name: 'NOTEBOOK ASUS BM1403CDA-S60753X',
    serialNumber: 'T5NXCV08Y18620C',
    qty: 1,
    price: 50000,
    discount: 0,
    batch: 'Primary',
    skipInventory: false
  }],
  taxRate: 18,
  narration: 'Test push CRS',
  date: '20260728'
}).then(r => {
  console.log('Result:', JSON.stringify(r));
}).catch(e => console.error(e.message));
