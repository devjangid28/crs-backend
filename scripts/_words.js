// Prints every OCR word in a document region with its real position, so a field
// that went wrong can be traced to the words that caused it.
//
//   node scripts/_words.js <artifact.json> [region]
//
// region: supplier | buyer | metadata | itemTable | tax   (default: supplier)

const fs = require('fs');
const { flattenLines } = require('../src/services/invoiceOcr/layout');
const { buildWords, wordsInRegion, groupIntoRows } = require('../src/services/invoiceOcr/words');
const identity = require('../src/services/invoiceOcr/companyIdentity');
const { parseInvoice } = require('../src/services/invoiceOcr/parser');

const artifact = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const which = process.argv[3] || 'supplier';

const lines = flattenLines(artifact.pages);
const words = buildWords(lines);
const parsed = parseInvoice({
  pages: artifact.pages,
  identity: identity.fromRequest({ name: 'BLUECHIP COMPUTER SYSTEM', gstin: '27AABCU9603R1ZM' }),
});
const geometry = parsed.geometry || {};

const page = artifact.pages[0] || {};
console.log(`DOCUMENT  ${page.width} x ${page.height}   words: ${words.length}`);
console.log(`REGIONS`);
for (const key of ['supplier', 'buyer', 'metadata', 'itemTable', 'tax']) {
  const r = geometry[key];
  if (r) console.log(`  ${key.padEnd(10)} x ${String(Math.round(r.x0)).padStart(5)} → ${String(Math.round(r.x1)).padStart(5)}   y ${String(Math.round(r.y0)).padStart(5)} → ${String(Math.round(r.y1)).padStart(5)}`);
}
const region = geometry[which];
if (!region) {
  console.log(`\n(no region "${which}")`);
  process.exit(0);
}
const scoped = wordsInRegion(words, region);
console.log(`\n${which.toUpperCase()} REGION — ${scoped.length} words`);
console.log('row  y     x0    x1   ctrX   text');
for (const row of groupIntoRows(scoped)) {
  for (const w of row.words) {
    console.log(`  ${String(Math.round(w.centerY)).padStart(5)} ${String(Math.round(w.x0)).padStart(5)} ${String(Math.round(w.x1)).padStart(5)} ${String(Math.round(w.centerX)).padStart(6)}   ${JSON.stringify(w.text)}`);
  }
  console.log(`  ${String(Math.round(row.centerY)).padStart(5)} ${''.padStart(5)} ${''.padStart(4)} ${''.padStart(7)}   -- row: ${JSON.stringify(row.text.slice(0, 70))}`);
}
void lines;