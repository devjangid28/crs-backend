// Runs the parser against the captured REAL OCR of the real invoice and prints
// the field-level table/cell debug the acceptance test needs.
//
//   node scripts/_cellmap.js <artifact.json>

const fs = require('fs');
const { parseInvoice } = require('../src/services/invoiceOcr/parser');
const { segmentCells, flattenLines } = require('../src/services/invoiceOcr/layout');
const identity = require('../src/services/invoiceOcr/companyIdentity');

const artifact = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pages = artifact.pages;
const lines = flattenLines(pages);

const OWN = identity.fromRequest({
  name: 'BLUECHIP COMPUTER SYSTEM',
  gstin: '27AABCU9603R1ZM',
});

const parsed = parseInvoice({ pages, identity: OWN });
const bb = (b) => (b ? `[${Math.round(b.x0)},${Math.round(b.y0)},${Math.round(b.x1)},${Math.round(b.y1)}]` : '—');

console.log('=== FIELD MAP =================================================');
const row = (label, value, region, box) => console.log(
  `${String(label).padEnd(16)} ${String(value ?? '—').slice(0, 42).padEnd(42)} ${String(region || '').padEnd(22)} ${box || ''}`,
);
row('Direction', parsed.documentRole, 'classification');
row('Supplier', parsed.supplier?.name?.value, 'supplier-block');
row('Supplier GSTIN', parsed.supplier?.gstin?.value, 'supplier-block');
row('Supplier City', parsed.supplier?.city?.value, 'supplier-block');
row('Supplier State', parsed.supplier?.state?.value, 'supplier-block');
row('Supplier Pin', parsed.supplier?.pincode?.value, 'supplier-block');
row('Supplier Phone', parsed.supplier?.phone?.value, 'supplier-block');
row('Supplier Email', parsed.supplier?.email?.value, 'supplier-block');
row('Buyer', parsed.buyer?.name?.value, 'buyer-block');
row('Buyer GSTIN', parsed.buyer?.gstin?.value, 'buyer-block');
row('Invoice No', parsed.invoice?.number?.value, 'metadata');
row('Invoice Date', parsed.invoice?.date?.value, 'metadata');
console.log('');

console.log('=== ITEM TABLE COLUMNS ========================================');
const table = parsed.tableDebug || null;
if (table) {
  for (const c of table.columns) {
    console.log(`  ${String(c.key).padEnd(8)} x=[${Math.round(c.x0)},${Math.round(c.x1)}] centre=${Math.round(c.center)} label="${c.label}"`);
  }
  console.log(`  table bbox ${bb(table.bbox)}`);
} else {
  console.log('  (no table debug)');
}
console.log('');

console.log('=== ITEMS =====================================================');
for (const it of parsed.items) {
  const m = it.cells || {};
  console.log(`--- item ${it.lineNo}`);
  row('  SN', it.sn, `row${it.lineNo}/sl`, bb(m.sl));
  row('  Description', it.itemName?.value, `row${it.lineNo}/desc`, bb(m.desc));
  row('  HSN', it.hsnCode?.value, `row${it.lineNo}/hsn`, bb(m.hsn));
  row('  Qty', it.quantity?.value, `row${it.lineNo}/qty`, bb(m.qty));
  row('  Rate', it.unitRate?.value, `row${it.lineNo}/rate`, bb(m.rate));
  row('  Per', it.unit?.value, `row${it.lineNo}/unit`, bb(m.unit));
  row('  Amount', it.lineAmount?.value, `row${it.lineNo}/total`, bb(m.total));
}
console.log('');

console.log('=== TOTALS ====================================================');
row('Taxable', parsed.totals?.taxableValue, 'tax-summary');
row('CGST', parsed.totals?.cgstAmount, 'tax-summary');
row('SGST', parsed.totals?.sgstAmount, 'tax-summary');
row('Grand Total', parsed.totals?.grandTotal, 'totals');
console.log('');

console.log('=== HEADER LINE CELLS ========================================');
for (const l of lines.slice(14, 18)) {
  const cells = segmentCells(l);
  console.log(`y=${Math.round((l.bbox.y0 + l.bbox.y1) / 2)}: ${cells.map((c) => `x0=${Math.round(c.x0)} "${c.text}"`).join(' | ')}`);
}