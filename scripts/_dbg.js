// Debug: run OCR on an image and dump the parser's view of it.
const fs = require('fs');
const preprocess = require('../src/services/invoiceOcr/preprocess');
const ocrEngine = require('../src/services/invoiceOcr/ocrEngine');
const { parseInvoice } = require('../src/services/invoiceOcr/parser');
const invoiceOcr = require('../src/services/invoiceOcr');

(async () => {
  const file = process.argv[2];
  const buffer = fs.readFileSync(file);
  const prepared = await preprocess.prepareRasterImage(buffer, { applyTrim: true });
  const recognised = await ocrEngine.recognizePages([prepared.buffer]);
  const page = recognised[0];
  const pages = [{
    pageNumber: 1, width: prepared.width, height: prepared.height,
    lines: page.lines, text: page.text, characterCount: page.text.length,
    source: 'image-ocr', meanConfidence: page.meanConfidence,
  }];

  console.log(`=== ${pages[0].width}x${pages[0].height} lines=${page.lines.length} ===`);
  page.lines.forEach((l, i) => {
    const b = l.bbox || {};
    console.log(`${String(i).padStart(3)} x0=${String(Math.round(b.x0 || 0)).padStart(4)} x1=${String(Math.round(b.x1 || 0)).padStart(4)} y=${String(Math.round(b.y0 || 0)).padStart(4)} c=${l.confidence} | ${l.text}`);
  });

  const identity = await invoiceOcr.companyIdentity.buildCompanyIdentity({});
  const parsed = parseInvoice({ pages, identity, ownCompany: {} });
  console.log('\n=== PARSED ===');
  console.log('role', parsed.documentRole, 'ourRole', parsed.ourRole);
  console.log('classification', JSON.stringify({
    sellerName: parsed.classification.sellerName,
    buyerName: parsed.classification.buyerName,
    identity: parsed.classification.identity && {
      sellerMatch: parsed.classification.identity.sellerMatch,
      issuerMatch: parsed.classification.identity.issuerMatch,
      buyerMatch: parsed.classification.identity.buyerMatch,
      decidedBy: parsed.classification.identity.decidedBy,
    },
  }, null, 2));
  console.log('issuer', JSON.stringify(parsed.issuer));
  console.log('buyer', JSON.stringify(parsed.buyer));
  console.log('consignee', JSON.stringify(parsed.consignee));
  console.log('supplier', JSON.stringify(parsed.supplier && parsed.supplier.name));
  console.log('invoice', JSON.stringify(parsed.invoice));
  console.log('tableDetected', parsed.tableDetected, 'tables', parsed.tableCount);
  console.log('items', parsed.items.length);
  for (const it of parsed.items) {
    console.log(`  ${it.lineNo}. ${JSON.stringify(it.itemName.value)} qty=${JSON.stringify(it.quantity.value)} rate=${JSON.stringify(it.unitRate && it.unitRate.value)} hsn=${JSON.stringify(it.hsnCode.value)} line=${JSON.stringify(it.rawRowText)}`);
  }
  console.log('totals', JSON.stringify(Object.fromEntries(Object.entries(parsed.totals || {}).map(([k, v]) => [k, v && v.value]))));
  console.log('tableDebug', JSON.stringify(parsed.tableDebug));
  await ocrEngine.shutdown();
})().catch((e) => { console.error(e); process.exit(1); });
