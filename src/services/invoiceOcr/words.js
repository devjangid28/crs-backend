// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — the OCR word
//
//  Everything above this layer used to work in whole OCR *lines*, which is why
//  four different fields ended up inside the supplier's address: a single line
//  like
//
//      "Mo 9601740014,8487961404   GSTIN/VIN: 24FOZPPSBESL1ZP   State Name: Gujarat, Code: 24"
//
//  is three or four printed fields, and assigning the line to "address" assigns
//  all of them to the address.
//
//  A word is the smallest thing OCR actually told us it is sure about, and it
//  carries a position. So a word — not a line — is the unit of ownership: each
//  word is read inside a document region and then claimed by exactly one field.
//
//  Nothing here knows anything about invoices. It only normalises what the OCR
//  engine produced, so every later stage can rely on the same shape.
// ─────────────────────────────────────────────────────────────────────────────

const { cleanLine, collapseSpaces } = require('./normalize');

/**
 * Builds the word list for a document: one entry per OCR token, carrying its
 * position, confidence and the line it came from.
 *
 * `lines` are the positioned lines the OCR engine produced.
 */
function buildWords(lines) {
  const words = [];
  (lines || []).forEach((line, lineIndex) => {
    const list = line.words || [];
    if (!list.length) return;
    list.forEach((word, indexInLine) => {
      const text = collapseSpaces(word.text || '');
      if (!text) return;
      const x0 = Number(word.bbox?.x0 ?? 0);
      const x1 = Number(word.bbox?.x1 ?? 0);
      const y0 = Number(word.bbox?.y0 ?? line.bbox?.y0 ?? 0);
      const y1 = Number(word.bbox?.y1 ?? line.bbox?.y1 ?? 0);
      words.push({
        id: `w${words.length}`,
        text,
        // What the word looks like once punctuation and spacing are irrelevant.
        // Used only for matching a label, never as a stored value.
        normalizedText: text.toLowerCase().replace(/[^a-z0-9]+/g, ''),
        x0: Math.min(x0, x1),
        x1: Math.max(x0, x1),
        y0: Math.min(y0, y1),
        y1: Math.max(y0, y1),
        centerX: (x0 + x1) / 2,
        centerY: (y0 + y1) / 2,
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
        confidence: Number(word.confidence ?? line.confidence ?? 0) / 100,
        lineIndex,
        indexInLine,
        page: line.pageNumber ?? 1,
        lineText: cleanLine(line.text || ''),
      });
    });
  });
  return words;
}

/** The words whose centre lies inside a region — the only ones a field may read. */
function wordsInRegion(words, region) {
  if (!region) return (words || []).map((w) => ({ ...w }));
  return (words || [])
    .filter((w) => w.centerX >= region.x0 && w.centerX <= region.x1
      && w.centerY >= region.y0 && w.centerY <= region.y1)
    .map((w) => ({ ...w }));
}

/** Groups words back into reading order: by row, then left to right. */
function sortWords(words) {
  return (words || []).slice().sort((a, b) => {
    // Same printed row? Then left to right. Otherwise top to bottom.
    const sameRow = Math.abs(a.centerY - b.centerY) < Math.max(a.height, b.height) * 0.6;
    if (sameRow) return a.centerX - b.centerX;
    return a.centerY - b.centerY;
  });
}

/**
 * Splits words into visual rows.
 *
 * A product description occupies three lines but is ONE field, so anything that
 * groups text by line has already lost the structure. Rows are what the item
 * table is actually built from.
 */
function groupIntoRows(words, { tolerance = 0.6 } = {}) {
  const sorted = sortWords(words);
  const rows = [];
  for (const word of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(word.centerY - last.centerY) < Math.max(word.height, last.height) * tolerance) {
      last.words.push(word);
      last.centerY = last.words.reduce((s, w) => s + w.centerY, 0) / last.words.length;
    } else {
      rows.push({ words: [word], centerY: word.centerY });
    }
  }
  for (const row of rows) {
    row.words.sort((a, b) => a.centerX - b.centerX);
    row.text = row.words.map((w) => w.text).join(' ');
    row.x0 = Math.min(...row.words.map((w) => w.x0));
    row.x1 = Math.max(...row.words.map((w) => w.x1));
  }
  return rows;
}

/**
 * Reading order, using the OCR engine's own line grouping.
 *
 * Re-deriving rows from the vertical distance between words does not work: OCR
 * word heights vary wildly within a page, so a threshold derived from them
 * splits one printed line into several and reading order then interleaves the
 * two columns. The engine already decided which words share a line, so that is
 * what is used — and words within a line are ordered left to right.
 */
function orderByLine(words) {
  return (words || []).slice().sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (a.lineIndex !== b.lineIndex) return a.lineIndex - b.lineIndex;
    return a.centerX - b.centerX;
  });
}

/** Words grouped by the OCR line they were printed on, left to right. */
function groupByLine(words) {
  const lines = [];
  let lastIndex = null;
  for (const word of orderByLine(words)) {
    if (word.lineIndex !== lastIndex) {
      lines.push({ lineIndex: word.lineIndex, words: [] });
      lastIndex = word.lineIndex;
    }
    lines[lines.length - 1].words.push(word);
  }
  for (const line of lines) line.text = line.words.map((w) => w.text).join(' ');
  return lines;
}

/**
 * Groups words into the visual rows they were printed on.
 *
 * This is deliberately NOT `groupByLine`. That uses the OCR engine's own line
 * grouping, which is correct for whole lines but wrong here: once a region is
 * clipped, the words that remain belong to the region while their `lineIndex`
 * still describes the original full-width line. Reading by `lineIndex` then joins
 * words the region never contained, which is how "JBR SOLUTIONS" grew
 * "™M-35, PANORAMA COMPLEX".
 *
 * Rows are rebuilt from geometry instead: words whose vertical centres sit within
 * half a line of each other are on the same printed row. The tolerance comes from
 * this page's own word heights, so it adapts to the scan resolution.
 */
function buildVisualRows(words) {
  const sorted = (words || []).slice().sort((a, b) => (a.centerY - b.centerY) || (a.centerX - b.centerX));
  if (!sorted.length) return [];

  const heights = sorted.map((w) => Math.max(1, w.height)).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  // Word boxes are loose; half a median line is a row, a whole line is not.
  const tolerance = Math.max(4, medianHeight * 0.55);

  const rows = [];
  for (const word of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(word.centerY - last.centerY) <= tolerance) {
      last.words.push(word);
      // The row's centre is the mean of its members, so a tall or tall-offset box
      // cannot drag the next row in.
      last.centerY = last.words.reduce((s, w) => s + w.centerY, 0) / last.words.length;
    } else {
      rows.push({ words: [word], centerY: word.centerY });
    }
  }

  for (const row of rows) {
    row.words.sort((a, b) => a.centerX - b.centerX);
    row.text = row.words.map((w) => w.text).join(' ');
    row.minX = Math.min(...row.words.map((w) => w.x0));
    row.maxX = Math.max(...row.words.map((w) => w.x1));
    row.minY = Math.min(...row.words.map((w) => w.y0));
    row.maxY = Math.max(...row.words.map((w) => w.y1));
  }
  return rows;
}

module.exports = {
  buildWords,
  wordsInRegion,
  sortWords,
  orderByLine,
  groupByLine,
  buildVisualRows,
  groupIntoRows,
};