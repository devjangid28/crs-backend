require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

async function main() {
  const xml = t.buildPurchaseVoucherXml({
    company: 'BLUECHIP COMPUTER SYSTEM - 2024-25',
    partyLedger: 'TEST PO FIELD SUP',
    purchaseLedger: 'PURCHASE @ 18%',
    refNumber: 'INV/POFIELD/001',
    poNumber: 'PO-2026-011',
    narration: 'PO field probe',
    entries: [{
      name: 'TEST PO FIELD LAPTOP',
      category: 'Desktop',
      qty: 1,
      rate: 40000,
      serials: ['POFIELD-SER-001'],
      gstRate: 18,
      hsnCode: '84713000',
      hsnDescription: 'Laptop Computer',
      gstApplicability: 'Applicable',
      typeOfSupply: 'Goods',
    }],
  });
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 40000);
  console.log('RESPONSE:');
  console.log(r.body);
}

main().catch((e) => console.error('ERROR:', e.message, e.stack));
