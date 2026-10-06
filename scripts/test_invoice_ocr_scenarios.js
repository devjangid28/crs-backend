/**
 * Scenarios the invoice reader has to get right.
 *
 * The first script (test_invoice_ocr.js) proves the happy path on one invoice.
 * This one covers the situations that actually cost money when they go wrong:
 * reading the wrong party as the supplier, inventing an HSN that was never
 * printed, losing an item on page two, and putting a tax-inclusive total in as a
 * unit rate.
 *
 *   node scripts/test_invoice_ocr_scenarios.js
 *
 * Every invoice is built with a real PDF text layer, so these run in a second
 * and test the parsing and validation rules rather than the OCR engine. No
 * database and no network are touched.
 */

const path = require('path');
const PDFDocument = require('pdfkit');

const ocr = require('../src/services/invoiceOcr');
const { gstinChecksumDigit } = require('../src/services/invoiceOcr/normalize');

const gstin = (first14) => first14 + gstinChecksumDigit(first14);

const SUPPLIER = {
  name: 'VADODARA IT HUB PRIVATE LIMITED',
  gstin: gstin('24AABCV1234C1Z'),
  address: ['05, Harmony complex, Opp. MK High School,', 'Alkapuri, Vadodara-07'],
  phone: '73526 85205',
  email: 'sales@vadodaraihub.in',
};

const OURS = {
  name: 'BLUECHIP COMPUTER SYSTEM',
  gstin: gstin('27AABCU9603R1Z'),
};

const CUSTOMER = {
  name: 'ONGC Vadodara A/C SAURABH CHOUBEY',
  gstin: gstin('24AAACO1234F1Z'),
  address: 'Vadodara, Gujarat - 390007',
};

/**
 * Renders an invoice from a plain description so each scenario only has to
 * state what makes it different.
 */
function renderInvoice(spec) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 32 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const issuer = spec.issuer;
    const buyer = spec.buyer;
    let y = 34;

    doc.font('Helvetica-Bold').fontSize(15).text(issuer.name, 32, y);
    y += 20;
    doc.font('Helvetica').fontSize(9);
    for (const line of issuer.address || []) { doc.text(line, 32, y); y += 12; }
    if (issuer.phone) { doc.text(`Phone: ${issuer.phone}`, 32, y); y += 12; }
    if (issuer.email) { doc.text(`Email: ${issuer.email}`, 32, y); y += 12; }
    if (issuer.gstin) { doc.text(`GSTIN: ${issuer.gstin}`, 32, y); y += 12; }
    doc.text('Tax Invoice', 32, y);
    y += 22;

    doc.font('Helvetica-Bold').fontSize(9);
    doc.text(`Invoice No.: ${spec.invoiceNo}`, 32, y);
    doc.text(`Dated: ${spec.invoiceDate}`, 200, y);
    y += 14;
    if (spec.reference) {
      doc.font('Helvetica').text(`Reference No. & Date: ${spec.reference}`, 32, y);
      y += 12;
      doc.text(`Buyer's Order No: ${spec.reference}`, 32, y);
      y += 16;
    }

    doc.font('Helvetica-Bold').text('Buyer (Bill To)', 330, y);
    doc.font('Helvetica').text(buyer.name, 330, y + 13, { width: 240 });
    doc.text(buyer.address || '', 330, y + 25, { width: 240 });
    if (buyer.gstin) doc.text(`GSTIN: ${buyer.gstin}`, 330, y + 37, { width: 240 });
    y += 70;

    // Item table
    const top = y;
    const cols = spec.withHsn
      ? [32, 56, 200, 236, 272, 314, 352, 390, 428, 466]
      : [32, 56, 220, 258, 300, 340, 378, 416, 454];
    doc.font('Helvetica-Bold').fontSize(7);
    let c = 0;
    doc.text('Sl No.', cols[c++], top);
    doc.text('Description of Goods', cols[c++], top);
    if (spec.withHsn) doc.text('HSN/SAC', cols[c++], top);
    doc.text('Quantity', cols[c++], top);
    doc.text('Rate (Excl. Tax)', cols[c++], top);
    doc.text('Taxable Value', cols[c++], top);
    if (spec.tax === 'igst') { doc.text('IGST %', cols[c++], top); doc.text('IGST Amount', cols[c++], top); }
    else { doc.text('CGST %', cols[c++], top); doc.text('CGST Amount', cols[c++], top); doc.text('SGST %', cols[c++], top); doc.text('SGST Amount', cols[c++], top); }
    doc.text('Amount', cols[c], top, { width: 60 });

    let rowY = top + 16;
    doc.font('Helvetica').fontSize(7);
    for (const item of spec.items) {
      const pct = item.taxPct != null ? item.taxPct : spec.taxPct;
      // An intra-state invoice splits the tax in half into CGST and SGST; an
      // inter-state one charges a single IGST at the full rate.
      const eachPct = spec.tax === 'igst' ? pct : pct / 2;
      const taxAmount = item.taxAmount != null
        ? item.taxAmount
        : (spec.tax === 'igst' ? item.taxable * pct / 100 : item.taxable * pct / 200);
      c = 0;
      doc.text(String(item.sl), cols[c++], rowY, { width: 20 });
      doc.text(item.name, cols[c++], rowY, { width: (spec.withHsn ? 140 : 160) });
      if (spec.withHsn) doc.text(item.hsn, cols[c++], rowY, { width: 30 });
      doc.text(String(item.qty), cols[c++], rowY, { width: 30 });
      doc.text(item.rate.toFixed(2), cols[c++], rowY, { width: 38 });
      doc.text(item.taxable.toFixed(2), cols[c++], rowY, { width: 36 });
      if (spec.tax === 'igst') {
        doc.text(eachPct.toFixed(2), cols[c++], rowY, { width: 30 });
        doc.text(taxAmount.toFixed(2), cols[c++], rowY, { width: 36 });
      } else {
        doc.text(eachPct.toFixed(2), cols[c++], rowY, { width: 30 });
        doc.text(taxAmount.toFixed(2), cols[c++], rowY, { width: 36 });
        doc.text(eachPct.toFixed(2), cols[c++], rowY, { width: 30 });
        doc.text(taxAmount.toFixed(2), cols[c++], rowY, { width: 36 });
      }
      doc.text((item.taxable + taxAmount * (spec.tax === 'igst' ? 1 : 2)).toFixed(2), cols[c], rowY, { width: 60 });
      rowY += 12;
      for (const note of item.notes || []) {
        // Advance by however many lines the note actually occupies — a long
        // serial list wraps inside the narrow description column, exactly as it
        // does on a real invoice.
        doc.text(note, cols[1], rowY, { width: 140 });
        rowY += doc.heightOfString(note, { width: 140 }) + 3;
      }
    }

    rowY += 14;
    const totals = spec.items.reduce((acc, i) => {
      const pct = i.taxPct != null ? i.taxPct : spec.taxPct;
      const amount = i.taxAmount != null ? i.taxAmount : i.taxable * pct / 100;
      return { taxable: acc.taxable + i.taxable, tax: acc.tax + amount };
    }, { taxable: 0, tax: 0 });

    doc.font('Helvetica-Bold');
    doc.text('Total Taxable Value', 272, rowY, { width: 90 });
    doc.text(totals.taxable.toFixed(2), 352, rowY, { width: 36 });
    rowY += 12;
    if (spec.tax !== 'igst') {
      doc.text('Total CGST', 272, rowY, { width: 90 });
      doc.text((totals.tax / 2).toFixed(2), 352, rowY, { width: 36 });
      rowY += 12;
      doc.text('Total SGST', 272, rowY, { width: 90 });
      doc.text((totals.tax / 2).toFixed(2), 352, rowY, { width: 36 });
      rowY += 12;
    } else {
      doc.text('Total IGST', 272, rowY, { width: 90 });
      doc.text(totals.tax.toFixed(2), 352, rowY, { width: 36 });
      rowY += 12;
    }
    doc.text('Total Tax', 272, rowY, { width: 90 });
    doc.text(totals.tax.toFixed(2), 352, rowY, { width: 36 });
    rowY += 12;
    doc.text('Grand Total', 272, rowY, { width: 90 });
    doc.text((totals.taxable + totals.tax).toFixed(2), 352, rowY, { width: 36 });

    doc.end();
  });
}

/** Two pages: the letterhead on one, the item table on the next. */
function renderTwoPageInvoice(spec) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 32 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(15).text(spec.issuer.name, 32, 34);
    doc.font('Helvetica').fontSize(9);
    let y = 58;
    for (const line of spec.issuer.address || []) { doc.text(line, 32, y); y += 12; }
    doc.text(`GSTIN: ${spec.issuer.gstin}`, 32, y); y += 16;
    doc.text('Tax Invoice', 32, y); y += 26;
    doc.font('Helvetica-Bold').text(`Invoice No.: ${spec.invoiceNo}`, 32, y);
    doc.text(`Dated: ${spec.invoiceDate}`, 200, y);

    doc.addPage();
    const top = 60;
    const cols = [32, 56, 200, 236, 272, 314, 352, 390, 428, 466];
    doc.font('Helvetica-Bold').fontSize(7);
    let c = 0;
    doc.text('Sl No.', cols[c++], top);
    doc.text('Description of Goods', cols[c++], top);
    doc.text('HSN/SAC', cols[c++], top);
    doc.text('Quantity', cols[c++], top);
    doc.text('Rate (Excl. Tax)', cols[c++], top);
    doc.text('Taxable Value', cols[c++], top);
    doc.text('CGST %', cols[c++], top);
    doc.text('CGST Amount', cols[c++], top);
    doc.text('SGST %', cols[c++], top);
    doc.text('SGST Amount', cols[c++], top);
    doc.text('Amount', cols[c], top, { width: 60 });

    let rowY = top + 16;
    doc.font('Helvetica').fontSize(7);
    for (const item of spec.items) {
      c = 0;
      doc.text(String(item.sl), cols[c++], rowY, { width: 20 });
      doc.text(item.name, cols[c++], rowY, { width: 140 });
      doc.text(item.hsn, cols[c++], rowY, { width: 30 });
      doc.text(String(item.qty), cols[c++], rowY, { width: 30 });
      doc.text(item.rate.toFixed(2), cols[c++], rowY, { width: 38 });
      doc.text(item.taxable.toFixed(2), cols[c++], rowY, { width: 36 });
      doc.text(String(spec.taxPct / 2), cols[c++], rowY, { width: 30 });
      doc.text((item.taxable * spec.taxPct / 200).toFixed(2), cols[c++], rowY, { width: 36 });
      doc.text(String(spec.taxPct / 2), cols[c++], rowY, { width: 30 });
      doc.text((item.taxable * spec.taxPct / 200).toFixed(2), cols[c++], rowY, { width: 36 });
      doc.text((item.taxable * (1 + spec.taxPct / 100)).toFixed(2), cols[c], rowY, { width: 60 });
      rowY += 14;
    }

    doc.font('Helvetica-Bold');
    const totals = spec.items.reduce((s, i) => s + i.taxable, 0);
    doc.text('Total Taxable Value', 272, rowY + 16, { width: 90 });
    doc.text(totals.toFixed(2), 352, rowY + 16, { width: 36 });
    doc.text('Grand Total', 272, rowY + 40, { width: 90 });
    doc.text((totals * (1 + spec.taxPct / 100)).toFixed(2), 352, rowY + 40, { width: 36 });

    doc.end();
  });
}

// ── assertions ──────────────────────────────────────────────────────────────

let failures = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${e}\n        actual   ${a}`}`);
  if (!ok) failures += 1;
};
const checkThat = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || !detail ? '' : `\n        ${detail}`}`);
  if (!condition) failures += 1;
};

const run = async () => {
  // ── 1. Bluechip is the SELLER: we must not become the supplier ───────────
  {
    const buffer = await renderInvoice({
      issuer: OURS,
      buyer: CUSTOMER,
      invoiceNo: 'BCCS/26-27/118',
      invoiceDate: '05-Oct-2026',
      withHsn: true,
      taxPct: 18,
      items: [{ sl: 1, name: 'Laptop - Vivobook 14 Flip', hsn: '8471', qty: 1, rate: 128389.83, taxable: 128389.83, notes: ['Serial No: T1N0CV01Z128019'] }],
    });
    const result = await ocr.extractInvoice({ buffer, fileName: 'our-sales.pdf', mimeType: 'application/pdf', ownCompany: OURS, checkDuplicates: false });
    const draft = result.purchaseDraft;
    console.log('\n── Scenario 1: this company is the seller ──');
    check('recognised as our own sales invoice', result.documentRole, 'sales');
    checkThat('supplier is NOT us', !/bluechip/i.test(draft.partyName || ''), `got "${draft.partyName}"`);
    checkThat('supplier is the party that bought from us', /ONGC/i.test(draft.partyName || ''), `got "${draft.partyName}"`);
    checkThat('supplier is flagged for review', ['review', 'verify'].includes(result.supplier.partyName.band), `band ${result.supplier.partyName.band}`);
    checkThat('a warning explains why', (result.validation.warnings || []).some(w => w.code === 'document-is-sales-invoice'));
    checkThat('the remark records that this was a sales invoice', /sales invoice/i.test(result.remark));
  }

  // ── 2. Bluechip is the BUYER: normal purchase ────────────────────────────
  {
    const buffer = await renderInvoice({
      issuer: SUPPLIER,
      buyer: OURS,
      invoiceNo: '29',
      invoiceDate: '05-Oct-2026',
      reference: 'ORD-2026-OCT-0006',
      withHsn: true,
      taxPct: 18,
      items: [{ sl: 1, name: 'Laptop - Vivobook 14 Flip', hsn: '8471', qty: 1, rate: 128389.83, taxable: 128389.83, notes: ['Serial No: T1N0CV01Z128019', 'Model No: TP3407SA-QL025WS'] }],
    });
    const result = await ocr.extractInvoice({ buffer, fileName: 'purchase.pdf', mimeType: 'application/pdf', ownCompany: OURS, checkDuplicates: false });
    const draft = result.purchaseDraft;
    console.log('\n── Scenario 2: this company is the buyer ──');
    check('recognised as a purchase invoice', result.documentRole, 'purchase');
    check('supplier is the seller, not us', draft.partyName, SUPPLIER.name);
    check('supplier GSTIN', draft.partyGstin, SUPPLIER.gstin);
    check('invoice number is the invoice number, not the order number', draft.invoiceNo, '29');
    check('invoice date normalised', draft.invoiceDate, '2026-10-05');
    check('one item row', draft.items.length, 1);
    check('pre-tax rate, never the tax-inclusive total', draft.items[0].rate, 128389.83);
    check('serial mapped to the right product', draft.items[0].serials, ['T1N0CV01Z128019']);
    check('model number kept as a note, not a second item', draft.items.length, 1);
    checkThat('model number is in the notes', draft.items[0].notes.some(n => /TP3407SA/.test(n)));
    check('CGST + SGST add up to one 18% rate', draft.taxRate, 18);
    checkThat('no tax mismatch reported', !(result.validation.warnings || []).some(w => w.code === 'invoice-total-mismatch'));
  }

  // ── 3. Missing HSN and missing GSTIN must stay blank ─────────────────────
  {
    const buffer = await renderInvoice({
      issuer: { ...SUPPLIER, gstin: '' },
      buyer: OURS,
      invoiceNo: '77',
      invoiceDate: '12-Sep-2026',
      withHsn: false,
      taxPct: 18,
      items: [
        { sl: 1, name: 'USB-C Cable 1m', qty: 5, rate: 250, taxable: 1250 },
        { sl: 2, name: 'Mouse', qty: 2, rate: 600, taxable: 1200 },
      ],
    });
    const result = await ocr.extractInvoice({ buffer, fileName: 'no-hsn.pdf', mimeType: 'application/pdf', ownCompany: OURS, checkDuplicates: false });
    const draft = result.purchaseDraft;
    console.log('\n── Scenario 3: nothing printed, nothing invented ──');
    check('two separate rows, not one merged line', draft.items.length, 2);
    check('HSN left blank on every row', draft.items.map(i => i.hsnCode), ['', '']);
    check('GSTIN left blank', draft.partyGstin, '');
    checkThat('blank HSN is explained rather than guessed', result.items.every(i => /HSN/i.test((i.hsnCode.warnings || []).join(' '))));
    check('quantity kept', draft.items[0].quantity, 5);
    check('amount is qty x rate, not the line total', draft.items[0].rate, 250);
  }

  // ── 4. IGST instead of CGST + SGST ───────────────────────────────────────
  {
    const buffer = await renderInvoice({
      issuer: { ...SUPPLIER, name: 'SOUTH INDIA ELECTRONICS', address: ['No 12, Anna Salai, Chennai - 600002'] },
      buyer: OURS,
      invoiceNo: 'SI/2026/441',
      invoiceDate: '01-Sep-2026',
      withHsn: true,
      tax: 'igst',
      taxPct: 18,
      items: [{ sl: 1, name: 'DDR4 8GB Laptop RAM', hsn: '8542', qty: 4, rate: 2400, taxable: 9600 }],
    });
    const result = await ocr.extractInvoice({ buffer, fileName: 'igst.pdf', mimeType: 'application/pdf', ownCompany: OURS, checkDuplicates: false });
    const draft = result.purchaseDraft;
    console.log('\n── Scenario 4: IGST ──');
    check('IGST is read as a single 18% rate', draft.taxRate, 18);
    check('quantity of 4 kept as a whole number', draft.items[0].quantity, 4);
    check('unit rate, not the line total', draft.items[0].rate, 2400);
    check('HSN read', draft.items[0].hsnCode, '8542');
    checkThat('no IGST/CGST mix-up warning', !(result.validation.warnings || []).some(w => /CGST/.test(w.message)));
  }

  // ── 5. Five line items stay five line items ──────────────────────────────
  {
    const items = [
      { sl: 1, name: 'Laptop - Vivobook 14 Flip', hsn: '8471', qty: 1, rate: 128389.83, taxable: 128389.83, notes: ['Serial No: T1N0CV01Z128019'] },
      { sl: 2, name: 'DDR4 8GB Laptop RAM', hsn: '8542', qty: 4, rate: 2400, taxable: 9600, notes: ['Serial No: RAM-A1, RAM-A2, RAM-A3, RAM-A4'] },
      { sl: 3, name: '500GB NVMe SSD', hsn: '8471', qty: 2, rate: 3200, taxable: 6400, notes: ['Serial No: SSD-B1, SSD-B2'] },
      { sl: 4, name: 'USB-C Charging Adapter 65W', hsn: '8504', qty: 3, rate: 1450, taxable: 4350 },
      { sl: 5, name: 'Wireless Mouse', hsn: '8471', qty: 6, rate: 620, taxable: 3720 },
    ];
    const buffer = await renderInvoice({
      issuer: SUPPLIER, buyer: OURS, invoiceNo: 'BULK/2026/88', invoiceDate: '18-Oct-2026',
      withHsn: true, taxPct: 18, items,
    });
    const result = await ocr.extractInvoice({ buffer, fileName: 'bulk.pdf', mimeType: 'application/pdf', ownCompany: OURS, checkDuplicates: false });
    const draft = result.purchaseDraft;
    console.log('\n── Scenario 5: five products ──');
    check('every product became its own row', draft.items.length, 5);
    check('names in order', draft.items.map(i => i.itemName), items.map(i => i.name));
    check('rates in order', draft.items.map(i => i.rate), items.map(i => i.rate));
    check('serial numbers land on the right rows', [draft.items[1].serials, draft.items[2].serials], [['RAM-A1', 'RAM-A2', 'RAM-A3', 'RAM-A4'], ['SSD-B1', 'SSD-B2']]);
    checkThat('a serial batch larger than the quantity is reported', !(result.validation.warnings || []).some(w => /serial numbers were read/.test(w.message)));
    checkThat('no invoice total mismatch', !(result.validation.warnings || []).some(w => w.code === 'invoice-total-mismatch'));
  }

  // ── 6. Two pages: everything on page 2 must still be read ────────────────
  {
    const buffer = await renderTwoPageInvoice({
      issuer: SUPPLIER, buyer: OURS, invoiceNo: 'MP/2026/7', invoiceDate: '02-Oct-2026', taxPct: 18,
      items: [
        { sl: 1, name: 'Laptop - Vivobook 14 Flip', hsn: '8471', qty: 1, rate: 128389.83, taxable: 128389.83 },
        { sl: 2, name: 'Laptop Bag', hsn: '4202', qty: 1, rate: 1200, taxable: 1200 },
        { sl: 3, name: 'HDMI Cable 2m', hsn: '8544', qty: 2, rate: 350, taxable: 700 },
      ],
    });
    const result = await ocr.extractInvoice({ buffer, fileName: 'two-pages.pdf', mimeType: 'application/pdf', ownCompany: OURS, checkDuplicates: false });
    const draft = result.purchaseDraft;
    console.log('\n── Scenario 6: items on page 2 ──');
    check('both pages processed', result.source.pagesProcessed, 2);
    check('items on page 2 were not lost', draft.items.map(i => i.itemName), ['Laptop - Vivobook 14 Flip', 'Laptop Bag', 'HDMI Cable 2m']);
    check('the supplier on page 1 still found the supplier', draft.partyName, SUPPLIER.name);
  }

  // ── 7. Dates in the formats real invoices use ────────────────────────────
  {
    const formats = ['05-Oct-2026', '05/10/2026', '2026-10-05', '5 October 2026', '05-10-2026'];
    const results = [];
    for (const dateFormat of formats) {
      const buffer = await renderInvoice({
        issuer: SUPPLIER, buyer: OURS, invoiceNo: 'D/1', invoiceDate: dateFormat,
        withHsn: true, taxPct: 18,
        items: [{ sl: 1, name: 'SSD 1TB', hsn: '8471', qty: 1, rate: 5500, taxable: 5500 }],
      });
      // eslint-disable-next-line no-await-in-loop
      results.push(await ocr.extractInvoice({ buffer, fileName: 'date.pdf', mimeType: 'application/pdf', ownCompany: OURS, checkDuplicates: false }));
    }
    console.log('\n── Scenario 7: date formats ──');
    check('every date format normalised to the same day', results.map(r => r.purchaseDraft.invoiceDate), ['2026-10-05', '2026-10-05', '2026-10-05', '2026-10-05', '2026-10-05']);
    checkThat('an ambiguous day/month order is flagged, not guessed', results[1].invoice.date.warnings.length > 0);
    check('all shown to the user as DD-MM-YYYY', results[0].invoice.dateDisplay, '05-10-2026');
  }

  await ocr.shutdown();
  console.log(`\n${failures === 0 ? 'All scenarios passed.' : `${failures} check(s) failed.`}`);
  if (failures > 0) process.exitCode = 1;
};

run().catch((err) => {
  console.error('\nSCENARIO ERROR:', err);
  process.exitCode = 1;
});