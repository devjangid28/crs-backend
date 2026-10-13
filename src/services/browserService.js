const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

/**
 * Resolves a Chromium binary that can ACTUALLY be launched on this machine and
 * hands it to Puppeteer.
 *
 * Why this exists:
 * Every PDF in the system (inward receipt, service invoice, order form,
 * quotation, booking challan, Tally order invoice, photo sheet) is rendered by
 * Puppeteer. Puppeteer downloads its own Chrome into the user profile, but that
 * download is not always executable: Windows Application Control (WDAC / Smart
 * App Control / an AV "block at launch" policy) rejects the binary while it is
 * still perfectly present on disk. `fs.existsSync` says yes, and the launch
 * then dies with `spawn UNKNOWN`, which surfaces to staff as an HTTP 500 and,
 * worse, makes the automatic invoice send on a Completed ticket disappear
 * silently.
 *
 * So a file existing proves nothing. This module probes candidates by really
 * launching them and falls through to the next one until one works. System
 * browsers (Microsoft Edge, Google Chrome) are vendor-signed and are therefore
 * allowed by Application Control, which makes them a reliable fallback.
 *
 * The winning executable is cached per process so this costs one probe per
 * server start, not one per PDF.
 */

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
];

// How long a "no browser works" result is remembered before the candidates are
// probed again. Keeps a temporarily locked/updated machine from permanently
// disabling PDFs, without re-probing on every request.
const FAILURE_TTL_MS = 60 * 1000;

const PROBE_TIMEOUT_MS = 30 * 1000;
const LAUNCH_TIMEOUT_MS = 60 * 1000;

let cachedExecutable = null;
let cachedIsExplicit = false;
let lastFailure = null;
let inflight = null;

function envOverrides() {
  return [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    process.env.PUPPETEER_CHROME_EXECUTABLE_PATH,
  ].filter((p) => typeof p === 'string' && p.trim());
}

// chrome-headless-shell ships next to the bundled Chrome in the same puppeteer
// cache folder and is a useful second attempt: some policies allow it while
// blocking the full browser.
function bundledHeadlessShell() {
  const roots = [];
  if (process.env.PUPPETEER_CACHE_DIR) roots.push(process.env.PUPPETEER_CACHE_DIR);
  roots.push(path.join(os.homedir(), '.cache', 'puppeteer'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'puppeteer'));

  for (const root of roots) {
    const base = path.join(root, 'chrome-headless-shell');
    if (!fs.existsSync(base)) continue;
    let versions = [];
    try { versions = fs.readdirSync(base); } catch { versions = []; }
    // Newest version last-sorted first: the newest is the one puppeteer would
    // use, and is the most likely to still be compatible.
    versions.sort().reverse();
    for (const v of versions) {
const p = path.join(
        base, v,
        process.platform === 'win32' ? 'chrome-headless-shell-win64' : '',
        process.platform === 'win32' ? 'chrome-headless-shell.exe'
          : process.platform === 'darwin' ? 'chrome-headless-shell'
            : 'chrome-headless-shell',
      );
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function systemBrowsers() {
  const out = [];
  const add = (p) => { if (p) out.push(p); };

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

    // Bundled Chrome is listed first by the caller, so system Chrome goes next
    // and Edge last: Chrome keeps rendering identical to the PDFs we produced
    // before, Edge is the broadly-allowed safety net.
    add(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    add(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    add(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));

    add(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    add(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    add(path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('/Applications/Chromium.app/Contents/MacOS/Chromium');
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    add('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary');
  } else {
    add('/usr/bin/google-chrome');
    add('/usr/bin/google-chrome-stable');
    add('/opt/google/chrome/chrome');
    add('/usr/bin/chromium');
    add('/usr/bin/chromium-browser');
    add('/snap/bin/chromium');
    add('/usr/bin/microsoft-edge');
    add('/usr/bin/microsoft-edge-stable');
  }
  return out;
}

// puppeteer.executablePath() returns a string in some versions and a Promise in
// others, so normalise both.
async function bundledExecutable() {
  try {
    const p = await puppeteer.executablePath();
    return typeof p === 'string' && p.trim() ? p : null;
  } catch {
    // Puppeteer could not resolve a download - fine, other candidates remain.
    return null;
  }
}

async function buildCandidates() {
  const explicit = envOverrides();
  const bundled = await bundledExecutable();
  const shell = bundledHeadlessShell();

  const all = [...explicit, bundled, shell, ...systemBrowsers()];
  const seen = new Set();
  return all.filter((p) => {
    if (!p) return false;
    const key = path.normalize(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function probe(executablePath) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: LAUNCH_ARGS,
      timeout: PROBE_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }
}

async function resolveExecutable() {
  if (cachedExecutable) return cachedExecutable;
  if (lastFailure && Date.now() - lastFailure.at < FAILURE_TTL_MS) throw lastFailure.error;

  const candidates = await buildCandidates();
  const failures = [];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      failures.push(`${candidate} -> not installed`);
      continue;
    }
    const result = await probe(candidate);
    if (result.ok) {
      cachedExecutable = candidate;
      cachedIsExplicit = envOverrides().includes(candidate);
      lastFailure = null;
      const via = envOverrides().includes(candidate) ? ' (explicit configuration)' : '';
      console.log(`[browserService] Using Chromium: ${candidate}${via}`);
      return candidate;
    }
    failures.push(`${candidate} -> ${result.error}`);
  }

  const error = new Error(
    'No usable Chromium browser found for PDF generation. Tried: '
    + (failures.length ? failures.join(' | ') : 'no candidates')
    + '. If the message mentions an Application Control / antivirus policy, install '
    + 'Google Chrome or Microsoft Edge, or set PUPPETEER_EXECUTABLE_PATH to an allowed browser.'
  );
  lastFailure = { at: Date.now(), error };
  cachedExecutable = null;
  throw error;
}

function clearCache() {
  cachedExecutable = null;
  lastFailure = null;
  inflight = null;
}

/**
 * Launches a browser for PDF/HTML rendering.
 *
 * `headless` is accepted for call-site compatibility but every caller wants
 * headless rendering; the resolved executable is the important part.
 */
async function launchBrowser(options = {}) {
  const launchOpts = {
    headless: true,
    args: LAUNCH_ARGS,
    timeout: LAUNCH_TIMEOUT_MS,
    ...options,
  };

  // An explicit per-call executablePath still has to work; fall back to the
  // resolver when it does not, so a stale hardcoded path cannot break PDFs.
  if (launchOpts.executablePath) {
    try {
      return await puppeteer.launch(launchOpts);
    } catch (err) {
      console.error('[browserService] Caller-supplied executablePath failed, falling back:', err.message);
      delete launchOpts.executablePath;
      if (cachedExecutable === options.executablePath) clearCache();
    }
  }

  if (inflight) return inflight;

  inflight = (async () => {
    const executablePath = await resolveExecutable();
    try {
      return await puppeteer.launch({ ...launchOpts, executablePath });
    } catch (err) {
      // A browser that worked at probe time can still fail later (update,
      // crash, lock). Re-resolve once before giving up.
      if (!cachedIsExplicit) {
        console.error('[browserService] Launch failed after successful probe, re-resolving:', err.message);
        clearCache();
        const retryPath = await resolveExecutable();
        return await puppeteer.launch({ ...launchOpts, executablePath: retryPath });
      }
      throw err;
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Runs `fn` with a browser and always closes it, even when `fn` throws. */
async function withBrowser(fn) {
  const browser = await launchBrowser();
  try {
    return await fn(browser);
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

module.exports = {
  launchBrowser,
  withBrowser,
  clearCache,
  buildCandidates,
  LAUNCH_ARGS,
};