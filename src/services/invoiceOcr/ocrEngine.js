// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — the OCR engine
//
//  Wraps Tesseract (via tesseract.js, Apache-2.0) so the rest of the pipeline
//  never has to know how text is recognised. Everything runs inside this
//  process: no invoice, image or PDF byte is ever sent to a third party.
//
//  The important part is what comes back. Plain text is not enough for an
//  invoice — every line keeps its position and the confidence of each word, so
//  the parser can rebuild the table columns instead of guessing from a flat
//  string.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const TESSDATA_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'tessdata');
const LANG = 'eng';

// Tesseract is slow enough that a burst of uploads would queue forever. One
// worker handles one page at a time; extra requests wait their turn.
let workerPromise = null;
let queue = Promise.resolve();
let engineState = { ready: false, error: null, localLanguageData: false };

function localLanguageDataAvailable() {
  try {
    return fs.existsSync(path.join(TESSDATA_DIR, `${LANG}.traineddata.gz`))
      || fs.existsSync(path.join(TESSDATA_DIR, `${LANG}.traineddata`));
  } catch (err) {
    return false;
  }
}

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    // eslint-disable-next-line global-require
    const { createWorker, PSM } = require('tesseract.js');
    const local = localLanguageDataAvailable();
    const worker = await createWorker(LANG, 1, {
      // Ship the language data with the server so the first invoice works
      // offline and no document traffic leaves the machine.
      langPath: local ? TESSDATA_DIR : undefined,
      cachePath: local ? TESSDATA_DIR : undefined,
      cacheMethod: local ? 'write' : 'write',
      gzip: true,
      logger: () => {},
      errorHandler: () => {},
    });
    await worker.setParameters({
      // An invoice is a multi-block page — a letterhead, party columns, an item
      // table and a totals block. Automatic segmentation reads all of it;
      // treating the page as one solid block silently drops the company name at
      // the top, which is exactly the field the purchase needs most.
      tessedit_pageseg_mode: PSM.AUTO,
      // Table columns are separated by wide gaps; without this the words inside
      // a column run together and the column geometry is lost.
      preserve_interword_spaces: '1',
    });
    engineState = { ready: true, error: null, localLanguageData: local };
    return worker;
  })().catch((err) => {
    workerPromise = null;
    engineState = { ready: false, error: err.message, localLanguageData: false };
    throw err;
  });
  return workerPromise;
}

/** Warms the engine up so the first user's invoice is not the slowest one. */
async function warmUp() {
  try {
    await getWorker();
    return { ready: engineState.ready, localLanguageData: engineState.localLanguageData };
  } catch (err) {
    return { ready: false, error: err.message };
  }
}

async function shutdown() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch (err) {
    // Nothing useful to do while shutting down.
  }
  engineState = { ready: false, error: null, localLanguageData: localLanguageDataAvailable() };
}

const toLine = (line, pageNumber) => ({
  pageNumber,
  text: String(line.text || '').replace(/\s+$/g, ''),
  confidence: Number(line.confidence || 0),
  bbox: {
    x0: line.bbox?.x0 ?? 0,
    y0: line.bbox?.y0 ?? 0,
    x1: line.bbox?.x1 ?? 0,
    y1: line.bbox?.y1 ?? 0,
  },
  words: (line.words || []).map((w) => ({
    text: String(w.text || ''),
    confidence: Number(w.confidence || 0),
    bbox: {
      x0: w.bbox?.x0 ?? 0,
      y0: w.bbox?.y0 ?? 0,
      x1: w.bbox?.x1 ?? 0,
      y1: w.bbox?.y1 ?? 0,
    },
  })).filter((w) => w.text),
});

/** Flattens Tesseract's block → paragraph → line tree into one page of lines. */
function linesFromData(data) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        if (!line.text || !String(line.text).trim()) continue;
        lines.push(toLine(line, 1));
      }
    }
  }
  // Reading order: top to bottom, then left to right within a row.
  lines.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  return lines;
}

function meanConfidence(lines) {
  const words = lines.flatMap((l) => l.words);
  const pool = words.length ? words : lines;
  if (!pool.length) return 0;
  const total = pool.reduce((sum, w) => sum + (Number(w.confidence) || 0), 0);
  return total / pool.length / 100;
}

/**
 * Recognises one prepared page image.
 * Returns `{ lines, text, meanConfidence, words }` — `lines` carry geometry so
 * the parser can rebuild columns.
 */
async function recognizePage(buffer) {
  const worker = await getWorker();
  const result = await worker.recognize(buffer, {}, { blocks: true, text: true });
  const lines = linesFromData(result.data || {});
  const text = lines.map((l) => l.text).join('\n');
  return {
    lines,
    text,
    meanConfidence: Number((result.data?.confidence || 0)) / 100,
    computedConfidence: Number(meanConfidence(lines).toFixed(4)),
  };
}

/**
 * Recognises several pages one after another. Pages run in sequence because a
 * single Tesseract worker can only hold one job at a time, and because
 * hammering the CPU with parallel OCR makes every page slower.
 *
 * `onProgress` is called with (pageIndex, totalPages) so the UI can say
 * "reading page 2 of 5" instead of freezing.
 */
async function recognizePages(buffers, { onProgress } = {}) {
  const pages = [];
  let index = 0;
  for (const buffer of buffers) {
    index += 1;
    const job = queue.then(() => recognizePage(buffer));
    // Keep the chain alive even when one page fails.
    queue = job.catch(() => null);
    try {
      const result = await job;
      pages.push({
        pageNumber: index,
        lines: result.lines.map((l) => ({ ...l, pageNumber: index })),
        text: result.text,
        meanConfidence: result.meanConfidence,
        computedConfidence: result.computedConfidence,
      });
    } catch (err) {
      pages.push({
        pageNumber: index,
        lines: [],
        text: '',
        meanConfidence: 0,
        computedConfidence: 0,
        error: err.message,
      });
    }
    if (typeof onProgress === 'function') {
      try { onProgress(index, buffers.length); } catch (err) { /* progress is cosmetic */ }
    }
  }
  return pages;
}

module.exports = {
  recognizePage,
  recognizePages,
  warmUp,
  shutdown,
  isEngineLoaded: () => Boolean(workerPromise),
  engineState: () => ({ ...engineState, LANG, tessdataDir: TESSDATA_DIR }),
};