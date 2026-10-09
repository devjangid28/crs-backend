// Captures the real OCR result for the real uploaded invoice and caches it.
//
//   node scripts/_capture.js <file> <out.json>
//
// This is a DEVELOPMENT ARTIFACT, not a substitute for the pipeline: it holds
// exactly what Tesseract produced for the actual file — every word, its
// confidence and its box — so the parser's geometry can be worked on without
// paying for another OCR run on every edit. The end-to-end test always runs the
// live pipeline.

const fs = require('fs');
const path = require('path');
const pdfInput = require('../src/services/invoiceOcr/pdf');
const preprocess = require('../src/services/invoiceOcr/preprocess');
const ocrEngine = require('../src/services/invoiceOcr/ocrEngine');

(async () => {
  const [file, out] = process.argv.slice(2);
  const buffer = fs.readFileSync(file);

  const pages = [];
  const isPdf = /\.pdf$/i.test(file);
  if (isPdf) {
    const images = await pdfInput.renderPages(buffer, [1], { dpi: 200 });
    for (const image of images) {
      const raster = await preprocess.prepareRasterImage(image.buffer, { applyTrim: false });
      const [page] = await ocrEngine.recognizePages([raster.buffer]);
      pages.push({
        pageNumber: image.pageNumber ?? 1,
        width: raster.width,
        height: raster.height,
        source: 'pdf-ocr',
        lines: page.lines,
        text: page.text,
        characterCount: page.text.length,
        meanConfidence: page.meanConfidence,
      });
    }
  } else {
    const raster = await preprocess.prepareRasterImage(buffer, { applyTrim: true });
    const [page] = await ocrEngine.recognizePages([raster.buffer]);
    pages.push({
      pageNumber: 1,
      width: raster.width,
      height: raster.height,
      source: 'image-ocr',
      lines: page.lines,
      text: page.text,
      characterCount: page.text.length,
      meanConfidence: page.meanConfidence,
    });
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    capturedFrom: path.basename(file),
    engine: ocrEngine.engineState(),
    pages,
  }, null, 1));
  const words = pages.reduce((n, p) => n + (p.lines || []).reduce((m, l) => m + (l.words || []).length, 0), 0);
  console.log(`captured ${words} words across ${pages.length} page(s) -> ${out}`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });