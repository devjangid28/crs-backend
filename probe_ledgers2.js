require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

async function main() {
  const r = await t.fetchLedgers();
  const all = r.ledgers || [];
  console.log('total ledgers:', all.length);
  const purchase = all.filter(l => /purchase/i.test(l.name));
  console.log('=== PURCHASE-NAMED LEDGERS ===');
  console.log(JSON.stringify(purchase, null, 1));
  const input = all.filter(l => /input|igst|cgst|sgst/i.test(l.name));
  console.log('=== INPUT/GST LEDGERS ===');
  console.log(JSON.stringify(input.slice(0, 40), null, 1));
  const sunder = all.filter(l => /sundry creditor/i.test(l.parent));
  console.log('=== SUNDRY CREDITOR COUNT ===', sunder.length);
  const creditors = sunder.filter(l => /PURCHASE|DISTRIBUTOR|TRADING/i.test(l.name)).slice(0, 10);
  console.log('=== SAMPLE CREDITORS ===', JSON.stringify(creditors, null, 1));
}

main().catch((e) => console.error('ERROR:', e.message));
