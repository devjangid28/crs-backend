// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — PDF input
//
//  A supplier invoice arrives as a PDF more often than as a photo, and a PDF is
//  the one input that may already contain real text. So a PDF is read twice if
//  it has to be:
//
//    1. the selectable text layer, which is exact and carries coordinates;
//    2. otherwise each page is rendered to an image and sent through the same
//       OCR path as a camera photo.
//
//  Every page is handled — an invoice whose items start on page 2 is normal, not
//  an edge case. pdf.js (Apache-2.0) is used throughout; nothing is uploaded.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');

const preprocess = require('./preprocess');

// pdf.js needs to be told where its bundled data files live, otherwise the
// standard fonts (Helvetica, Times…) cannot be loaded and a rendered page comes
// out blank. Everything is read from the installed package — nothing is fetched.
const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'));
const STANDARD_FONT_DIR = path.join(PDFJS_ROOT, 'standard_fonts');
const CMAP_DIR = path.join(PDFJS_ROOT, 'cmaps');

// A page with fewer characters than this is treated as a scan, not real text.
// A genuine invoice page always prints well over this.
const MIN_CHARS_FOR_TEXT_LAYER = 40;
// Hard stop so a 300-page document cannot tie up the server.
const MAX_PDF_PAGES = 20;

let pdfjsPromise = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    // The legacy build is the one that runs without a DOM.
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch((err) => {
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

async function openDocument(buffer) {
  const pdfjs = await loadPdfjs();
  // pdf.js wants a plain Uint8Array (a Node Buffer is rejected), and it takes
  // ownership of the bytes it is handed, so this is a fresh copy.
  const data = new Uint8Array(buffer);
  return pdfjs.getDocument({
    data,
    isEvalSupported: false,
    // Without these a page whose text is drawn with a base-14 font (Helvetica,
    // Times, Courier) renders as an empty sheet of paper.
    standardFontDataUrl: STANDARD_FONT_DIR + path.sep,
    cMapUrl: CMAP_DIR + path.sep,
    cMapPacked: true,
    verbosity: 0,
  }).promise;
}

// pdf.js reports the position and width of a text run, not of each word inside
// it. Splitting a run into words needs a width per character; splitting the run's
// width evenly by character count would collapse a long product description into
// a few points and put its words in the wrong columns. These are ordinary
// Helvetica metrics in em units — close enough to place a word on the right side
// of a column, which is all the parser needs.
const CHAR_WIDTH_EM = (() => {
  const narrow = "iljtfIr.,;:'`|!()[]{}-";
  const wide = 'mwMW@';
  const upper = 'ABCDEFGHJKLNOPQRSTUVXYZ0123456789';
  const table = {};
  for (const c of narrow) table[c] = 0.28;
  for (const c of wide) table[c] = 0.85;
  for (const c of upper) table[c] = 0.6;
  table[' '] = 0.28;
  return table;
})();

const textWidthEm = (value) => {
  let total = 0;
  for (const c of String(value || '')) total += CHAR_WIDTH_EM[c] ?? 0.52;
  return total;
};

/**
 * Turns pdf.js text items into the same line/word shape the OCR engine
 * produces, so the parser does not care where the text came from.
 *
 * pdf.js coordinates start at the bottom-left with y growing upwards; they are
 * flipped here so every downstream coordinate is "x right, y down" like the OCR
 * output.
 */
function linesFromTextItems(items, pageNumber, pageHeight) {
  const placed = [];
  for (const item of items || []) {
    const str = String(item.str || '');
    if (!str || !str.trim()) continue;
    const x = item.transform?.[4] ?? 0;
    const baselineY = item.transform?.[5] ?? 0;
    const fontHeight = Math.abs(item.transform?.[3] ?? 0) || Math.abs(item.height ?? 0) || 10;
    const width = item.width || str.length * fontHeight * 0.5;
    placed.push({
      text: str,
      x0: x,
      x1: x + width,
      // Flip: distance from the top of the page down to this baseline.
      top: pageHeight - baselineY,
      bottom: pageHeight - baselineY + fontHeight,
    });
  }

  placed.sort((a, b) => (a.top - b.top) || (a.x0 - b.x0));

  // Group into rows. pdf.js splits a line at every font change, so runs of items
  // whose baselines sit within half a line height belong to the same row.
  const rows = [];
  for (const item of placed) {
    const row = rows[rows.length - 1];
    const tolerance = Math.max(3, (item.bottom - item.top) * 0.6);
    if (row && Math.abs(row.top - item.top) <= tolerance) {
      row.items.push(item);
      row.top = (row.top * (row.items.length - 1) + item.top) / row.items.length;
      row.bottom = Math.max(row.bottom, item.bottom);
    } else {
      rows.push({ top: item.top, bottom: item.bottom, items: [item] });
    }
  }

  return rows.map((row) => {
    const sorted = row.items.slice().sort((a, b) => a.x0 - b.x0);
    let text = '';
    let previousEnd = null;
    const words = [];
    for (const item of sorted) {
      // Re-insert the space that splitting on font changes removed.
      const needsSpace = previousEnd !== null && item.x0 - previousEnd > 1.5;
      text += text ? (needsSpace && !text.endsWith(' ') ? ` ${item.text}` : item.text) : item.text;

      const runWidth = item.x1 - item.x0;
      const tokens = item.text.split(/\s+/).filter(Boolean);
      if (tokens.length > 1) {
        const totalEm = tokens.reduce((sum, token) => sum + textWidthEm(token), 0) || 1;
        let cursor = 0;
        for (const token of tokens) {
          const tokenWidth = (textWidthEm(token) / totalEm) * runWidth;
          words.push({
            text: token,
            // A real text layer is not a guess: 0.99, with a small haircut so a
            // vector PDF never outranks a word Tesseract was unsure about.
            confidence: 0.99,
            bbox: { x0: item.x0 + cursor, y0: row.top, x1: item.x0 + cursor + tokenWidth, y1: row.bottom },
          });
          cursor += tokenWidth;
        }
      } else {
        words.push({
          text: item.text,
          confidence: 0.99,
          bbox: { x0: item.x0, y0: row.top, x1: item.x1, y1: row.bottom },
        });
      }
      previousEnd = item.x1;
    }
    return {
      pageNumber,
      text: text.replace(/\s+/g, ' ').trim(),
      // A text layer is exact; 0.99 leaves room for a glyph the font mapped oddly.
      confidence: 99,
      bbox: {
        x0: Math.min(...sorted.map((i) => i.x0)),
        y0: row.top,
        x1: Math.max(...sorted.map((i) => i.x1)),
        y1: row.bottom,
      },
      words,
    };
  }).filter((line) => line.text);
}

/** Reads every page's selectable text, with coordinates. */
async function extractTextPages(buffer, { maxPages = MAX_PDF_PAGES } = {}) {
  const document_ = await openDocument(buffer);
  const pageCount = Math.min(document_.numPages, maxPages);
  const pages = [];
  for (let n = 1; n <= pageCount; n += 1) {
    const page = await document_.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = linesFromTextItems(content.items, n, viewport.height);
    pages.push({
      pageNumber: n,
      width: viewport.width,
      height: viewport.height,
      lines,
      text: lines.map((l) => l.text).join('\n'),
      characterCount: lines.reduce((sum, l) => sum + l.text.length, 0),
      source: 'pdf-text',
    });
    page.cleanup();
  }
  await document_.destroy();
  return { pages, pageCount: document_.numPages };
}

/** Renders pages to PNG images for the pages that have no usable text layer. */
async function renderPages(buffer, pageNumbers, { dpi } = {}) {
  const document_ = await openDocument(buffer);
  const images = [];
  for (const n of pageNumbers) {
    if (n > document_.numPages) continue;
    const page = await document_.getPage(n);
    const png = await preprocess.renderPdfPage(page, { scale: dpi ? dpi / preprocess.RENDER_DPI : undefined });
    page.cleanup();
    if (png) images.push({ pageNumber: n, buffer: png });
  }
  await document_.destroy();
  return images;
}

/** Page count without decoding the whole file. */
async function pageCount(buffer) {
  const document_ = await openDocument(buffer);
  const count = document_.numPages;
  await document_.destroy();
  return count;
}

const isPdf = (buffer) => Buffer.isBuffer(buffer) && buffer.length > 4
  && buffer.slice(0, 5).toString('latin1') === '%PDF-';

module.exports = {
  isPdf,
  extractTextPages,
  renderPages,
  pageCount,
  linesFromTextItems,
  MAX_PDF_PAGES,
  MIN_CHARS_FOR_TEXT_LAYER,
};