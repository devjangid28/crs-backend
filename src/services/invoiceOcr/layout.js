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

const { collapseSpaces, cleanLine, cellNumber, isNumericCell } = require('./normalize');

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
      const re = label.match instanceof RegExp ? label.match : new RegExp(label.match, 'i');
      const m = text.match(re);
      if (!m) continue;

      // Only the text immediately beside the label is this label's value.
      const rest = text.slice(m.index + m[0].length);
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
        labelText: m[0],
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

    let best = null;
    for (let i = 0; i < ordered.length; i += 1) {
      if (wordLeft >= thresholds[i]) best = ordered[i];
    }
    if (!best) best = nearestColumn(ordered, center);
    if (!best) continue;

    // A long description can spill past its column into a narrow numeric one.
    // Reading "T1N0CV01Z128019" as a rate is exactly the sort of silent,
    // expensive mistake this whole layer exists to prevent, so a word that is
    // not a number is kept out of the numeric columns and given to the nearest
    // text column instead.
    if (NUMERIC_COLUMN_KEYS.has(best.key) && !isNumericCell(word.text)) {
      const alternative = nearestColumn(textColumns, center);
      if (alternative) best = alternative;
    }

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
    if (bucket && bucket.text && cellNumber(bucket.text) !== null) return true;
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

module.exports = {
  flattenLines,
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