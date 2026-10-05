const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');

const TEMPLATE_HTML = path.join(__dirname, '..', 'templates', 'photoSheet.html');
const SHEET_WIDTH = 1080;

// JPEG rather than PNG: a PNG of six photos lands around 1.4 MB, which WhatsApp
// re-compresses and blurs. q82 keeps the label text crisp at roughly 300 KB.
const JPEG_QUALITY = 82;

// Two columns of 4:3 tiles stay readable up to six photos. Past that the tiles
// shrink below the point where a customer can judge a crack or a swollen cell,
// so extra photos are dropped rather than silently degrading the whole sheet.
const MAX_PHOTOS = 6;

const DEFAULT_LABELS = [
  'Device overview',
  'Display / panel',
  'Keyboard & touchpad',
  'Base / underside',
  'Ports & connectors',
  'Damage / internals',
];

let browserPromise = null;

// One browser for the whole process. Launching puppeteer per send costs ~1s and
// a new process, which is very noticeable when sending several sheets in a row.
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }).catch((err) => {
      // Do not cache a failed launch; the next attempt should retry.
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch (e) {
    /* already gone */
  }
}

function toFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

// Photo count is capped, so callers should be told what was dropped rather than
// discovering it later from a "sent" message that is missing photos.
//
// Each photo must carry a `path`. Callers that stage uploads under a different
// key silently produce an empty sheet, so both cases are reported distinctly
// here rather than collapsing into one opaque "no photos" error.
function selectPhotos(photos) {
  const list = photos || [];
  const noPath = list.filter((p) => !p || !p.path);
  const usable = list.filter((p) => p && p.path && fs.existsSync(p.path));
  return {
    used: usable.slice(0, MAX_PHOTOS),
    dropped: Math.max(0, usable.length - MAX_PHOTOS),
    missing: list.length - usable.length,
    noPathCount: noPath.length,
    totalSupplied: list.length,
  };
}

/**
 * Merge several repair photos into one labelled grid image.
 *
 * Resolves to { filePath, fileName, usedCount, droppedCount } or throws. The
 * caller is responsible for uploading the result to WhatsApp.
 */
async function renderPhotoSheet({ photos, meta = {}, outDir }) {
  const { used, dropped, missing, noPathCount, totalSupplied } = selectPhotos(photos);
  if (used.length === 0) {
    const err = new Error(
      noPathCount > 0
        ? `No readable photos were provided for the photo sheet: ${noPathCount} of ${totalSupplied} entries had no \`path\`. ` +
          'Each photo object needs a `path` pointing at the file on disk.'
        : totalSupplied === 0
          ? 'No photos were provided for the photo sheet'
          : `No readable photos were provided for the photo sheet: none of the ${totalSupplied} file paths exist on disk`
    );
    err.code = 'NO_PHOTOS';
    throw err;
  }

  if (!fs.existsSync(TEMPLATE_HTML)) {
    const err = new Error('Photo sheet template is missing at ' + TEMPLATE_HTML);
    err.code = 'TEMPLATE_MISSING';
    throw err;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const fileName = 'photosheet_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '.jpg';
  const filePath = path.join(outDir, fileName);

  const payload = {
    photos: used.map((p, i) => ({
      src: toFileUrl(p.path),
      label: p.label || DEFAULT_LABELS[i] || 'Photo ' + (i + 1),
    })),
    meta: {
      customer: meta.customer || 'Customer',
      device: meta.device || 'Device',
      ticket: meta.ticket || '',
      date: meta.date || '',
    },
  };

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: SHEET_WIDTH, height: 1200, deviceScaleFactor: 1 });
    await page.goto(toFileUrl(TEMPLATE_HTML), { waitUntil: 'networkidle2' });

    await page.evaluate((data) => window.renderSheet(data), payload);

    // file:// images resolve fast but still decode asynchronously, so wait for
    // the explicit readiness flag before screenshotting.
    await page.waitForFunction('window.sheetImagesReady()', { timeout: 30000 });

    const painted = await page.evaluate('window.sheetImageCount()');
    if (painted !== used.length) {
      const err = new Error(
        'Only ' + painted + ' of ' + used.length + ' photos could be read for the photo sheet'
      );
      err.code = 'PHOTO_UNREADABLE';
      throw err;
    }

    const sheet = await page.$('.sheet');
    if (!sheet) {
      const err = new Error('Photo sheet layout element was not rendered');
      err.code = 'LAYOUT_MISSING';
      throw err;
    }

    await sheet.screenshot({ path: filePath, type: 'jpeg', quality: JPEG_QUALITY });

    const { size } = fs.statSync(filePath);
    return { filePath, fileName, usedCount: used.length, droppedCount: dropped, missingCount: missing, size };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  renderPhotoSheet,
  closeBrowser,
  MAX_PHOTOS,
  DEFAULT_LABELS,
};