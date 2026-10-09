// Runs the real pipeline against a real uploaded file and prints what it produced.
// Nothing here is mocked: the bytes come off disk and go through decode →
// preprocess → OCR → parser → validation exactly as the endpoint does.
//
//   node scripts/_runreal.js "<file>" [--json]

const fs = require('fs');
const invoiceOcr = require('../src/services/invoiceOcr');

(async () => {
  const file = process.argv[2];
  const asJson = process.argv.includes('--json');
  const buffer = fs.readFileSync(file);
  const name = file.split(/[\\/]/).pop();

  const identity = await invoiceOcr.companyIdentity.buildCompanyIdentity({});
  console.error(`file      : ${name} (${Math.round(buffer.length / 1024)} KB)`);
  console.error(`identity  : ${identity.legalName} | gstins ${JSON.stringify(identity.gstins)}`);

  const result = await invoiceOcr.extractInvoice({
    buffer,
    fileName: name,
    mimeType: /\.pdf$/i.test(name) ? 'application/pdf' : 'image/jpeg',
    ownCompany: {},
    identity,
    checkDuplicates: false,
  });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const v = (b) => (b && b.value !== null && b.value !== undefined ? b.value : '—');
  console.error('');
  console.error(`textSource : ${result.source.textSource}  engine: ${result.source.ocrEngine}`);
  console.error(`readHealth : ok=${result.readHealth.ok} chars=${result.readHealth.characterCount} lines=${result.readHealth.lineCount} ocrFailed=${result.readHealth.ocrFailed}`);
  console.error(`direction  : ${result.classification.role} / state ${result.classification.state} / ourRole ${result.classification.ourRole}`);
  console.error(`  headline : ${result.classification.headline}`);
  console.error(`  seller   : ${result.classification.sellerName}`);
  console.error(`  buyer    : ${result.classification.buyerName}`);
  console.error(`supplier   : ${v(result.supplier.partyName)}`);
  console.error(`  gstin    : ${v(result.supplier.partyGstin)}`);
  console.error(`  address  : ${v(result.supplier.partyAddress)}`);
  console.error(`  city     : ${v(result.supplier.partyCity)}   state: ${v(result.supplier.partyState)}   pin: ${v(result.supplier.partyPincode)}`);
  console.error(`  phone    : ${v(result.supplier.partyPhone)}   email: ${v(result.supplier.partyEmail)}`);
  console.error(`invoice no : ${v(result.invoice.number)}`);
  console.error(`invoice dt : ${v(result.invoice.date)}`);
  console.error(`items (${result.items.length}):`);
  for (const it of result.items) {
    console.error(`   ${it.lineNo}. name="${v(it.itemName)}" qty=${v(it.quantity)} rate=${v(it.unitRate)} hsn="${v(it.hsnCode)}" amount=${it.lineAmount}`);
  }
  console.error(`tax        : rate=${result.tax.recommendedRate} taxable=${result.tax.taxableValue} tax=${result.tax.taxAmount} grand=${result.tax.grandTotal}`);
  console.error(`tableFound : ${result.tableDetected}`);
  console.error(`blocking   : ${result.validation.blocking.map((b) => b.code).join(', ') || '(none)'}`);
  console.error(`warnings   : ${result.validation.warnings.map((b) => b.code).join(', ') || '(none)'}`);
  console.error('');
  console.error('--- first 1800 chars of recognised text ---');
  console.error((result.rawText || '').slice(0, 1800));
})().catch((e) => {
  console.error('ERROR', e && e.message, e && e.stack);
  process.exit(1);
});