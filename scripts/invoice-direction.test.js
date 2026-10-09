// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — invoice direction tests
//
//  These are the three documents that exposed the original defect:
//
//    TEST A  Matshwari      external seller → us     must import as a purchase
//    TEST B  V.S. Packaging us as seller              must be rejected
//    TEST C  Prajapati      us as seller              must be rejected
//
//  The fixtures are line-for-line reconstructions of the printed layout, with
//  the geometry the real reader produces (bounding boxes, per-word boxes and
//  OCR confidence). They are deliberately hand-written rather than captured,
//  so the expectations in this file are the specification.
//
//  Run with:  node scripts/invoice-direction.test.js
// ─────────────────────────────────────────────────────────────────────────────

const assert = require('assert');
const path = require('path');

const { parseInvoice, isDocumentTitle, gstinIn } = require('../src/services/invoiceOcr/parser');
const identity = require('../src/services/invoiceOcr/companyIdentity');
const { buildValidationReport, validateMath } = require('../src/services/invoiceOcr/validate');

// The company's own details, exactly as this tenant has them configured. Nothing
// about Bluechip is hard-coded in the parser — it is handed in as a profile, and
// the tests read it the same way the route does.
const OWN_COMPANY = {
  legalName: 'BLUECHIP COMPUTER SYSTEM',
  knownNames: identity.expandTradeNames([
    'BLUECHIP COMPUTER SYSTEM',
    'BLUECHIP COMPUTER SYSTEM [ASUS EXCLUSIVE STORE]',
  ]),
  ownerNames: [],
  gstins: ['27AABCU9603R1ZM'],
  phones: ['9904991114'],
  emails: ['aes.bluechip@gmail.com'],
  websites: ['bccsgroup.in'],
  addresses: [],
  sources: ['store-configuration'],
  configured: true,
  isEmpty: false,
};

// ── Fixture helpers ──────────────────────────────────────────────────────────

const LINE_HEIGHT = 14;
let cursor = 0;

/** One printed line, with per-word boxes laid out left to right. */
function line(text, { x = 40, y = null, confidence = 96, gap = 8 } = {}) {
  const top = y === null ? (cursor += LINE_HEIGHT + 6) : y;
  // An array is a table row: each entry is [text, exact x], so every value really
  // does sit in the column its header sits over.
  const parts = Array.isArray(text) ? text : null;
  const words = [];
  let cx = x;
  for (const token of parts ? [] : String(text).split(/\s+/)) {
    const w = Math.max(12, Math.round(token.length * 7));
    words.push({
      text: token,
      confidence,
      bbox: { x0: cx, y0: top, x1: cx + w, y1: top + LINE_HEIGHT },
    });
    cx += w + gap;
  }
  if (parts) {
    let right = x;
    for (const [raw, px] of parts) {
      let cx = px;
      for (const piece of String(raw).split(/\s+/)) {
        const w = Math.max(12, Math.round(piece.length * 7));
        words.push({
          text: piece,
          confidence,
          bbox: { x0: cx, y0: top, x1: cx + w, y1: top + LINE_HEIGHT },
        });
        cx += w + gap;
      }
      right = Math.max(right, cx - gap);
    }
    const flat = parts.map(([raw]) => String(raw)).join(' ');
    return {
      text: flat,
      confidence,
      bbox: { x0: x, y0: top, x1: right, y1: top + LINE_HEIGHT },
      words,
    };
  }
  return {
    text,
    confidence,
    bbox: { x0: x, y0: top, x1: cx, y1: top + LINE_HEIGHT },
    words,
  };
}

function page(lines) {
  return [{
    pageNumber: 1,
    width: 1000,
    height: 1400,
    source: 'image-ocr',
    lines,
    text: lines.map((l) => l.text).join('\n'),
    characterCount: lines.map((l) => l.text).join('\n').length,
    meanConfidence: 96,
  }];
}

/** Runs one fixture through the whole read-and-validate path. */
function read(lines, ownProfile = OWN_COMPANY) {
  const parsed = parseInvoice({ pages: page(lines), identity: ownProfile });
  const math = validateMath(parsed);
  const validation = buildValidationReport({
    parsed,
    math,
    duplicate: null,
    serialCheck: null,
    qualityAssessment: null,
  });
  return { parsed, math, validation };
}

// ── TEST A — Matshwari sells to us ────────────────────────────────────────────
//
// MATSHWARI is the issuer (top of the page) and we are named under "Bill To".
// This is the shape a real purchase invoice has, and it is the case the old
// reader got right by luck — it must stay right.

function matshwariInvoice() {
  cursor = 0;
  return [
    line('Tax Invoice'),
    line('MATSHWARI COMPUTER & SERVICES'),
    line('Shop 12, Tilak Road, Vadodara, Gujarat 390021'),
    line('GSTIN: 24AAECM1234F1Z5   Ph: 0265 2334455'),
    line('Email: sales@matshwari.example'),
    line('Invoice No: 4471'),
    line('Dated: 04-Oct-2026'),
    line('Bill To:'),
    line('BLUECHIP COMPUTER SYSTEM'),
    line('GSTIN: 27AABCU9603R1ZM'),
    line('Ph: 9904991114'),
    line('Sl Description of Goods HSN Qty Rate Taxable Value Amount'),
    line('1 Laptop 84733010 1 450.00 450.00 531.00'),
    line('Serial No: SNM4471X1'),
    line('Total'),
    line('450.00'),
    line('CGST 9% 40.50'),
    line('SGST 9% 40.50'),
    line('Grand Total 531.00'),
    line('Declaration'),
    line('Authorised Signatory'),
  ];
}

// ── TEST B — we sell to V.S. Packaging ────────────────────────────────────────

function vsPackagingInvoice() {
  cursor = 0;
  return [
    line('Tax Invoice'),
    line('BLUECHIP COMPUTER SYSTEM'),
    line('Shop 4, Ring Road, Vadodara, Gujarat 390021'),
    line('GSTIN: 27AABCU9603R1ZM   Ph: 9904991114'),
    line('Email: aes.bluechip@gmail.com'),
    line('www.bccsgroup.in'),
    line('Invoice No: 91'),
    line('Dated: 02-Oct-2026'),
    line('Bill To:'),
    line('V.S. PACKAGING PRIVATE LIMITED'),
    line('GSTIN: 24AABCV9987K1ZP'),
    line('Sl Description of Goods HSN Qty Rate Taxable Value Amount'),
    line('1 Corrugated Boxes 48191010 100 12.00 1200.00 1416.00'),
    line('Total'),
    line('1200.00'),
    line('CGST 9% 108.00'),
    line('SGST 9% 108.00'),
    line('Grand Total 1416.00'),
  ];
}

// ── TEST C — we sell to Prajapati (the reported failure) ──────────────────────
//
// This is the document that produced "Party Name = Tax Invoice". The title sits
// above our own name, our GSTIN is in the letterhead, and the buyer is a person.

function prajapatiInvoice() {
  cursor = 0;
  return [
    line('Tax Invoice'),
    line('Invoice No. 22'),
    line('BLUECHIP COMPUTER SYSTEM [ASUS EXCLUSIVE STORE]'),
    line('Shop 4, Ring Road, Vadodara, Gujarat 390021'),
    line('GSTIN: 27AABCU9603R1ZM'),
    line('Ph: 9904991114'),
    line('Email: aes.bluechip@gmail.com'),
    line('Dated 17-09-2026'),
    line('Consignee'),
    line('Prajapati Harsh Shirishbhai'),
    line('Bill To'),
    line('Prajapati Harsh Shirishbhai'),
    line('Sl Description of Goods HSN Qty Rate Taxable Value Amount'),
    line('1 Laptop 84733010 1 55076.27 55076.27 64990.00'),
    // A product's own details are printed under the description column, so they
    // are indented to sit inside it — which is how the reader tells them apart
    // from the next row's numbers.
    line('Serial No: W3N0RJ009471123', { x: 95 }),
    line('Model No: X1605VA-MB1627WS', { x: 95 }),
    line('Part No: 90NB10N2-M021S0', { x: 95 }),
    line('Check No: 95Z7', { x: 95 }),
    line('Warranty: 1 YEAR OF HARDWARE WARRANTY', { x: 95 }),
    line('2 Accessories - Wireless Combo 84733042 1 1101.69 1101.69 1300.00'),
    line('Serial No: W7BKNV1011128XW', { x: 95 }),
    line('Warranty: 3 YEARS OF HARDWARE WARRANTY', { x: 95 }),
    line('3 Accessories - Backpack 42029290 1 0.00 0.00 0.00'),
    line('Total'),
    line('56177.96'),
    line('CGST 9% 5056.02'),
    line('SGST 9% 5056.02'),
    line('Grand Total 66290.00'),
    line('Payment Date 05-10-2026'),
    line('Declaration'),
    line('Terms & Conditions'),
    line('Bank Details: HDFC Bank A/c 50200012345678 IFSC HDFC0001234'),
    line('Authorised Signatory'),
  ];
}

// ── TEST E — JBR Solutions ────────────────────────────────────────────────────
//
// The invoice that exposed the second defect. There is no "Seller" heading
// anywhere on it. The roles come only from the structure: the issuer block sits
// at the top with the invoice metadata beside it, and "Bill To:" introduces the
// buyer below. It also uses the label spellings that were previously unread —
// "GSTIN/UIN" and "State Name: Gujarat, Code: 24" — and a two-digit year.

function jbrInvoice() {
  cursor = 0;
  return [
    line('Tax Invoice'),
    // Two-column header: issuer on the left, invoice metadata on the right.
    line('JBR SOLUTIONS', { x: 40 }),
    line('Invoice No: JBR/428/26-27', { x: 330 }),
    line('M-35, Paranam Complex, Vadodara', { x: 40 }),
    line('Dated: 5-Oct-26', { x: 330 }),
    line('Ph: 265 2334455', { x: 40 }),
    line('Mode/Terms of Payment: Cash', { x: 330 }),
    line('GSTIN/UIN: 24AAJFB1234F1Z8', { x: 40 }),
    line("Reference No: 8891", { x: 330 }),
    line("Buyer's Order No: 4471", { x: 330 }),
    line('State Name: Gujarat, Code: 24', { x: 40 }),
    line('Bill To:'),
    line('M/s BLUECHIP COMPUTER SYSTEM'),
    line('001 Vrundavan Complex, Vadodara'),
    line('GSTIN/UIN: 24AANFB3091M126'),
    line('State Name: Gujarat, Code: 24'),
    line([['Sl', 40], ['Description of Goods', 70], ['HSN', 240], ['Qty', 280], ['Rate', 320], ['Taxable Value', 370], ['Amount', 490]]),
    // The real layout: the description continues underneath itself, and every
    // number sits under the header it belongs to.
    line([['1', 40], ['LAPTOP ACCESSORIES PARTS', 70], ['8523', 240], ['1', 280], ['1200.00', 320], ['1200.00', 370], ['1416.00', 490]]),
    line([['ASUS E2N17V25 ORG BATTERY', 76]]),
    line([['6 MONTH WARRANTY', 76]]),
    line([['2', 40], ['LAPTOP ACCESSORIES PARTS', 70], ['8523', 240], ['2', 280], ['1150.00', 320], ['2300.00', 370], ['2714.00', 490]]),
    line([['HP JC4 ORG BATTERY', 76]]),
    line('Total', { x: 440 }),
    line('1200.00', { x: 530 }),
    line('2300.00', { x: 530 }),
    line('CGST 9%', { x: 440 }),
    line('211.50', { x: 530 }),
    line('211.50', { x: 530 }),
    line('SGST 9%', { x: 440 }),
    line('211.50', { x: 530 }),
    line('211.50', { x: 530 }),
    line('Grand Total', { x: 440 }),
    line('4130.00', { x: 530 }),
    line("For JBR SOLUTIONS"),
  ];
}

// ── Regression case — a document title must never become a party ──────────────

function titleOnlyHeaderInvoice() {
  cursor = 0;
  return [
    line('Tax Invoice'),
    line('Sales Invoice'),
    line('Invoice No. 5'),
    line('Bill To'),
    line('MATSHWARI COMPUTER & SERVICES'),
    line('GSTIN: 24AAECM1234F1Z5'),
    line('Sl Description of Goods HSN Qty Rate Taxable Value Amount'),
    line('1 Monitor 85285210 2 9000.00 18000.00 21240.00'),
    line('Grand Total 21240.00'),
  ];
}

// ── Test runner ──────────────────────────────────────────────────────────────

const results = [];
const pending = [];
function test(name, fn) {
  // A test may be async (it can read configuration), so every case is settled
  // before the report is printed.
  const settle = (err) => results.push({ name, ok: !err, err: err || null });
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      pending.push(out.then(() => settle(), settle));
      return;
    }
    settle();
  } catch (err) {
    settle(err);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('TEST E — JBR Solutions: no "Seller" heading, roles come from structure → PURCHASE', () => {
  const { parsed, validation } = read(jbrInvoice());

  assert.strictEqual(parsed.documentRole, 'purchase',
    `expected purchase, got ${parsed.documentRole} (supplier=${parsed.supplier && parsed.supplier.name.value})`);
  assert.strictEqual(parsed.ourRole, 'buyer');

  // The supplier is the issuer block, chosen by position — not by a keyword.
  assert.match(parsed.supplier.name.value, /JBR SOLUTIONS/i,
    `supplier should be the issuer, got "${parsed.supplier.name.value}"`);
  assert.doesNotMatch(parsed.supplier.name.value, /BLUECHIP/i);

  // "GSTIN/UIN" is how this invoice labels the field; it used to read as nothing.
  assert.strictEqual(parsed.supplier.gstin.value, '24AAJFB1234F1Z8',
    `the seller's GSTIN must be read from a GSTIN/UIN label, got ${parsed.supplier.gstin.value}`);
  assert.doesNotMatch(parsed.supplier.gstin.value || '', /24AANFB3091M126/,
    'the buyer GSTIN must never become the supplier GSTIN');

  // "State Name: Gujarat, Code: 24" must not put the whole sentence in State.
  assert.strictEqual(parsed.supplier.state.value, 'Gujarat',
    `state should be Gujarat, got "${parsed.supplier.state.value}"`);

  // The party is introduced with "M/s", which is not part of its name.
  assert.doesNotMatch(parsed.supplier.name.value, /^m\s*\/\s*s/i);

  // Both table rows are read, and each keeps its whole description.
  assert.strictEqual(parsed.items.length, 2,
    `expected 2 items, got ${parsed.items.length}`);
  assert.match(parsed.items[0].itemName.value, /LAPTOP ACCESSORIES PARTS/i);
  assert.match(parsed.items[0].itemName.value, /ASUS E2N17V25 ORG BATTERY/i,
    `the second description line belongs to item 1: "${parsed.items[0].itemName.value}"`);
  assert.doesNotMatch(parsed.items[0].itemName.value, /^\s*\d+\s+MONTH WARRANTY/i,
    'the warranty line must not become the item name');
  assert.strictEqual(parsed.items[0].hsnCode.value, '8523');
  assert.strictEqual(parsed.items[0].unitRate.value, 1200);
  assert.strictEqual(parsed.items[1].quantity.value, 2);
  assert.match(parsed.items[1].itemName.value, /HP JC4 ORG BATTERY/i);

  assert.strictEqual(validation.ok, true,
    `expected a clean validation, got: ${validation.blocking.map((b) => b.code).join(', ')}`);
});

test('the buyer block is read from "Bill To" even without a "Seller" label', () => {
  const { parsed } = read(jbrInvoice());
  assert.match(parsed.buyer?.name?.value || '', /BLUECHIP/i,
    `the Bill To block should be the buyer, got "${parsed.buyer?.name?.value}"`);
});

test('an unreadable page is reported as unreadable, not as "not a purchase"', () => {
  const lines = [line('a'), line('b')];
  const parsed = parseInvoice({ pages: page(lines), identity: OWN_COMPANY });
  const math = validateMath(parsed);
  // The read-health verdict itself is produced by the pipeline; here the parser's
  // own guard is what must not claim a direction.
  assert.notStrictEqual(parsed.documentRole, 'purchase');
  const validation = buildValidationReport({
    parsed, math, duplicate: null, serialCheck: null, qualityAssessment: null,
    readHealth: { ocrFailed: true, imageUnreadable: false, remedies: ['retake it'] },
  });
  const codes = validation.blocking.map((b) => b.code);
  assert.ok(codes.includes('ocr-unreadable'), `expected an OCR failure, got ${codes.join(', ')}`);
  assert.strictEqual(codes.includes('direction-not-determined'), false,
    'a failed read must not also claim the direction is undetermined');
});

test('GSTIN is read from every label spelling an invoice uses', () => {
  for (const label of ['GSTIN/UIN', 'GSTIN', 'GST No.', 'GST No', 'GST/IGST', 'GSTIN/UID']) {
    const found = gstinIn([{ text: `${label}: 24AANFB3091M126`, confidence: 95, bbox: { x0: 0, y0: 0, x1: 200, y1: 12 } }]);
    assert.ok(found, `failed to read a GSTIN under the label "${label}"`);
    assert.strictEqual(found.raw, '24AANFB3091M126', `wrong value read under "${label}"`);
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

test('document titles are recognised as titles, not parties', () => {
  for (const title of ['Tax Invoice', 'TAX INVOICE', 'Sales Invoice', 'Original for Recipient', 'Page 1 of 2']) {
    assert.ok(isDocumentTitle(title), `expected "${title}" to be rejected as a party name`);
  }
  for (const name of ['BLUECHIP COMPUTER SYSTEM', 'MATSHWARI COMPUTER & SERVICES', 'Prajapati Harsh Shirishbhai']) {
    assert.ok(!isDocumentTitle(name), `expected "${name}" to be allowed as a party name`);
  }
});

test('TEST A — Matshwari: external seller, we are the buyer → PURCHASE', () => {
  const { parsed, validation } = read(matshwariInvoice());

  assert.strictEqual(parsed.documentRole, 'purchase', `expected purchase, got ${parsed.documentRole}`);
  assert.strictEqual(parsed.ourRole, 'buyer');
  assert.strictEqual(parsed.classification.importable, true);
  assert.strictEqual(validation.ok, true,
    `expected a clean validation, got: ${validation.blocking.map((b) => b.code).join(', ')}`);

  // The supplier is the SELLER, read from the Matshwari block.
  assert.match(parsed.supplier.name.value, /MATSHWARI/i);
  assert.doesNotMatch(parsed.supplier.name.value, /^tax\s*invoice$/i);

  // Supplier details come from the seller block, not from ours.
  assert.match(parsed.supplier.gstin.value, /^24AAECM1234F1Z5$/,
    `supplier GSTIN must be the seller's, got ${parsed.supplier.gstin.value}`);
  assert.doesNotMatch(parsed.supplier.gstin.value || '', /27AABCU9603R1ZM/,
    'our own GSTIN must never become the supplier GSTIN');
  assert.strictEqual(parsed.supplier.phone.value, '02652334455');
  assert.strictEqual(parsed.supplier.email.value, 'sales@matshwari.example');
  assert.ok(parsed.invoice.number.value);
  assert.ok(parsed.invoice.date.value.startsWith('2026-10-04'));
});

test('TEST B — V.S. Packaging: we are the seller → SALES, rejected', () => {
  const { parsed, validation } = read(vsPackagingInvoice());

  assert.strictEqual(parsed.documentRole, 'sales', `expected sales, got ${parsed.documentRole}`);
  assert.strictEqual(parsed.ourRole, 'seller');
  assert.strictEqual(parsed.classification.importable, false);

  // No supplier is offered at all.
  assert.strictEqual(parsed.supplier, null, 'a sales invoice must not produce a supplier');

  const codes = validation.blocking.map((b) => b.code);
  assert.ok(codes.includes('document-is-sales-invoice'), `expected a sales-invoice block, got ${codes.join(', ')}`);
  assert.strictEqual(validation.ok, false);
  assert.match(parsed.classification.headline, /sales invoice/i);
  assert.match(parsed.classification.buyerName || '', /V\.S\. PACKAGING/i);
});

test('TEST C — Prajapati: we are the seller, title above our name → SALES, rejected', () => {
  const { parsed, validation } = read(prajapatiInvoice());

  assert.strictEqual(parsed.documentRole, 'sales', `expected sales, got ${parsed.documentRole}`);
  assert.strictEqual(parsed.ourRole, 'seller');
  assert.strictEqual(parsed.classification.importable, false);
  assert.strictEqual(parsed.supplier, null);

  const codes = validation.blocking.map((b) => b.code);
  assert.ok(codes.includes('document-is-sales-invoice'), `expected a sales-invoice block, got ${codes.join(', ')}`);
  assert.match(parsed.classification.buyerName || '', /Prajapati/i);

  // The invoice number and date are still read — the rejection explains itself
  // with facts, it does not pretend the document was unreadable.
  assert.strictEqual(parsed.invoice.number.value, '22');
  assert.ok(parsed.invoice.date.value.startsWith('2026-09-17'));
});

test('TEST C — the payment date never becomes the invoice date', () => {
  const { parsed } = read(prajapatiInvoice());
  assert.ok(parsed.invoice.date.value.startsWith('2026-09-17'),
    `invoice date must come from "Dated", got ${parsed.invoice.date.value}`);
  assert.notStrictEqual(parsed.invoice.date.value.startsWith('2026-10-05'), true);
});

test('TEST C — item metadata stays with the item', () => {
  const { parsed } = read(prajapatiInvoice());
  const laptop = parsed.items[0];
  assert.ok(laptop, 'expected at least one item');
  assert.match(laptop.itemName.value, /^laptop/i, `item name must be the product, got "${laptop.itemName.value}"`);
  assert.doesNotMatch(laptop.itemName.value, /warranty/i);
  assert.strictEqual(laptop.serials[0]?.value, 'W3N0RJ009471123');
});

test('regression — a header of document titles never yields "Tax Invoice" as the party', () => {
  const { parsed } = read(titleOnlyHeaderInvoice());
  // The letterhead is still read, and what it says is the company — never the
  // document's own title.
  assert.ok(parsed.issuer, 'the issuer should still be found behind the titles');
  assert.doesNotMatch(parsed.issuer.name, /invoice/i,
    `"Tax Invoice" leaked into the issuer name: ${parsed.issuer.name}`);
  assert.match(parsed.issuer.name, /MATSHWARI/i);
  // Nothing on this document mentions us, so the direction is undetermined and
  // deliberately no supplier is offered.
  assert.strictEqual(parsed.documentRole, 'unknown');
  assert.strictEqual(parsed.supplier, null);
});

test('unconfigured identity falls back to the legacy behaviour instead of blocking', () => {
  // Deliberately not the database: this case is "an installation that has never
  // filled in its own company details", which must keep working.
  const empty = identity.fromRequest({});
  assert.strictEqual(empty.configured, false);
  const { parsed, validation } = read(matshwariInvoice(), empty);
  assert.strictEqual(parsed.documentRole, 'purchase');
  assert.match(parsed.supplier.name.value, /MATSHWARI/i);
  assert.ok(parsed.warnings.some((w) => w.code === 'own-company-not-configured'),
    'the fallback has to be announced, not silent');
  assert.strictEqual(validation.blocking.some((b) => b.code === 'document-is-sales-invoice'), false,
    'an unconfigured tenant must not have every sales invoice blocked');
});

test('identity: a junk GSTIN in the configuration is ignored, not trusted', () => {
  const profile = identity.fromRequest({ name: 'BLUECHIP COMPUTER SYSTEM', gstin: 'X' });
  assert.deepStrictEqual(profile.gstins, [], 'a one-character GSTIN is not an identifier');
  // …and the name alone still identifies us.
  assert.strictEqual(identity.matchParty({ name: { value: 'BLUECHIP COMPUTER SYSTEM' } }, profile).isOwn, true);
});

test('identity: a GSTIN match beats a mangled name', () => {
  const party = { name: { value: 'BLUECHIP COMPUTR SYSTEM' }, gstin: { value: '27AABCU9603R1ZM' } };
  const m = identity.matchParty(party, OWN_COMPANY);
  assert.strictEqual(m.isOwn, true);
  assert.ok(m.matchedOn.includes('gstin'));
});

test('identity: OCR-damaged name still matches by characters', () => {
  const party = { name: { value: 'BLUECHIP COMPUTR SYSTEM' }, gstin: { value: '' } };
  const m = identity.matchParty(party, OWN_COMPANY);
  assert.strictEqual(m.isOwn, true, `expected a fuzzy name match, score was ${m.score}`);
});

test('identity: a phone number alone identifies us', () => {
  const party = { name: { value: 'Xyz Trading' }, phone: { value: '+91 99049 91114' } };
  const m = identity.matchParty(party, OWN_COMPANY);
  assert.strictEqual(m.isOwn, true);
  assert.ok(m.matchedOn.includes('phone'));
});

test('identity: an unrelated supplier is not us', () => {
  const party = { name: { value: 'MATSHWARI COMPUTER & SERVICES' }, gstin: { value: '24AAECM1234F1Z5' } };
  const m = identity.matchParty(party, OWN_COMPANY);
  assert.strictEqual(m.isOwn, false);
});

test('neither side matching us is reported as undetermined, not guessed', () => {
  cursor = 0;
  const lines = [
    line('Tax Invoice'),
    line('SOME OTHER SUPPLIER PRIVATE LIMITED'),
    line('GSTIN: 27AAECS9876H1ZQ'),
    line('Invoice No: 5'),
    line('Dated: 01-Oct-2026'),
    line('Sl Description of Goods HSN Qty Rate Taxable Value Amount'),
    line('1 Printer 84433140 1 8000.00 8000.00 9440.00'),
    line('Grand Total 9440.00'),
  ];
  const { parsed, validation } = read(lines);
  assert.strictEqual(parsed.documentRole, 'unknown');
  assert.strictEqual(parsed.classification.importable, false);
  const codes = validation.blocking.map((b) => b.code);
  assert.ok(codes.includes('direction-not-determined'), `expected a direction block, got ${codes.join(', ')}`);
});

// ── Report ───────────────────────────────────────────────────────────────────

Promise.all(pending).then(() => {
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  PASS  ${r.name}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${r.name}`);
      console.log(`        ${r.err && r.err.message}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
});