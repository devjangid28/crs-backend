// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — image / PDF page preparation
//
//  A phone photo of an invoice is never ready for OCR: it is tilted, shot at an
//  angle with the desk around it, lit unevenly and often slightly out of focus.
//  This module straightens what it safely can (EXIF rotation, cropping the desk
//  away, contrast, sharpening) and — just as importantly — measures the result
//  so the UI can say "this photo is too blurry" instead of silently returning a
//  half-empty form.
//
//  sharp is used only for pixel work. If it is unavailable or the file is not a
//  raster image at all, everything degrades to "hand the bytes straight to the
//  OCR engine" and the caller is told the image was not enhanced.
// ─────────────────────────────────────────────────────────────────────────────

let sharp = null;
try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
  // Invoice OCR likes a predictable colour space and no lazy surprises.
  if (sharp && typeof sharp.cache === 'function') sharp.cache(false);
} catch (err) {
  sharp = null;
}

// Tesseract reads small text best around 2000–3000px on the long edge. Bigger
// only costs time; smaller loses the serials.
const TARGET_LONG_EDGE = 2400;
const MIN_LONG_EDGE = 1400;

// Enough detail for OCR, small enough that a 20-page PDF does not melt the box.
const RENDER_DPI = 170;
const RENDER_MAX_PIXELS = 4_000_000;

// ── Quality measurement ──────────────────────────────────────────────────────

/**
 * Mean brightness, contrast and edge energy of an image, measured on a small
 * copy so it costs a few milliseconds rather than a second.
 *
 *  - brightness too low / too high   → "the photo is too dark / blown out"
 *  - edge energy too low             → "the photo is blurry"
 *  - ink ratio near zero             → "nothing was captured"
 */
async function measureQuality(buffer) {
  if (!sharp) return null;
  try {
    const { data, info } = await sharp(buffer)
      .rotate()                       // honour EXIF before measuring
      .resize({ width: 480, fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = info.width * info.height;
    if (!pixels) return null;
    let sum = 0;
    let sumSq = 0;
    let dark = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = data[i];
      sum += v;
      sumSq += v * v;
      if (v < 90) dark += 1;
    }
    const mean = sum / pixels;
    const variance = Math.max(0, sumSq / pixels - mean * mean);
    const inkRatio = dark / pixels;

    // Laplacian variance — the classic focus measure. A blurred page has edges
    // smeared across neighbours, so the second derivative collapses.
    const w = info.width;
    let lapSum = 0;
    let lapSq = 0;
    let lapCount = 0;
    for (let y = 1; y < info.height - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
        lapSum += Math.abs(lap);
        lapSq += lap * lap;
        lapCount += 1;
      }
    }
    const lapMean = lapCount ? lapSum / lapCount : 0;
    const lapVariance = lapCount ? Math.max(0, lapSq / lapCount - lapMean * lapMean) : 0;

    return {
      brightness: Number(mean.toFixed(1)),
      contrast: Number(Math.sqrt(variance).toFixed(1)),
      inkRatio: Number(inkRatio.toFixed(4)),
      edgeEnergy: Number(lapVariance.toFixed(1)),
      width: info.width,
      height: info.height,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Turns raw measurements into advice the UI can show verbatim.
 *
 * Thresholds are calibrated against printed invoices, which are mostly white
 * paper: mean brightness sits around 250 and is therefore not on its own a sign
 * of trouble. Judgement is based on how much ink there is, how far the ink goes
 * from the paper, and how sharply the page's edges are defined.
 */
function assessQuality(quality, { minInkRatio = 0.0006 } = {}) {
  const issues = [];
  if (!quality) return { ok: true, issues, metrics: null };

  const add = (code, message) => issues.push({ code, message });

  if (quality.inkRatio < minInkRatio) {
    add('blank', 'This image does not appear to contain a readable document.');
  }
  if (quality.brightness < 110) {
    add('dark', 'The invoice image is too dark. Please retake the photo in better lighting.');
  }
  // Washed out: the paper is pure white and so is the ink.
  if (quality.brightness > 251 && quality.contrast >= 18 && quality.inkRatio < 0.0015) {
    add('overexposed', 'The invoice image is overexposed. Please retake the photo without direct glare.');
  }
  if (quality.contrast > 0 && quality.contrast < 18) {
    add('low-contrast', 'The invoice image has very little contrast. Please retake the photo in better lighting.');
  }
  // Edge energy scales with resolution, so it is only meaningful on the small
  // measuring copy this module always uses (480px wide).
  if (quality.edgeEnergy > 0 && quality.edgeEnergy < 700 && quality.contrast >= 18) {
    add('blurry', 'The invoice image is too blurry to read. Please retake the photo.');
  }

  return { ok: issues.length === 0, issues, metrics: quality };
}

/**
 * Removes the desk/background around a photographed page, when that is safe.
 *
 * sharp's fluent methods mutate the instance they are called on, so the crop is
 * tried on a copy and only adopted when it really is just border removal. A crop
 * that throws away more than a little of the picture is discarded — losing the
 * bottom third of an invoice is far worse than keeping a strip of desk.
 */
async function trimBackground(buffer) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch (err) {
    return buffer;
  }
  if (!meta.width || !meta.height) return buffer;

  try {
    const trimmed = await sharp(buffer).trim({ background: '#ffffff', threshold: 12 }).toBuffer();
    const after = await sharp(trimmed).metadata();
    if (!after.width || !after.height) return buffer;
    const widthKept = after.width / meta.width;
    const heightKept = after.height / meta.height;
    if (widthKept > 0.9 && heightKept > 0.9) {
      return await sharp(trimmed)
        .extend({ top: 4, bottom: 4, left: 4, right: 4, background: '#ffffff' })
        .toBuffer();
    }
  } catch (err) {
    // Leave the picture untouched — trimming is an optimisation, never a must.
  }
  return buffer;
}

/**
 * Prepares one raster page for OCR.
 * Returns `{ buffer, enhanced, quality, assessment, width, height }`; `enhanced`
 * is false when the image could not be improved, in which case `buffer` is the
 * untouched original.
 */
async function prepareRasterImage(input, { applyTrim = true } = {}) {
  const original = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!sharp) {
    return {
      buffer: original,
      enhanced: false,
      reason: 'image-enhancer-unavailable',
      quality: null,
      assessment: { ok: true, issues: [], metrics: null },
      width: null,
      height: null,
    };
  }

  try {
    const meta = await sharp(original, { failOn: 'none', limitInputPixels: 0 }).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);

    let base = sharp(original, { failOn: 'none', limitInputPixels: 0 }).rotate();

    if (longEdge > TARGET_LONG_EDGE) {
      base = base.resize({
        width: meta.width >= meta.height ? TARGET_LONG_EDGE : undefined,
        height: meta.height > meta.width ? TARGET_LONG_EDGE : undefined,
        fit: 'inside',
        withoutEnlargement: true,
      });
    } else if (longEdge && longEdge < MIN_LONG_EDGE) {
      base = base.resize({
        width: meta.width >= meta.height ? MIN_LONG_EDGE : undefined,
        height: meta.height > meta.width ? MIN_LONG_EDGE : undefined,
        fit: 'inside',
      });
    }

    // Straighten, crop and flatten first, then hand over a plain buffer: from
    // here on the pipeline is re-created for every step instead of chained, so
    // no step can quietly alter another's output.
    let staged = await base.flatten({ background: '#ffffff' }).toBuffer();
    if (applyTrim) staged = await trimBackground(staged);

    const buffer = await sharp(staged)
      .greyscale()
      .normalise()                       // stretch contrast across the page
      .sharpen({ sigma: 1.1, m1: 0.6, m2: 2.2 })
      .png({ compressionLevel: 6 })
      .toBuffer();

    const quality = await measureQuality(buffer);
    const assessment = assessQuality(quality);

    const finalMeta = await sharp(buffer).metadata();
    return {
      buffer,
      enhanced: true,
      reason: null,
      quality,
      assessment,
      width: finalMeta.width || null,
      height: finalMeta.height || null,
    };
  } catch (err) {
    return {
      buffer: original,
      enhanced: false,
      reason: 'image-not-processable',
      quality: await measureQuality(original).catch(() => null),
      assessment: { ok: true, issues: [], metrics: null },
      width: null,
      height: null,
    };
  }
}

/**
 * Renders one PDF page to a PNG buffer at a resolution a good camera could
 * match, so a scanned invoice goes through exactly the same OCR path as a photo.
 *
 * The scale is worked out from the page's own dimensions rather than a fixed
 * zoom: A4 has to come out at roughly 2400px on the long edge for the small
 * print of an invoice table to stay readable, while a poster-sized page has to
 * be capped so the render cannot exhaust memory.
 */
async function renderPdfPage(page, { dpi, targetLongEdge = TARGET_LONG_EDGE, maxPixels = RENDER_MAX_PIXELS } = {}) {
  if (!sharp) return null;
  try {
    const viewport = page.getViewport({ scale: 1 });
    const width = viewport.width || 612;
    const height = viewport.height || 792;
    const longEdge = Math.max(width, height);

    let scale = dpi ? dpi / 72 : targetLongEdge / longEdge;
    const pixels = width * scale * height * scale;
    if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);
    scale = Math.max(0.5, scale);

    const zoomed = page.getViewport({ scale });

    // Render straight to a canvas — @napi-rs/canvas is prebuilt, so no native
    // toolchain is needed on the server.
    // eslint-disable-next-line global-require
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(Math.max(1, Math.ceil(zoomed.width)), Math.max(1, Math.ceil(zoomed.height)));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: zoomed }).promise;
    return canvas.toBuffer('image/png');
  } catch (err) {
    return null;
  }
}

const isAvailable = () => Boolean(sharp);

module.exports = {
  isAvailable,
  prepareRasterImage,
  renderPdfPage,
  measureQuality,
  assessQuality,
  TARGET_LONG_EDGE,
  RENDER_DPI,
};