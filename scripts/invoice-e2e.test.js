// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — end-to-end check through the real pipeline
//
//  The direction tests in invoice-direction.test.js feed the parser positioned
//  lines directly. This one goes through the whole path a user actually takes:
//
//      PDF bytes → pdf.js text layer → preprocess → parser → identity → maths
//      → validation → the JSON the purchase form receives
//
//  So it also proves the response shape the two apps depend on, and that a sales
//  invoice arrives with no supplier and no draft to fill in.
//
//  Run with:  node scripts/invoice-e2e.test.js
// ─────────────────────────────────────────────────────────────────────────────

const assert = require('assert');
const PDFDocument = require('pdfkit');

const invoiceOcr = require('../src/services/invoiceOcr');

const PAGE = { size: 'A4', margin: 36 };

/** Writes one text line at an exact position, so the layout is real geometry. */
function put(doc, text, x, y, size = 9) {
  doc.font('Helvetica').fontSize(size).text(text, x, y, { lineBreak: false });
}

/** TEST C — Prajapati. We are the issuer; this must never become a purchase. */
function buildPrajapatiPdf() {
  const doc = new PDFDocument(PAGE);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  let y = 40;
  put(doc, 'Tax Invoice', 40, y);
  put(doc, 'Invoice No. 22', 330, y);
  y += 16;
  put(doc, 'BLUECHIP COMPUTER SYSTEM [ASUS EXCLUSIVE STORE]', 40, y);
  y += 14;
  put(doc, 'Shop 4, Ring Road, Vadodara, Gujarat 390021', 40, y);
  y += 14;
  put(doc, 'GSTIN: 27AABCU9603R1ZM', 40, y);
  y += 14;
  put(doc, 'Ph: 9904991114', 40, y);
  y += 14;
  put(doc, 'Email: aes.bluechip@gmail.com', 40, y);
  y += 14;
  put(doc, 'Dated 17-09-2026', 330, y);
  y += 22;
  put(doc, 'Consignee', 40, y);
  y += 14;
  put(doc, 'Prajapati Harsh Shirishbhai', 40, y);
  y += 14;
  put(doc, 'Bill To', 40, y);
  y += 14;
  put(doc, 'Prajapati Harsh Shirishbhai', 40, y);
  y += 22;

  put(doc, 'Sl', 40, y);
  put(doc, 'Description of Goods', 70, y);
  put(doc, 'HSN', 260, y);
  put(doc, 'Qty', 320, y);
  put(doc, 'Rate', 370, y);
  put(doc, 'Taxable Value', 440, y);
  put(doc, 'Amount', 530, y);
  y += 16;
  put(doc, '1', 40, y);
  put(doc, 'Laptop', 70, y);
  put(doc, '84733010', 260, y);
  put(doc, '1', 320, y);
  put(doc, '55076.27', 370, y);
  put(doc, '55076.27', 440, y);
  put(doc, '64990.00', 530, y);
  y += 14;
  put(doc, 'Serial No: W3N0RJ009471123', 70, y);
  y += 14;
  put(doc, 'Model No: X1605VA-MB1627WS', 70, y);
  y += 14;
  put(doc, 'Part No: 90NB10N2-M021S0', 70, y);
  y += 14;
  put(doc, 'Check No: 95Z7', 70, y);
  y += 14;
  put(doc, 'Warranty: 1 YEAR OF HARDWARE WARRANTY', 70, y);
  y += 20;

  put(doc, 'Total', 440, y);
  put(doc, '56177.96', 530, y);
  y += 14;
  put(doc, 'CGST 9%', 440, y);
  put(doc, '5056.02', 530, y);
  y += 14;
  put(doc, 'SGST 9%', 440, y);
  put(doc, '5056.02', 530, y);
  y += 14;
  put(doc, 'Grand Total', 440, y);
  put(doc, '66290.00', 530, y);
  y += 24;
  put(doc, 'Payment Date 05-10-2026', 40, y);
  y += 14;
  put(doc, 'Declaration: goods once sold will not be taken back.', 40, y);
  y += 14;
  put(doc, 'Bank Details: HDFC Bank A/c 50200012345678 IFSC HDFC0001234', 40, y);
  y += 14;
  put(doc, 'For BLUECHIP COMPUTER SYSTEM', 40, y);

  doc.end();
  return done;
}

/** TEST A — Matshwari sells to us. This is the ordinary purchase shape. */
function buildMatshwariPdf() {
  const doc = new PDFDocument(PAGE);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  let y = 40;
  put(doc, 'Tax Invoice', 40, y);
  y += 18;
  put(doc, 'MATSHWARI COMPUTER & SERVICES', 40, y);
  y += 14;
  put(doc, 'Shop 12, Tilak Road, Vadodara, Gujarat 390021', 40, y);
  y += 14;
  put(doc, 'GSTIN: 24AAECM1234F1Z5', 40, y);
  y += 14;
  put(doc, 'Ph: 0265 2334455', 40, y);
  y += 14;
  put(doc, 'Email: sales@matshwari.example', 40, y);
  y += 14;
  put(doc, 'Invoice No: 4471', 40, y);
  put(doc, 'Dated: 04-Oct-2026', 330, y);
  y += 20;
  put(doc, 'Bill To:', 40, y);
  y += 14;
  put(doc, 'BLUECHIP COMPUTER SYSTEM', 40, y);
  y += 14;
  put(doc, 'GSTIN: 27AABCU9603R1ZM', 40, y);
  y += 22;

  put(doc, 'Sl', 40, y);
  put(doc, 'Description of Goods', 70, y);
  put(doc, 'HSN', 260, y);
  put(doc, 'Qty', 320, y);
  put(doc, 'Rate', 370, y);
  put(doc, 'Taxable Value', 440, y);
  put(doc, 'Amount', 530, y);
  y += 16;
  put(doc, '1', 40, y);
  put(doc, 'Laptop', 70, y);
  put(doc, '84733010', 260, y);
  put(doc, '1', 320, y);
  put(doc, '450.00', 370, y);
  put(doc, '450.00', 440, y);
  put(doc, '531.00', 530, y);
  y += 20;
  put(doc, 'Total', 440, y);
  put(doc, '450.00', 530, y);
  y += 14;
  put(doc, 'CGST 9%', 440, y);
  put(doc, '40.50', 530, y);
  y += 14;
  put(doc, 'SGST 9%', 440, y);
  put(doc, '40.50', 530, y);
  y += 14;
  put(doc, 'Grand Total', 440, y);
  put(doc, '531.00', 530, y);

  doc.end();
  return done;
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((err) => results.push({ name, ok: false, err }));
}

(async () => {
  // The identity the route builds, read from this tenant's own configuration.
  const identity = await invoiceOcr.companyIdentity.buildCompanyIdentity({});
  console.log(`identity: ${identity.legalName || '(not configured)'}`
    + ` · gstins ${JSON.stringify(identity.gstins)}`
    + ` · sources ${JSON.stringify(identity.sources)}\n`);

  const prajapati = await buildPrajapatiPdf();
  const matshwari = await buildMatshwariPdf();

  const readPrajapati = () => invoiceOcr.extractInvoice({
    buffer: prajapati,
    fileName: 'prajapati.pdf',
    mimeType: 'application/pdf',
    ownCompany: {},
    identity,
    checkDuplicates: false,
  });

  const readMatshwari = () => invoiceOcr.extractInvoice({
    buffer: matshwari,
    fileName: 'matshwari.pdf',
    mimeType: 'application/pdf',
    ownCompany: {},
    identity,
    checkDuplicates: false,
  });

  await check('E2E TEST C — Prajapati is rejected as a sales invoice', async () => {
    const r = await readPrajapati();
    assert.strictEqual(r.classification.role, 'sales', `role was ${r.classification.role}`);
    assert.strictEqual(r.classification.importable, false);
    assert.strictEqual(r.documentRole, 'sales');
    assert.match(r.classification.headline, /sales invoice/i);
    assert.match(r.classification.buyerName || '', /Prajapati/i);
    assert.strictEqual(r.supplier.partyName.value, null, 'no supplier value may be offered');
    assert.strictEqual(r.purchaseDraft.partyName, '', 'the draft must stay empty');
    assert.strictEqual(r.purchaseDraft.notApplicable, true);
    assert.deepStrictEqual(r.purchaseDraft.items, []);
    assert.strictEqual(r.validation.ok, false);
    assert.ok(r.validation.blocking.some((b) => b.code === 'document-is-sales-invoice'));
    // It still explains itself with facts read from the document.
    assert.strictEqual(r.invoice.number.value, '22');
    assert.ok(r.invoice.date.value.startsWith('2026-09-17'), `date was ${r.invoice.date.value}`);
    // The remark must not claim a purchase was imported.
    assert.doesNotMatch(r.remark, /Supplier invoice imported/i);
    console.log('   →', r.classification.headline);
  });

  await check('E2E TEST A — Matshwari imports as a purchase with its own details', async () => {
    const r = await readMatshwari();
    assert.strictEqual(r.classification.role, 'purchase', `role was ${r.classification.role}`);
    assert.strictEqual(r.classification.ourRole, 'buyer');
    assert.match(r.supplier.partyName.value, /MATSHWARI/i);
    assert.strictEqual(r.supplier.partyGstin.value, '24AAECM1234F1Z5');
    assert.strictEqual(r.purchaseDraft.partyName, r.supplier.partyName.value);
    assert.strictEqual(r.validation.ok, true,
      `blocking: ${r.validation.blocking.map((b) => b.code).join(', ')}`);
    assert.ok(r.purchaseDraft.items.length > 0, 'expected the item to be read');
    console.log('   → supplier', r.supplier.partyName.value,
      '| gstin', r.supplier.partyGstin.value,
      '| items', r.purchaseDraft.items.length);
  });

  await check('E2E — the response shape both apps rely on is intact', async () => {
    const r = await readMatshwari();
    for (const key of ['source', 'quality', 'documentRole', 'classification', 'confidence',
      'supplier', 'invoice', 'items', 'tax', 'payment', 'validation', 'purchaseDraft', 'remark']) {
      assert.ok(r[key] !== undefined, `missing "${key}" in the response`);
    }
    for (const key of ['partyName', 'partyGstin', 'partyAddress', 'partyCity', 'partyState',
      'partyPincode', 'partyPhone', 'partyEmail', 'contactPerson']) {
      assert.ok(r.supplier[key] !== undefined, `missing supplier.${key}`);
      assert.ok('band' in r.supplier[key], `supplier.${key} must carry a confidence band`);
    }
    assert.ok(r.items[0].metadata !== undefined, 'items must expose their printed metadata');
  });

  await check('E2E — nothing from the buyer or the bank section leaks into the supplier', async () => {
    const r = await readPrajapati();
    assert.doesNotMatch(r.purchaseDraft.partyGstin || '', /27AABCU9603R1ZM/,
      'our own GSTIN must never appear on a rejected purchase draft');
    assert.doesNotMatch(r.remark, /HDFC|IFSC|50200012345678/i,
      'bank details must never reach the narration');
  });

  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`  PASS  ${r.name}`);
    else {
      failed += 1;
      console.log(`  FAIL  ${r.name}\n        ${r.err && r.err.message}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();