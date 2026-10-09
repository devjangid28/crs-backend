// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — layout helpers
//
//  The single most important thing this module buys the parser is *position*.
//  Reading an invoice top-to-bottom and hoping for the best fails on real
//  invoices: "Invoice No. 29" sits next to "Dated 05-Oct-2026", the buyer's
//  address runs down the left while the supplier's runs down the right, and an
//  item description spills over four lines under three narrow numeric columns.
//
//  So every helper here works on (text + bounding box) lines, and answers
//  questions like "what is printed to the right of this label, on the same
//  visual row" or "which column of the table does this word belong to".
// ─────────────────────────────────────────────────────────────────────────────

const { collapseSpaces, cleanLine, cellNumber, isNumericCell, findPhrase } = require('./normalize');

/**
 * Matches a label definition against a line, exactly or OCR-tolerantly.
 *
 * A label definition is `{ match, phrases? }`. The regular expression is tried
 * first because it is exact and cheap; the word phrases are the fallback for when
 * the OCR dropped or doubled a character ("Bill To" read as "Bl to"), which used
 * to mean the block underneath the label was never opened at all.
 *
 * Returns the same `{ index, length }` a regex match would, or null.
 */
function matchLabel(text, label) {
  const re = label.match instanceof RegExp ? label.match : new RegExp(label.match, 'i');
  const m = String(text || '').match(re);
  if (m) return { index: m.index, length: m[0].length, text: m[0], fuzzy: false };
  if (label.phrases && label.phrases.length) {
    const hit = findPhrase(text, label.phrases, { tolerance: label.tolerance ?? 1, maxWords: label.maxWords ?? 0 });
    if (hit) return { index: hit.index, length: hit.length, text: '', fuzzy: true };
  }
  return null;
}

/** True when any of the labels in the list is present on this line. */
function hasAnyLabel(text, labels) {
  return (labels || []).some((label) => matchLabel(text, label) !== null);
}

/** Flattens every page into one ordered line list, page breaks preserved. */
function flattenLines(pages) {
  const lines = [];
  for (const page of pages || []) {
    for (const line of page.lines || []) {
      lines.push({ ...line, pageNumber: page.pageNumber, source: page.source, pageWidth: page.width, pageHeight: page.height });
    }
  }
  return lines;
}

const lineCenterY = (line) => ((line.bbox?.y0 ?? 0) + (line.bbox?.y1 ?? 0)) / 2;
const lineHeight = (line) => Math.max(1, (line.bbox?.y1 ?? 0) - (line.bbox?.y0 ?? 0));
const lineLeft = (line) => line.bbox?.x0 ?? 0;
const lineRight = (line) => line.bbox?.x1 ?? 0;

/** True when two lines sit on the same visual row. */
function sameRow(a, b, overlap = 0.55) {
  const top = Math.max(a.bbox?.y0 ?? 0, b.bbox?.y0 ?? 0);
  const bottom = Math.min(a.bbox?.y1 ?? 0, b.bbox?.y1 ?? 0);
  if (bottom <= top) return false;
  const shortest = Math.min(lineHeight(a), lineHeight(b));
  return (bottom - top) / shortest >= overlap;
}

/**
 * Text printed to the right of `line` on the same row — how two-column invoice
 * headers actually read ("Invoice No. 29     Dated 05-Oct-2026").
 * `skipText` is the part of this line the label already consumed.
 */
function textToTheRight(lines, index, skipChars = 0) {
  const line = lines[index];
  const collected = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const other = lines[i];
    if (other.pageNumber !== line.pageNumber) break;
    if (lineCenterY(other) > lineCenterY(line) + lineHeight(line)) break;
    if (!sameRow(line, other)) continue;
    if (lineLeft(other) <= lineRight(line) - 2) continue;
    collected.push({ line: other, distance: lineLeft(other) - lineRight(line) });
    if (collected.length >= 3) break;
  }
  collected.sort((a, b) => a.distance - b.distance);
  return collected.length ? collected[0].line : null;
}

// Any label that can follow a value on the same printed line. Invoice headers are
// full of "Invoice No.: 29   Dated: 05-Oct-2026   Mode/Terms of Payment: UPI",
// and reading that as one number gives "29 Dated: 05-Oct-2026 Mode/Terms…".
const NEXT_LABEL_RE = /\s+(?=(?:tax\s+invoice|invoice|inv|bill|date|dated|due|payment|payments|pay|mode|terms|ref|reference|order|po|gstin|gst|ship|consignee|buyer|seller|supplier|vendor|page|amount|qty|qnty|quantity|hsn|sac|rate|taxable|total|discount|bank|account|beneficiary|ifsc|phone|ph|mobile|tel|email|e-mail|web|website|contact|attn|attention|remark|remarks|notes|declaration|signature|for|from|to|value|state|city|pin|pincode)\b)/i;

/** Trims a label's value at the next label printed beside it. */
function cutAtNextLabel(value) {
  const s = String(value || '');
  const m = s.match(NEXT_LABEL_RE);
  return (m ? s.slice(0, m.index) : s).trim();
}

/**
 * Finds a labelled value anywhere in the document.
 *
 * `labels` is a list of `{ key, match, exclude?, priority?, type? }`. A label
 * matches only when the text beside it is not one of its own `exclude` words,
 * which is what keeps "Reference No" and "Buyer's Order No" out of the invoice
 * number.
 *
 * Returns `{ key, raw, lineIndex, line, confidence, source, consumed }`.
 */
function findLabeledValue(lines, labels, { limit = 40, offset = 0 } = {}) {
  const candidates = [];
  const end = Math.min(lines.length, offset + limit);

  for (let i = offset; i < end; i += 1) {
    const line = lines[i];
    const text = cleanLine(line.text);
    if (!text) continue;

    for (const label of labels) {
      const m = matchLabel(text, label);
      if (!m) continue;

      // Only the text immediately beside the label is this label's value.
      const rest = text.slice(m.index + m.length);
      const beside = cutAtNextLabel(rest);
      if (label.exclude && label.exclude.test(beside)) continue;
      if (label.blockedBefore && label.blockedBefore.test(text.slice(0, m.index))) continue;

      let raw = beside.replace(/^\s*[:\-–—.]*\s*/, '').trim();
      let source = 'same-line';
      if (!raw) {
        // The label sits on its own line; the value is on the next line or to
        // the right of it.
        const next = lines[i + 1];
        if (next && next.pageNumber === line.pageNumber && lineCenterY(next) > lineCenterY(line)) {
          raw = cutAtNextLabel(cleanLine(next.text));
          source = 'next-line';
        } else {
          const right = textToTheRight(lines, i);
          if (right) {
            raw = cutAtNextLabel(cleanLine(right.text));
            source = 'same-row-right';
          }
        }
      }
      if (!raw) continue;

      const labelConfidence = (line.confidence || 0) / 100;
      candidates.push({
        key: label.key,
        raw,
        lineIndex: i,
        line,
        source,
        priority: label.priority ?? 0,
        labelConfidence,
        labelText: m.text,
      });
      // Only the first hit per line per label is useful; further matches on the
      // same line are almost always a second field that has its own label.
      break;
    }
  }

  if (!candidates.length) return null;
  // Specific labels beat generic ones; on a tie the earlier (higher on the page)
  // occurrence wins, because an invoice number always lives near the top.
  candidates.sort((a, b) => (b.priority - a.priority)
    || (b.labelConfidence - a.labelConfidence)
    || (a.lineIndex - b.lineIndex));
  return candidates[0];
}

// ── Table columns ────────────────────────────────────────────────────────────

/**
 * Reads a table header line and works out where each column sits.
 *
 * `spec` maps a column key to the words that identify it. The first word that
 * matches a column is taken as that column's anchor; the column is then placed
 * at the centre of that word, so later data cells are assigned to the column
 * whose anchor they sit closest to.
 *
 * Returns `[{ key, center, x0, x1, label }]`, left to right.
 */
function detectColumns(headerLine, spec) {
  const words = headerLine?.words?.length
    ? headerLine.words
    : [{ text: headerLine?.text || '', bbox: headerLine?.bbox || { x0: 0, x1: 0 } }];
  const found = new Map();

  for (const word of words) {
    const text = collapseSpaces(word.text);
    if (!text) continue;
    for (const [key, pattern] of Object.entries(spec)) {
      if (found.has(key)) continue;
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
      if (!re.test(text)) continue;
      const center = ((word.bbox?.x0 ?? 0) + (word.bbox?.x1 ?? 0)) / 2;
      found.set(key, {
        key,
        center,
        x0: word.bbox?.x0 ?? center,
        x1: word.bbox?.x1 ?? center,
        label: text,
      });
    }
  }

  const columns = [...found.values()].sort((a, b) => a.center - b.center);
  // Two anchors can land on the same word ("CGST %" / "SGST %" read as one run).
  // Keep the left-most so the other column can still be found on a later line.
  const deduped = [];
  for (const column of columns) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(previous.center - column.center) < 1) {
      if ((column.x1 - column.x0) > (previous.x1 - previous.x0)) deduped[deduped.length - 1] = column;
      continue;
    }
    deduped.push(column);
  }
  return deduped;
}

// Columns that hold numbers. A word that is plainly not a number never belongs in
// one of these, however close to its centre it happens to fall.
const NUMERIC_COLUMN_KEYS = new Set([
  'qty', 'rate', 'taxable', 'discount', 'total',
  'cgstPct', 'cgstAmt', 'sgstPct', 'sgstAmt', 'igstPct', 'igstAmt', 'utgstPct', 'utgstAmt',
]);

// How far left of its own heading a value may start and still belong to that
// column — about two millimetres, enough for OCR box jitter and nothing more.
const COLUMN_JITTER = 6;

const nearestColumn = (columns, center) => {
  let best = null;
  let bestDistance = Infinity;
  for (const column of columns) {
    const distance = Math.abs(center - column.center);
    if (distance < bestDistance) { bestDistance = distance; best = column; }
  }
  return best;
};

/**
 * Sorts a line's words into the detected columns.
 *
 * A word belongs to the last column whose heading starts at or before it, which
 * is how a table actually lays out: a cell never spills past the start of the
 * column to its right. Choosing the *nearest heading centre* instead fails on
 * exactly the lines this parser cares most about — a long product description
 * or a long list of serial numbers reaches far past the middle of the "Description
 * of Goods" heading, and its tail would end up in the HSN column, quietly
 * dropping serials.
 *
 * Returns `{ key: { text, confidence, words } }` — keys with nothing in them are
 * still present, as an empty bucket, so "this column was empty" stays
 * distinguishable from "there is no such column".
 */
function assignToColumns(line, columns) {
  const buckets = {};
  for (const column of columns) buckets[column.key] = { text: '', confidence: 0, words: [] };
  const textColumns = columns.filter((c) => !NUMERIC_COLUMN_KEYS.has(c.key));
  const ordered = columns.slice().sort((a, b) => a.x0 - b.x0);

  // A word belongs to the last column whose heading starts at or before it.
  // Only a couple of points of slack are allowed, so that a value printed a
  // hair left of its own heading still counts as that column's — but a long
  // description or serial list, which routinely reaches far to the right of a
  // narrow heading, stays in its own column instead of being cut off mid-way.
  const thresholds = ordered.map((column, index) => {
    const previous = ordered[index - 1];
    if (!previous) return column.x0 - COLUMN_JITTER;
    const gap = column.x0 - previous.x0;
    return column.x0 - Math.min(COLUMN_JITTER, Math.max(1, gap * 0.15));
  });

  for (const word of line.words || []) {
    if (!word.text || !word.text.trim()) continue;
    const wordLeft = word.bbox?.x0 ?? 0;
    const center = ((word.bbox?.x0 ?? 0) + (word.bbox?.x1 ?? 0)) / 2;

    // A word belongs to the last column whose range contains it. The ranges are
    // the midpoints between the header anchors, so this cannot leak a value into
    // a neighbouring column the way "the last heading that starts at or before
    // this word" did.
    // ── One word, one owner ──
    //
    // A word is placed by where it is printed and by nothing else. This used to
    // end with a second pass that inspected the word's TEXT and moved it again
    // when it was not numeric: "nos!" was thrown out of the quantity column into
    // HSN, and "1,200.00" - which the comma made non-numeric to that test - was
    // thrown out of rate into unit. Both words were then reported in the wrong
    // cell while the correct cell looked empty.
    //
    // That pass also made ownership depend on reading order rather than on
    // layout, so the same word could land differently on two lines of the same
    // page. Placement is now decided once, from the word's centre, and is final.
    let best = null;
    for (const column of ordered) {
      if (center >= column.x0 && center < column.x1) { best = column; break; }
    }
    // A word whose centre falls in the whitespace between two columns belongs to
    // whichever of them it is nearer.
    if (!best) best = nearestColumn(ordered, center);
    if (!best) continue;

    const bucket = buckets[best.key];
    bucket.words.push(word);
    bucket.text = bucket.text ? `${bucket.text} ${word.text}` : word.text;
    bucket.confidence = bucket.words.length
      ? bucket.words.reduce((sum, w) => sum + (Number(w.confidence) || 0), 0) / bucket.words.length / 100
      : 0;
  }
  return buckets;
}

/** The numeric-looking columns of a row — the signal that a line starts an item. */
function rowHasNumbers(buckets, keys) {
  for (const key of keys) {
    const bucket = buckets[key];
    if (!bucket || !bucket.text) continue;
    if (cellNumber(bucket.text) !== null) return true;
    // A quantity is commonly printed with its unit on the same line - "1 nos",
    // "2 pcs". The cell therefore holds a number AND a word, so the whole cell no
    // longer parses as a number. The count is still what makes this line an item
    // row. OCR also glues the unit to the count with no space ("1NOS", "1NOS|",
    // "2Pcs"), so a token that merely OPENS with a number counts as numeric too.
    if (String(bucket.text).trim().split(/\s+/).some((t) => (
      cellNumber(t) !== null || /^-?\d[\d,]*(?:\.\d+)?/.test(t)
    ))) return true;
  }
  return false;
}

/**
 * Numeric columns are right-aligned in real invoices, so the leftmost of them
 * (usually quantity) is the last one to start. A description continuing onto the
 * next line never reaches into the numeric block.
 */
function looksLikeContinuation(buckets, columns, { numericKeys }) {
  const numeric = columns.filter((c) => numericKeys.includes(c.key));
  if (!numeric.length) return true;
  const firstNumeric = numeric[0];
  for (const key of Object.keys(buckets)) {
    if (key === firstNumeric.key) continue;
    if (buckets[key]?.text) return false;
  }
  return true;
}

/**
 * Splits one printed line into the cells OCR actually saw.
 *
 * This is the fix for the failure mode where an invoice's two columns arrive as
 * one string: "JBR SOLUTIONS     Invoice No.     Dated". The words still carry
 * their true x positions, and the gap between two printed cells is much wider
 * than the gap between two words — so the cells are recovered by measuring the
 * space between consecutive words rather than by guessing a fraction of the page
 * width, which is what used to put the invoice number inside the address.
 *
 * Returns `[{ text, x0, x1, center, words }]`, left to right.
 */
function segmentCells(line) {
  const words = (line.words || [])
    .filter((w) => w && w.text && String(w.text).trim())
    .map((w) => ({
      text: String(w.text),
      x0: w.bbox?.x0 ?? 0,
      x1: w.bbox?.x1 ?? 0,
      confidence: Number(w.confidence || 0),
    }))
    .filter((w) => w.x1 > w.x0)
    .sort((a, b) => a.x0 - b.x0);
  if (!words.length) return [];

  // The width of a typical word on this line is the yardstick for "wide".
  const widths = words.map((w) => w.x1 - w.x0).sort((a, b) => a - b);
  const medianWidth = widths[Math.floor(widths.length / 2)] || 8;
  // A cell boundary is a gap wider than a couple of ordinary word spaces.
  const gapThreshold = Math.max(18, medianWidth * 2.4);

  const cells = [];
  let cell = null;
  let previous = null;
  for (const word of words) {
    if (previous && word.x0 - previous.x1 > gapThreshold) {
      cells.push(cell);
      cell = null;
    }
    if (!cell) {
      cell = { text: '', x0: word.x0, x1: word.x1, words: [] };
    }
    cell.text = cell.text ? `${cell.text} ${word.text}` : word.text;
    cell.x0 = Math.min(cell.x0, word.x0);
    cell.x1 = Math.max(cell.x1, word.x1);
    cell.words.push(word);
    previous = word;
  }
  if (cell) cells.push(cell);
  for (const c of cells) c.center = (c.x0 + c.x1) / 2;
  return cells;
}

/**
 * The page's vertical columns: where values are actually printed.
 *
 * Built by clustering the x-ranges of every cell on the page, so the boundaries
 * come from this document rather than from an assumption that the right-hand
 * column starts at 55% of the width.
 */
function buildColumnBands(lines, { minCells = 3 } = {}) {
  const edges = [];
  for (const line of lines || []) {
    for (const cell of segmentCells(line)) edges.push([cell.x0, cell.x1]);
  }
  if (edges.length < minCells) return [];

  // Sort by left edge and merge ranges that overlap or nearly touch.
  edges.sort((a, b) => a[0] - b[0]);
  const bands = [];
  for (const [x0, x1] of edges) {
    const last = bands[bands.length - 1];
    if (last && x0 <= last[1] + 12) {
      last[0] = Math.min(last[0], x0);
      last[1] = Math.max(last[1], x1);
    } else {
      bands.push([x0, x1]);
    }
  }
  return bands.map(([x0, x1]) => ({ x0, x1, center: (x0 + x1) / 2 }));
}

/**
 * Which column band a cell belongs to.
 *
 * A cell is placed by how much of it lies inside the band, not by demanding that
 * it fit exactly. On a dense page the bands touch and partially overlap once
 * every cell has been merged into them, so an exact-fit test rejected almost
 * every cell and no column could ever be found.
 */
function bandOfCell(cell, bands) {
  if (!bands || !bands.length) return null;
  const width = Math.max(1, cell.x1 - cell.x0);
  let best = null;
  let bestOverlap = 0;
  for (const b of bands) {
    const overlap = Math.min(cell.x1, b.x1) - Math.max(cell.x0, b.x0);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = b; }
  }
  // At least half the cell must sit in that band for the placement to mean
  // anything; otherwise it straddles a gutter and belongs to no single column.
  return bestOverlap >= width * 0.5 ? best : null;
}

// Any cell that is a printed label, whatever field it introduces. A value is
// never one of these.
const REFERENCE_LINE_RE_LITE = /\b(?:doc|docs|note|notes|dated|date|mode|terms|reference|ref|order|dispatch|dispatched|delivery|consignee|invoice|inv|through|destination|code|subject|gstin|total|amount|rate|qty|hsn|serial|part|model|warranty|check|colour|size|mrp)\b/i;

/**
 * How far a value's left edge may sit from its label's and still be the same
 * column. Measured from this page's own typography: a printed cell is much wider
 * than a word, so a value may start well to the right of its label without
 * belonging to a different column, while the neighbouring cell starts a whole
 * column-width away.
 */
function labelColumnTolerance(line) {
  const words = (line.words || []).filter((w) => w && w.bbox && w.bbox.x1 > w.bbox.x0);
  if (words.length < 2) return 60;
  const widths = words.map((w) => w.bbox.x1 - w.bbox.x0).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)] || 8;
  // Gaps between consecutive words on this line are the real cell gutters.
  const sorted = words.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i].bbox.x0 - sorted[i - 1].bbox.x1;
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : median * 2;
  // Half the gutter is the natural split between two adjacent cells.
  return Math.max(median * 1.5, Math.min(medianGap / 2 + median * 2, median * 12));
}

/**
 * Finds the value that belongs to a label, using the page's real columns.
 *
 * Two-column invoice headers are the hard case: the label sits in the right-hand
 * column and its value is printed *underneath* it in that same column, on the
 * next line — not beside it. Slicing the flattened text produced values such as
 * "M-35, PANORAMA COMPLEX, JBR/428/26-27 5-Oct-26" for an invoice number,
 * because the label, the address, the number and the date were all one string.
 *
 * So the label's own cell is located first, and the value is then looked for in
 * the same line's next cell, then in the same column band on the lines below.
 */
function findLabeledValueInCells(lines, labels, bands, { limit = 40, offset = 0, otherLabels = [] } = {}) {
  const candidates = [];
  const end = Math.min(lines.length, offset + limit);

  for (let i = offset; i < end; i += 1) {
    const line = lines[i];
    const cells = segmentCells(line);
    if (!cells.length) continue;

    for (let c = 0; c < cells.length; c += 1) {
      const cell = cells[c];
      for (const label of labels) {
        const hit = matchLabel(cell.text, label);
        if (!hit) continue;
        if (label.exclude && label.exclude.test(cell.text)) continue;

        // The value is the cell beside it…
        let value = cells[c + 1];
        // …but when the cell beside is another heading, the value is printed
        // *underneath* this label in its own column. That is the normal shape of
        // an invoice header: "Invoice No." with the number one row below it.
        const isHeading = (candidate) => candidate
          && [...labels, ...otherLabels].some((other) => matchLabel(candidate.text, other));
        if (!value || isHeading(value)) {
          // Geometry local to this label, not page-wide bands: an invoice header
          // prints its value *underneath* its label in the same column, so the
          // value is the cell below whose left edge lines up with this one. A
          // shared-band model merged this page's cells into bands so wide that no
          // cell could be placed in one, which is why every lookup came back
          // empty and the flattened line was used instead.
          const tol = labelColumnTolerance(lines[i]);
          for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
            const found = segmentCells(lines[j]).find((other) => {
              if (isHeading(other)) return false;
              return Math.abs(other.x0 - cell.x0) <= tol;
            });
            if (found && /\d|[A-Za-z]{3}/.test(found.text)) { value = found; break; }
          }
        }
        if (!value) continue;
        if (isHeading(value)) continue;
        if (REFERENCE_LINE_RE_LITE.test(value.text)) continue;

        candidates.push({
          key: label.key,
          raw: value.text.trim(),
          lineIndex: i,
          line,
          source: c + 1 < cells.length ? 'cell-beside' : 'cell-below',
          priority: label.priority ?? 0,
          labelConfidence: (line.confidence || 0) / 100,
          labelText: cell.text,
          x0: value.x0,
          x1: value.x1,
        });
        break;
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.priority - a.priority) || (b.labelConfidence - a.labelConfidence));
  return candidates[0];
}

module.exports = {
  flattenLines,
  findLabeledValueInCells,
  segmentCells,
  buildColumnBands,
  bandOfCell,
  matchLabel,
  hasAnyLabel,
  lineCenterY,
  lineHeight,
  lineLeft,
  lineRight,
  sameRow,
  textToTheRight,
  findLabeledValue,
  cutAtNextLabel,
  detectColumns,
  assignToColumns,
  rowHasNumbers,
  looksLikeContinuation,
};