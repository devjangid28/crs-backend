// Prints the document regions, item columns, item cells and party fields derived
// from the REAL captured OCR. Sub-second: no Tesseract, no network.
//
//   node scripts/_regions.js <artifact.json>

const fs = require('fs');
const { flattenLines } = require('../src/services/invoiceOcr/layout');
const regions = require('../src/services/invoiceOcr/regions');
const { parseInvoice } = require('../src/services/invoiceOcr/parser');
const identity = require('../src/services/invoiceOcr/companyIdentity');

const artifact = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const lines = flattenLines(artifact.pages);
const parsed = parseInvoice({ pages: artifact.pages, identity: identity.fromRequest({ name: 'BLUECHIP COMPUTER SYSTEM', gstin: '27AABCU9603R1ZM' }) });

const g = parsed.geometry || {};
const R = (n, r) => {
  if (!r) return console.log(`${n.padEnd(18)} (none)`);
  console.log(`${n.padEnd(18)} x ${String(Math.round(r.x0)).padStart(5)} → ${String(Math.round(r.x1)).padStart(5)}   y ${String(Math.round(r.y0)).padStart(5)} → ${String(Math.round(r.y1)).padStart(5)}`);
};
const bb = (b) => (b ? `[${[b.x0, b.y0, b.x1, b.y1].map((v) => Math.round(v)).join(',')}]` : '—');

console.log('DOCUMENT');
console.log(`  page            ${Math.round(g.pageWidth || 0)} x ${Math.round(g.pageHeight || 0)}`);
console.log(`  column divider  ${g.columnDivider === null || g.columnDivider === undefined ? '(none — single column)' : Math.round(g.columnDivider)}`);
console.log('');
console.log('REGIONS');
R('supplier', g.supplier);
R('buyer', g.buyer);
R('invoice metadata', g.metadata);
R('item table', g.itemTable);
R('tax', g.tax);
console.log('');

console.log('ITEM COLUMNS');
const order = ['sl', 'desc', 'hsn', 'qty', 'rate', 'unit', 'total'];
const cols = (parsed.tableDebug?.columns || []).slice().sort((a, b) => a.x0 - b.x0);
for (const c of cols) {
  console.log(`  ${c.key.padEnd(8)} x ${String(Math.round(c.x0)).padStart(5)} → ${String(Math.round(c.x1)).padStart(5)}   centre ${String(Math.round(c.center)).padStart(5)}   "${c.label}"`);
}
const seq = cols.map((c) => c.key);
console.log(`  order: ${seq.join(' < ')}`);
console.log('');

console.log('SUPPLIER FIELDS  (tokens inside supplierRegion only)');
for (const [k, f] of Object.entries(parsed.supplier || {})) {
  if (!f || typeof f !== 'object' || !('value' in f)) continue;
  console.log(`  ${k.padEnd(14)} ${String(f.value ?? '—').slice(0, 46).padEnd(46)} ${bb(f.bbox)}`);
}
console.log('');

console.log('BUYER FIELDS  (tokens inside buyerRegion only)');
for (const [k, f] of Object.entries(parsed.buyer || {})) {
  if (!f || typeof f !== 'object' || !('value' in f)) continue;
  console.log(`  ${k.padEnd(14)} ${String(f.value ?? '—').slice(0, 46).padEnd(46)} ${bb(f.bbox)}`);
}
console.log('');

console.log('INVOICE FIELDS  (metadataRegion only)');
console.log(`  number         ${String(parsed.invoice?.number?.value ?? '—').slice(0, 46).padEnd(46)} ${bb(parsed.invoice?.number?.bbox)}`);
console.log(`  date           ${String(parsed.invoice?.date?.value ?? '—').slice(0, 46).padEnd(46)} ${bb(parsed.invoice?.date?.bbox)}`);
console.log('');

console.log('ITEMS');
for (const it of parsed.items) {
  const cells = it.cellEvidence || {};
  console.log(`  --- row ${it.lineNo}`);
  for (const key of ['sn', 'desc', 'hsn', 'qty', 'rate', 'unit', 'total']) {
    if (!cells[key]) continue;
    console.log(`      ${key.padEnd(6)} ${String(cells[key].text ?? '').slice(0, 40).padEnd(40)} ${bb(cells[key].bbox)}`);
  }
  console.log(`      NAME   ${it.itemName?.value}`);
  console.log(`      HSN    ${it.hsnCode?.value}   QTY ${it.quantity?.value}   RATE ${it.unitRate?.value}   AMT ${it.lineAmount?.value ?? '—'}`);
}
console.log('');

console.log('TOTALS');
for (const [k, v] of Object.entries(parsed.totals || {})) {
  if (v && typeof v === 'object' && 'value' in v) console.log(`  ${k.padEnd(14)} ${v.value}  ${bb(v.bbox)}`);
  else console.log(`  ${k.padEnd(14)} ${v}`);
}
void regions;
void lines;