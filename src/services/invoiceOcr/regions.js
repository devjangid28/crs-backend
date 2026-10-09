// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — document regions
//
//  Every field is read from inside a region of the page. That single rule is what
//  stops a company's own address from collecting the invoice metadata printed
//  beside it: on this document the supplier's address and the invoice's "Invoice
//  No. / Dated" grid sit on the same rows, and reading line by line merges them.
//
//  The regions are found from the OCR's own geometry — where the wide gap
//  between printed columns is, and where the item table's header begins — rather
//  than from fractions of the page width.
// ─────────────────────────────────────────────────────────────────────────────

const { segmentCells, lineCenterY } = require('./layout');

/** The wide gap inside a header row is the gutter between two printed columns. */
function columnGutter(cells, medianWordWidth) {
  let best = null;
  for (let i = 0; i < cells.length - 1; i += 1) {
    const gap = cells[i + 1].x0 - cells[i].x1;
    if (gap < Math.max(20, medianWordWidth * 2)) continue;
    if (!best || gap > best.width) best = { at: (cells[i].x1 + cells[i + 1].x0) / 2, width: gap };
  }
  return best;
}

/**
 * Where the left-hand party column ends and the right-hand metadata grid begins.
 *
 * Taken as the most common gutter position across the header rows, so one odd row
 * cannot move it. On an invoice with no second column there is no gutter and this
 * returns the page width, which puts every header row in the party region — the
 * correct answer for that layout.
 */
function findColumnDivider(headerLines) {
  const samples = [];
  for (const line of headerLines) {
    const words = (line.words || []).filter((w) => w && w.bbox && w.bbox.x1 > w.bbox.x0);
    if (words.length < 2) continue;
    const widths = words.map((w) => w.bbox.x1 - w.bbox.x0).sort((a, b) => a - b);
    const medianWordWidth = widths[Math.floor(widths.length / 2)] || 8;
    const gutter = columnGutter(segmentCells(line), medianWordWidth);
    if (gutter) samples.push(gutter.at);
  }
  if (samples.length < 2) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/**
 * Builds the page's regions.
 *
 * `lines` are the positioned OCR lines; `table` is the detected item table (or
 * null). The item table's own header is the strongest landmark on the page, so
 * everything above it is header — the party blocks and the metadata grid — and
 * everything below it is tax and totals.
 */
function buildDocumentGeometry(lines, table) {
  const pageWidth = Math.max(...lines.map((l) => l.bbox?.x1 ?? 0), 0);
  const pageHeight = Math.max(...lines.map((l) => l.bbox?.y1 ?? 0), 0);

  const headerLimit = table ? table.headerIndex : lines.length;
  const headerLines = lines.slice(0, headerLimit);
  const divider = findColumnDivider(headerLines);

  // The buyer's block starts at its own heading and runs until the table, which
  // is why it is found separately from the supplier's rather than by "the next
  // line after the previous block".
  //
  // The boundary is the TOP of the heading's own word, not the centre of the
  // line containing it. OCR merges a heading with whatever is printed beside it,
  // so the line's centre sits below the heading and swallowed "Buyer (Bill to)"
  // into the supplier's region — which then leaked the buyer heading into the
  // supplier's postal address.
  const buyerStart = (() => {
    for (let i = 0; i < headerLimit; i += 1) {
      const line = lines[i];
      const text = line.text || '';
      if (!/\b(?:buyer|bill\s*to|consignee|purchaser)\b/i.test(text)) continue;
      if (/order/i.test(text)) continue;
      const heading = (line.words || []).find((w) => /\b(?:buyer|bill\s*to|consignee|purchaser)\b/i.test(w.text || ''));
      return heading ? Math.min(heading.bbox?.y0 ?? lineCenterY(line), lineCenterY(line)) : lineCenterY(line);
    }
    return null;
  })();

  const headerTop = headerLines.length ? lineCenterY(headerLines[0]) - 30 : 0;
  const tableTop = table ? (table.bbox?.y0 ?? lineCenterY(table.headerLine) - 20) : pageHeight;
  const tableBottom = table
    ? (lines.slice(table.headerIndex).reduce((max, l, i) => {
      const text = l.text || '';
      if (!/^\s*(?:cgst|sgst|igst|cess|total|grand\s*total|taxable|round\s*off|amount\s+chargeable)\b/i.test(text)) return max;
      return Math.max(max, lineCenterY(l));
    }, lineCenterY(table.headerLine)) + 40)
    : pageHeight;

  // Where the party column ends. With a metadata grid to the right, that is the
  // gutter; without one, the party block owns the full width.
  const partyRight = divider === null ? pageWidth : divider - 8;
  const metadataLeft = divider === null ? pageWidth : divider + 8;

  return {
    pageWidth,
    pageHeight,
    columnDivider: divider,
    header: { x0: 0, y0: headerTop, x1: pageWidth, y1: tableTop },
    supplier: {
      x0: 0,
      y0: headerTop,
      x1: partyRight,
      y1: buyerStart === null ? tableTop : buyerStart,
    },
    metadata: {
      x0: metadataLeft,
      y0: headerTop,
      x1: pageWidth,
      y1: tableTop,
    },
    buyer: {
      x0: 0,
      y0: buyerStart === null ? tableTop : buyerStart,
      x1: partyRight,
      y1: tableTop,
    },
    itemTable: {
      x0: table?.bbox?.x0 ?? 0,
      y0: tableTop,
      x1: table?.bbox?.x1 ?? pageWidth,
      y1: tableBottom,
    },
    tax: {
      x0: 0,
      y0: tableBottom,
      x1: pageWidth,
      y1: pageHeight,
    },
  };
}

/** True when a line's centre lies inside a region. */
function lineInRegion(line, region) {
  if (!region) return true;
  const center = lineCenterY(line);
  const left = line.bbox?.x0 ?? 0;
  const right = line.bbox?.x1 ?? 0;
  // A line that crosses the gutter belongs to whichever side holds most of it.
  const width = Math.max(1, right - left);
  const insideRight = region.x0 <= region.x1
    && (Math.min(right, region.x1) - Math.max(left, region.x0)) / width >= 0.5;
  return center >= region.y0 && center <= region.y1 && insideRight;
}

/** The lines that lie in a region, in reading order. */
function linesInRegion(lines, region) {
  return (lines || []).filter((line) => lineInRegion(line, region));
}

/** A line's words that fall inside a region's x-range. */
function wordsInRegion(line, region) {
  if (!region) return line.words || [];
  return (line.words || []).filter((w) => {
    const center = ((w.bbox?.x0 ?? 0) + (w.bbox?.x1 ?? 0)) / 2;
    return center >= region.x0 && center <= region.x1;
  });
}

/**
 * Rebuilds each line from only the words that lie inside a region.
 *
 * Scoping by line is not enough: OCR read the supplier's address and the invoice
 * metadata as one line, "M-35, PANORAMA COMPLEX,   JBR/428/26-27   56-Oct-26",
 * because they are printed side by side. The line is mostly the supplier's, so a
 * line-level test lets it through and the invoice number and date arrive inside
 * the address. Only the words actually printed in the region are kept.
 */
function clipLinesToRegion(lines, region) {
  if (!region) return lines || [];
  const out = [];
  for (const line of lines || []) {
    const words = (line.words || []).filter((w) => {
      if (!w || !w.bbox) return false;
      const center = ((w.bbox.x0 ?? 0) + (w.bbox.x1 ?? 0)) / 2;
      return center >= region.x0 && center <= region.x1;
    });
    if (!words.length) continue;
    const text = words.map((w) => w.text).join(' ');
    out.push({ ...line, text, words, clippedTo: 'region' });
  }
  return out;
}

module.exports = {
  buildDocumentGeometry,
  lineInRegion,
  linesInRegion,
  wordsInRegion,
  clipLinesToRegion,
  findColumnDivider,
};