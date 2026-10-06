/**
 * Offline check of the invoice OCR pipeline.
 *
 * Builds a tax invoice that mirrors the layout the Bluechip supplier uses —
 * a letterhead block, invoice information, Consignee / Buyer columns, an item
 * table with HSN/SAC, CGST and SGST columns and a serial number printed under
 * the product description, then a tax summary and a payment block — and runs it
 * through the whole pipeline as both a text-layer PDF and a rendered image.
 *
 *   node scripts/test_invoice_ocr.js
 *
 * No database and no network are touched. The same script is used to check an
 * invoice the user supplies:
 *
 *   node scripts/test_invoice_ocr.js path/to/invoice.pdf
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');

const ocr = require('../src/services/invoiceOcr');

// ── A stand-in for a real supplier invoice ────────────────────────────────────

const { gstinChecksumDigit } = require('../src/services/invoiceOcr/normalize');

/** A syntactically and arithmetically valid GSTIN for the first 14 characters. */
function withValidChecksum(first14) {
  return first14 + gstinChecksumDigit(first14);
}

const SUPPLIER = {
  name: 'VADODARA IT HUB PRIVATE LIMITED',
  gstin: withValidChecksum('24AABCV1234C1Z'),
  taxRate: 18,
};

const OWN_COMPANY = {
  name: 'BLUECHIP COMPUTER SYSTEM',
  gstin: withValidChecksum('27AABCU9603R1Z'),
};

function buildSampleInvoice() {
  const doc = new PDFDocument({ size: 'A4', margin: 32 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));

  const money = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  doc.font('Helvetica-Bold').fontSize(16).text(SUPPLIER.name, 32, 34);
  doc.font('Helvetica').fontSize(9);
  doc.text('05, Harmony complex, Opp. MK High School, Alkapuri, Vadodara-07');
  doc.text('Phone: 73526 85205');
  doc.text('Email: sales@vadodaraihub.in');
  doc.text(`GSTIN: ${SUPPLIER.gstin}   State: Gujarat   State Code: 24`);
  doc.text('Tax Invoice');

  doc.moveDown(0.8).font('Helvetica-Bold').fontSize(9);
  doc.text('Invoice No.: 29', 32, doc.y, { continued: false });
  doc.text('Dated: 05-Oct-2026', 200, 152);
  doc.text('Mode/Terms of Payment: UPI', 380, 152);
  doc.text('Reference No. & Date: ORD-2026-OCT-0006', 32, 168);
  doc.text("Buyer's Order No: ORD-2026-OCT-0006", 32, 182);

  doc.font('Helvetica-Bold').text('Consignee (Ship To)', 32, 205);
  doc.font('Helvetica').text('ONGC Vadodara A/C Saurabh Choubey', 32, 218);
  doc.text('Vadodara, Gujarat - 390007', 32, 230);

  doc.font('Helvetica-Bold').text('Buyer (Bill To)', 330, 205);
  doc.font('Helvetica').text('ONGC Vadodara A/C Saurabh Choubey', 330, 218);
  doc.text('Vadodara, Gujarat - 390007', 330, 230);

  // Item table
  const top = 265;
  const columns = [32, 56, 196, 232, 268, 310, 348, 386, 424, 462, 500];
  doc.font('Helvetica-Bold').fontSize(7);
  doc.text('Sl No.', columns[0], top);
  doc.text('Description of Goods', columns[1], top);
  doc.text('HSN/SAC', columns[2], top);
  doc.text('Quantity', columns[3], top);
  doc.text('Rate (Excl. Tax)', columns[4], top);
  doc.text('Taxable Value', columns[5], top);
  doc.text('CGST %', columns[6], top);
  doc.text('CGST Amount', columns[7], top);
  doc.text('SGST %', columns[8], top);
  doc.text('SGST Amount', columns[9], top);
  doc.text('Amount', columns[10], top, { width: 60 });

  let y = top + 16;
  doc.font('Helvetica').fontSize(7);
  doc.text('1', columns[0], y);
  doc.text('Laptop - Vivobook 14 Flip', columns[1], y, { width: columns[2] - columns[1] - 4 });
  doc.text('8471', columns[2], y, { width: 32 });
  doc.text('1', columns[3], y, { width: 30 });
  doc.text('128389.83', columns[4], y, { width: 38 });
  doc.text('128389.83', columns[5], y, { width: 36 });
  doc.text('9', columns[6], y, { width: 30 });
  doc.text('11555.08', columns[7], y, { width: 36 });
  doc.text('9', columns[8], y, { width: 30 });
  doc.text('11555.08', columns[9], y, { width: 36 });
  doc.text('151500.00', columns[10], y, { width: 60 });
  y += 12;
  doc.text('Serial No: T1N0CV01Z128019', columns[1], y, { width: columns[6] - columns[1] - 4 });
  y += 10;
  doc.text('Model No: TP3407SA-QL025WS', columns[1], y, { width: columns[6] - columns[1] - 4 });
  y += 10;
  doc.text('Part No: 90NB14Y1-M004N0', columns[1], y, { width: columns[6] - columns[1] - 4 });
  y += 10;
  doc.text('Warranty: 3 YEARS OF HARDWARE WARRANTY', columns[1], y, { width: columns[6] - columns[1] - 4 });

  y += 22;
  doc.font('Helvetica-Bold');
  doc.text('Total Taxable Value', columns[4], y, { width: 90 });
  doc.text('128389.83', columns[6], y, { width: 36 });
  y += 12;
  doc.text('Total CGST', columns[4], y, { width: 90 });
  doc.text('11555.08', columns[6], y, { width: 36 });
  y += 12;
  doc.text('Total SGST', columns[4], y, { width: 90 });
  doc.text('11555.08', columns[6], y, { width: 36 });
  y += 12;
  doc.text('Total Tax', columns[4], y, { width: 90 });
  doc.text('23110.16', columns[6], y, { width: 36 });
  y += 12;
  doc.text('Grand Total', columns[4], y, { width: 90 });
  doc.text('151500.00', columns[6], y, { width: 36 });

  y += 26;
  doc.font('Helvetica-Bold').text('Payment Details', 32, y);
  doc.font('Helvetica');
  y += 12;
  doc.text('Total Amount: 151500.00', 32, y); y += 11;
  doc.text('Advance Paid: 0', 32, y); y += 11;
  doc.text('Payment Mode: UPI', 32, y); y += 11;
  doc.text('Balance Due: 151500.00', 32, y); y += 11;
  doc.text('Payment Status: Unpaid', 32, y);

  y += 18;
  doc.font('Helvetica-Bold').text('Bank Details', 32, y);
  doc.font('Helvetica');
  y += 12;
  doc.text('Bank Name: HDFC Bank', 32, y); y += 11;
  doc.text('Account No: 50200012345678', 32, y); y += 11;
  doc.text('IFSC: HDFC0001234', 32, y);

  y += 18;
  doc.text('Declaration: We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.', 32, y, { width: 520 });

  doc.end();
  return new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Writes the sample next to this script when DEBUG_COLUMNS is set, so the table
// geometry can be inspected without re-running the whole pipeline.
if (process.env.DEBUG_COLUMNS) {
  buildSampleInvoice().then((buffer) => {
    fs.writeFileSync(path.join(__dirname, 'sample-invoice.pdf'), buffer);
    console.log('wrote scripts/sample-invoice.pdf');
  });
}

// ── Reporting ────────────────────────────────────────────────────────────────

const pad = (label) => String(label).padEnd(22, ' ');
const show = (label, value) => console.log(`${pad(label)} ${value === null || value === undefined || value === '' ? '(blank)' : value}`);

function report(result, title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  console.log(`text source   : ${result.source.textSource}   pages: ${result.source.pagesProcessed}   confidence: ${result.confidence}`);
  console.log(`document role : ${result.documentRole}   table detected: ${result.tableDetected}`);

  console.log('\n-- supplier -------------------------------------------------');
  for (const key of ['partyName', 'partyGstin', 'partyAddress', 'partyCity', 'partyState', 'partyPincode', 'partyPhone', 'partyEmail', 'contactPerson']) {
    const f = result.supplier[key] || {};
    show(key, `${JSON.stringify(f.value)}   [${f.band} ${Math.round((f.confidence || 0) * 100)}%]`);
  }
  if (result.supplier.gstinSuggestions?.length) {
    show('gstin repair', result.supplier.gstinSuggestions.join(', '));
  }

  console.log('\n-- invoice reference -----------------------------------------');
  show('number', `${JSON.stringify(result.invoice.number.value)}   [${result.invoice.number.band}]`);
  show('date', `${JSON.stringify(result.invoice.date.value)}   (${result.invoice.dateDisplay})   [${result.invoice.date.band}]`);

  console.log('\n-- items ----------------------------------------------------');
  for (const item of result.items) {
    console.log(`  ${item.lineNo}. ${item.itemName.value}  qty=${item.quantity.value}  rate=${item.unitRate.value}  hsn=${JSON.stringify(item.hsnCode.value)}  gst=${item.gstRate}`);
    if (item.serials.length) console.log(`     serials: ${item.serials.map((s) => s.value).join(', ')}`);
    if (item.notes.length) console.log(`     notes:   ${item.notes.join(' | ')}`);
    for (const w of item.warnings) console.log(`     ! ${w}`);
  }
  if (!result.items.length) console.log('  (none)');

  console.log('\n-- tax & totals ----------------------------------------------');
  show('recommended rate', `${result.tax.recommendedRate} (${result.tax.rateSource})`);
  show('taxable value', result.tax.taxableValue);
  show('tax amount', result.tax.taxAmount);
  show('invoice grand total', result.tax.grandTotal);

  console.log('\n-- payment ---------------------------------------------------');
  for (const [k, v] of Object.entries(result.payment)) {
    if (v && v.value) show(k, v.value);
  }

  console.log('\n-- validation ------------------------------------------------');
  console.log(`  ok: ${result.validation.ok}   fields needing review: ${result.validation.reviewCount}`);
  for (const b of result.validation.blocking) console.log(`  BLOCK ${b.code}: ${b.message}`);
  for (const w of result.validation.warnings) console.log(`  warn  ${w.code}: ${w.message}`);

  console.log('\n-- purchase draft (what the form would be filled with) -------');
  const draft = result.purchaseDraft;
  show('partyName', draft.partyName);
  show('partyGstin', draft.partyGstin);
  show('partyCity', draft.partyCity);
  show('partyState', draft.partyState);
  show('partyPincode', draft.partyPincode);
  show('invoiceNo', draft.invoiceNo);
  show('invoiceDate', draft.invoiceDate);
  show('taxRate', draft.taxRate);
  show('items', JSON.stringify(draft.items));
  console.log('\nremark:\n' + result.remark);
}

const assert = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
  if (!ok) process.exitCode = 1;
  return ok;
};

/** Rasterises page 1 of a PDF so the same invoice can go through the OCR path. */
async function renderFirstPageToPng(pdf) {
  const { createCanvas } = require('@napi-rs/canvas');
  const pathSep = require('path').sep;
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts') + pathSep,
    cMapUrl: path.join(pdfjsRoot, 'cmaps') + pathSep,
    cMapPacked: true,
    verbosity: 0,
  }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 3 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toBuffer('image/png');
}

(async () => {
  const customPath = process.argv[2];
  const buffer = customPath
    ? fs.readFileSync(customPath)
    : await buildSampleInvoice();
  const fileName = customPath ? path.basename(customPath) : 'sample-invoice.pdf';

  // ── The text-layer path (a PDF straight out of an accounting package).
  const textResult = await ocr.extractInvoice({
    buffer,
    fileName,
    mimeType: 'application/pdf',
    ownCompany: OWN_COMPANY,
    checkDuplicates: false,
  });
  report(textResult, `TEXT-LAYER PDF — ${fileName}`);

  const draft = textResult.purchaseDraft;
  assert('supplier is the seller, not us', draft.partyName, SUPPLIER.name);
  assert('supplier GSTIN', draft.partyGstin, SUPPLIER.gstin);
  assert('supplier city', draft.partyCity, 'Vadodara');
  assert('supplier state', draft.partyState, 'Gujarat');
  assert('supplier phone', draft.partyPhone, '7352685205');
  assert('supplier email', draft.partyEmail, 'sales@vadodaraihub.in');
  assert('pincode not invented from "Vadodara-07"', draft.partyPincode, '');
  assert('invoice number is not the order number', draft.invoiceNo, '29');
  assert('invoice date normalised', draft.invoiceDate, '2026-10-05');
  assert('one item only', draft.items.length, 1);
  assert('item name stops at the first description line', draft.items[0].itemName, 'Laptop - Vivobook 14 Flip');
  assert('quantity', draft.items[0].quantity, 1);
  assert('pre-tax unit rate (not the tax-inclusive total)', draft.items[0].rate, 128389.83);
  assert('HSN read from the invoice', draft.items[0].hsnCode, '8471');
  assert('serial read from under the description', draft.items[0].serials, ['T1N0CV01Z128019']);
  assert('CGST + SGST combine into one rate', draft.taxRate, 18);
  assert('document recognised as a purchase', textResult.documentRole, 'purchase');

  // ── The same invoice as a picture: it has to survive the full OCR path.
  if (!customPath) {
    console.log('\nRendering the same invoice to an image and reading it with OCR…');
    const png = await renderFirstPageToPng(buffer);
    const tmp = path.join(os.tmpdir(), 'crs-invoice-ocr-test.png');
    fs.writeFileSync(tmp, png);

    const imageResult = await ocr.extractInvoice({
      buffer: png,
      fileName: 'invoice-photo.png',
      mimeType: 'image/png',
      ownCompany: OWN_COMPANY,
      checkDuplicates: false,
    });
    report(imageResult, 'PHOTOGRAPH / RENDERED IMAGE');

    const imageDraft = imageResult.purchaseDraft;
    assert('image: a supplier was identified', Boolean(imageDraft.partyName), true);
    assert('image: at least one item read', imageDraft.items.length >= 1, true);
    if (imageDraft.items.length) {
      assert('image: rate is not the tax-inclusive total', imageDraft.items[0].rate < 150000, true);
      assert('image: item name looks like a product', imageDraft.items[0].itemName.length > 3, true);
    }
    console.log(`\n(saved the test image to ${tmp})`);
  }

  await ocr.shutdown();
})().catch((err) => {
  console.error('\nPIPELINE ERROR:', err);
  process.exitCode = 1;
});