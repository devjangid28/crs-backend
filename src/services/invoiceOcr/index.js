// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — pipeline
//
//  The whole journey from "here is a photo / PDF of an invoice" to "here is a
//  purchase form the user has to confirm", in the order the steps have to run in:
//
//    input file
//       → decode (PDF text layer, PDF page render, or image)
//       → preprocess + quality check
//       → OCR
//       → structure detection  (parser)
//       → field extraction + normalisation
//       → financial validation
//       → duplicate / serial-inventory checks
//       → confidence review
//       → a purchase draft the existing form can be filled from
//
//  Two things never happen here:
//    · nothing is written to the database — the draft is returned for a person
//      to check and only saved by the ordinary purchase endpoint;
//    · nothing is invented. A field that could not be read comes back blank with
//      an explanation, never with a plausible guess.
//
//  Everything runs on this server. No invoice, image or PDF byte leaves the
//  machine, and nothing calls a paid or third-party API.
// ─────────────────────────────────────────────────────────────────────────────

const preprocess = require('./preprocess');
const ocrEngine = require('./ocrEngine');
const pdfInput = require('./pdf');
const { parseInvoice, INVOICE_NUMBER_LABELS, INVOICE_DATE_LABELS } = require('./parser');
const companyIdentity = require('./companyIdentity');
const validator = require('./validate');
const { valueOf } = validator;
const { findLabeledValue, findLabeledValueInCells, buildColumnBands } = require('./layout');
const sharp = require('sharp');
const { confidenceBand, collapseSpaces, round2, cleanLine, normalizeState, repairGstin, normalizeGstin, field, normalizeDate } = require('./normalize');

const MAX_FILE_BYTES = 25 * 1024 * 1024;                 // 25 MB
const ACCEPTED_MIME = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'application/pdf', 'application/x-pdf',
];
const ACCEPTED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
const MAX_RAW_TEXT_CHARS = 20000;

// The purchase form's columns are narrower than a scanned invoice; anything read
// longer than this is trimmed rather than allowed to fail the save.
const LIMIT = {
  partyName: 200, gstin: 20, address: 2000, city: 100, state: 100, pincode: 10,
  // A phone field legitimately holds more than one number - "9601740014, 8487961404"
  // is 20 characters including the separator - so the old 20-character cap cut the
  // second number off mid-digits and wrote a number that was never printed.
  phone: 64, email: 191, contactPerson: 150, invoiceNo: 80, remark: 4000,
  itemName: 255, hsnCode: 20, serial: 60,
};

const fit = (value, max) => {
  const text = collapseSpaces(value);
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
};

class InvoiceOcrError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function assertSupported(fileName, mimeType, byteLength) {
  const ext = String(fileName || '').toLowerCase().match(/\.[a-z0-9]+$/);
  const suffix = ext ? ext[0] : '';
  const type = String(mimeType || '').toLowerCase().split(';')[0].trim();
  const typeOk = !type || ACCEPTED_MIME.includes(type)
    || (suffix === '.pdf' && type === 'application/octet-stream');
  if (!ACCEPTED_EXT.includes(suffix) || !typeOk) {
    throw new InvoiceOcrError(
      'unsupported-file',
      'Unsupported file format. Please upload JPG, PNG, WEBP or PDF.',
    );
  }
  if (byteLength > MAX_FILE_BYTES) {
    throw new InvoiceOcrError(
      'file-too-large',
      'That file is too large to read. Please upload an invoice under 25 MB.',
    );
  }
  if (!byteLength) {
    throw new InvoiceOcrError('empty-file', 'The selected file is empty.');
  }
}

// ── Decoding ─────────────────────────────────────────────────────────────────

/**
 * Turns the uploaded bytes into positioned pages.
 *
 * A PDF is read for its text layer first, because that text is exact. Only the
 * pages with no usable text are rendered and sent through OCR, and every page is
 * processed either way — an invoice whose items start on page 2 is ordinary.
 */
async function decodeIntoPages(buffer, { fileName, mimeType, onStage, dpi } = {}) {
  const isPdf = pdfInput.isPdf(buffer)
    || /\.pdf$/i.test(String(fileName || ''))
    || String(mimeType || '').toLowerCase().includes('pdf');

  if (isPdf) {
    if (onStage) onStage('reading-pdf');
    const { pages, pageCount } = await pdfInput.extractTextPages(buffer);
    const withText = pages.filter((p) => (p.characterCount || 0) >= pdfInput.MIN_CHARS_FOR_TEXT_LAYER);
    const scanned = pages.filter((p) => (p.characterCount || 0) < pdfInput.MIN_CHARS_FOR_TEXT_LAYER);

    const result = withText.slice();
    if (scanned.length) {
      if (onStage) onStage('rendering-pdf-pages', { total: scanned.length });
      const images = await pdfInput.renderPages(buffer, scanned.map((p) => p.pageNumber), { dpi });
      const prepared = [];
      for (const image of images) {
        const raster = await preprocess.prepareRasterImage(image.buffer, { applyTrim: false });
        prepared.push({ ...image, prepared: raster });
      }
      const recognised = await ocrEngine.recognizePages(
        prepared.map((p) => p.prepared.buffer),
        {
          onProgress: (done, total) => {
            if (onStage) onStage('ocr-pdf-page', { done, total });
          },
        },
      );
      recognised.forEach((page, index) => {
        result.push({
          pageNumber: prepared[index]?.pageNumber ?? page.pageNumber,
          width: prepared[index]?.prepared.width || null,
          height: prepared[index]?.prepared.height || null,
          lines: page.lines,
          text: page.text,
          characterCount: page.text.length,
          source: 'pdf-ocr',
          quality: prepared[index]?.prepared.assessment || null,
        });
      });
    }

    result.sort((a, b) => a.pageNumber - b.pageNumber);
    const ocrPages = result.filter((p) => p.source === 'pdf-ocr');
    return {
      pages: result,
      pageCount,
      textSource: ocrPages.length === result.length
        ? 'pdf-ocr'
        : (ocrPages.length ? 'pdf-mixed' : 'pdf-text'),
      quality: ocrPages.length
        ? { ok: ocrPages.every((p) => (p.quality?.ok ?? true)), issues: ocrPages.flatMap((p) => p.quality?.issues || []) }
        : { ok: true, issues: [] },
      enhanced: ocrPages.some((p) => p.source === 'pdf-ocr'),
    };
  }

  // A single image (camera photo or uploaded picture).
  if (onStage) onStage('preparing-image');
  const prepared = await preprocess.prepareRasterImage(buffer, { applyTrim: true });
  if (onStage) onStage('ocr-image');
  const recognised = await ocrEngine.recognizePages([prepared.buffer], {
    onProgress: (done) => { if (onStage && done === 1) onStage('ocr-image'); },
  });
  const page = recognised[0] || { lines: [], text: '', meanConfidence: 0, computedConfidence: 0 };
  return {
    pages: [{
      pageNumber: 1,
      width: prepared.width,
      height: prepared.height,
      lines: page.lines,
      text: page.text,
      characterCount: page.text.length,
      source: 'image-ocr',
      meanConfidence: page.meanConfidence,
    }],
    pageCount: 1,
    textSource: 'image-ocr',
    quality: prepared.assessment,
    enhanced: prepared.enhanced,
    // The raster this page was read from, kept for a targeted re-read of the
    // header when the invoice number or date was lost at the page-level OCR.
    prepared: { buffer: prepared.buffer, width: prepared.width, height: prepared.height },
  };
}

/**
 * A last, clearly-labelled rescue for the one case that is genuinely safe to
 * infer: a single-item invoice whose rate column could not be read, but whose
 * totals were. There is exactly one line, so the rate is the taxable value
 * divided by the quantity — no allocation guesswork. It is marked as derived so
 * the review step insists on it.
 *
 * Nothing else is ever inferred: with two or more items there is no way to know
 * which line a total belongs to, so the rate stays blank for the user to type.
 */

/**
 * Targeted re-OCR of the header metadata column.
 *
 * The page-level read puts the whole page through Tesseract at one scale, and the
 * tiniest cells on the page — the invoice number and date printed in the header
 * table — come out at a size where OCR routinely drops them. Cropping just the
 * header strip and re-reading it at three times the scale recovers them, exactly
 * like zooming in on the paper. Only ever fills a field the page-level read left
 * empty; it never overwrites a value that was already read.
 */
const HEADER_DATE_TOKEN = /\b(\d{1,2}[-\/]([A-Za-z0-9]{2,8})[-\/]\d{2,4}|\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})\b/i;

function cleanHeaderNumber(text) {
  const candidate = collapseSpaces(text).replace(/^[^\w\/-]+|[^\w\/-]+$/g, '');
  if (!candidate || candidate.length < 2 || candidate.length > 80) return null;
  if (!/\d/.test(candidate)) return null;
  if (HEADER_DATE_TOKEN.test(candidate)) return null;
  if (/^e\s*&\s*oe$/i.test(candidate)) return null;
  // Plausible invoice numbers on this page are digits with slashes/dashes
  // ("126-27/00790", "12627100790"). Once OCR merges a neighbour letter in
  // ("N1CSI26-27100790") it is beyond repair, and back it out.
  if (!/^[\d][\d\/-]{5,19}$/.test(candidate)) return null;
  return candidate;
}

// OCR reads the month glyph as a digit often enough ("6-0ct-26"): try the
// character-level confusions before giving up on a date token.
function fixMonthToken(token) {
  if (/^[A-Za-z]+$/.test(token)) return token;
  const map = { '0': 'o', '1': 'l', '2': 'z', '5': 's', '8': 'b' };
  const fixed = [...token].map((c) => map[c] || c).join('');
  return /^[A-Za-z]+$/.test(fixed) ? fixed : token;
}
function tryNormalizeDate(raw) {
  const token = collapseSpaces(raw);
  const normalized = normalizeDate(token);
  if (normalized) return normalized;
  const m = token.match(/(\d{1,2})[-\/]([A-Za-z0-9]+)[-\/](\d{2,4})/);
  if (m) return normalizeDate(`${m[1]}-${fixMonthToken(m[2])}-${m[3]}`);
  return null;
}

async function readHeaderReferenceFields(decoded, parsed) {
  const raw = decoded?.prepared;
  if (!raw || !Buffer.isBuffer(raw.buffer)) return;
  const { width, height } = raw;
  if (!(width > 200 && height > 200)) return;

  const crop = async (left, top, cw, ch, scale) => {
    const safe = (v, min, max) => Math.max(min, Math.min(max, Math.round(v)));
    const region = {
      left: safe(left, 0, width - 1),
      top: safe(top, 0, height - 1),
      width: safe(cw, 10, width - (safe(left, 0, width - 1))),
      height: safe(ch, 10, height - (safe(top, 0, height - 1))),
    };
    const buf = await sharp(raw.buffer)
      .extract(region)
      .resize({
        width: Math.round(region.width * scale),
        height: Math.round(region.height * scale),
        kernel: 'lanczos3',
      })
      .grayscale()
      .toBuffer();
    const page = await ocrEngine.recognizePage(buf);
    return page.lines || [];
  };

  // The right-hand metadata column, read at high scale so the printed rule
  // between "Invoic No." and "Dated" survives and the two cells stay separated
  // ("126-27/00790   6-Oct-26"). A wide header strip backs it up for labels that
  // spilled across the page.
  const rightLines = await crop(width * 0.53, height * 0.06, width * 0.47, height * 0.30, 6);
  const lines = rightLines.length ? rightLines : await crop(0, height * 0.02, width, height * 0.30, 4);
  if (!lines.length) return;

  const numberField = parsed?.invoice?.number;
  const dateField = parsed?.invoice?.date;
  const needNumber = !(numberField && numberField.value);
  const needDate = !(dateField && dateField.value);
  if (!needNumber && !needDate) return;

  const bands = buildColumnBands(lines, { minCells: 2 });
  let numberHit = needNumber ? findLabeledValue(lines, INVOICE_NUMBER_LABELS, { limit: lines.length }) : null;
  if (!numberHit && needNumber) {
    numberHit = findLabeledValueInCells(lines, INVOICE_NUMBER_LABELS, bands, { limit: lines.length });
  }
  let dateHit = needDate ? findLabeledValue(lines, INVOICE_DATE_LABELS, { limit: lines.length }) : null;
  if (!dateHit && needDate) {
    dateHit = findLabeledValueInCells(lines, INVOICE_DATE_LABELS, bands, { limit: lines.length });
  }

  let numberValue = numberHit?.value ? cleanHeaderNumber(numberHit.value) : null;
  let dateValue = null;
  if (dateHit?.value) dateValue = tryNormalizeDate(dateHit.value);

  // Pattern fallback: "…/26-27/00790  6-Oct-26" carries BOTH fields on one
  // printed row, so once the date token is cut out, the rest is the invoice
  // number. This is the shape the page-level OCR most often caught.
  if ((!numberValue || !dateValue)) {
    for (const line of lines) {
      const text = collapseSpaces(line.text || '');
      const filler = text.replace(HEADER_DATE_TOKEN, ' ');
      if (filler !== text && HEADER_DATE_TOKEN.test(text)) {
        if (!dateValue) dateValue = tryNormalizeDate((text.match(HEADER_DATE_TOKEN) || [])[1]);
        if (!numberValue) numberValue = cleanHeaderNumber(filler);
        if (numberValue && dateValue) break;
      }
    }
  }

  if (needDate && dateValue) {
    parsed.invoice.date = field(dateValue.iso, 0.85, 'header-reocr', ['Invoice date was re-read from the header at higher resolution — please verify']);
    parsed.invoice.dateDisplay = dateValue.display;
    if (dateValue.ambiguous) parsed.invoice.date.warnings = [...(parsed.invoice.date.warnings || []), 'Day and month order could not be confirmed — please verify'];
  }
  if (needNumber && numberValue) {
    parsed.invoice.number = field(numberValue, 0.8, 'header-reocr', ['Invoice number was re-read from the header at higher resolution — please verify']);
  }
}
function applyDocumentLevelFallbacks(parsed, math) {
  const items = parsed.items || [];
  if (items.length !== 1) return;
  const item = items[0];
  if (item.unitRate && item.unitRate.value !== null && item.unitRate.value !== undefined) return;

  const quantity = Number(valueOf(item.quantity));
  const taxable = math.summary.taxableValue;
  if (!(quantity > 0) || !(taxable > 0)) return;

  const derived = round2(taxable / quantity);
  item.unitRate = {
    value: derived,
    confidence: 0.55,
    source: 'derived-from-invoice-total',
    band: 'verify',
    warnings: ['Rate was worked out from the invoice total — please verify'],
  };
  item.rateConfidence = 0.55;
  item.warnings = [...(item.warnings || []), 'Rate was worked out from the invoice total — please verify'];
}

// ── Did we actually read the page? ────────────────────────────────────────────

/**
 * Whether the document was read well enough to judge it at all.
 *
 * This has to be decided separately from what the invoice *says*. A blurry phone
 * photo that yields almost no text and a genuine sales invoice are opposite
 * problems, and telling the user "this is not a purchase invoice" about a photo
 * that simply could not be read is worse than saying nothing — it invites them to
 * give up on a purchase they can perfectly well see. So the read is measured, and
 * a failed read is reported as a failed read.
 */
function assessReadHealth({ pages, quality }) {
  const characterCount = (pages || []).reduce((sum, p) => sum + (p.characterCount || (p.text || '').length || 0), 0);
  const lineCount = (pages || []).reduce((sum, p) => sum + ((p.lines || []).length), 0);
  const qualityIssues = (quality && Array.isArray(quality.issues)) ? quality.issues : [];

  // An invoice always prints far more than this. Below it, nothing was read.
  const tooLittleText = characterCount < 120 || lineCount < 3;
  const imageUnreadable = qualityIssues.some((i) => ['blurry', 'blank', 'low-contrast', 'underexposed', 'overexposed'].includes(i.code));

  return {
    ok: !tooLittleText && !imageUnreadable,
    ocrFailed: tooLittleText,
    imageUnreadable,
    characterCount,
    lineCount,
    // Shown to the user as the reason the scan has to be repeated.
    remedies: tooLittleText || imageUnreadable ? [
      'Retake the photograph, with the whole invoice inside the frame',
      'Keep the camera straight and parallel to the page',
      'Use good, even lighting and avoid shadows across the page',
      'Or upload the invoice as a PDF instead',
    ] : [],
  };
}

// ── Draft mapping ────────────────────────────────────────────────────────────

const withBand = (f) => ({
  value: f?.value ?? null,
  confidence: Number(f?.confidence || 0),
  band: confidenceBand(f?.confidence || 0),
  source: f?.source || '',
  warnings: f?.warnings || [],
});

/**
 * Removes a pincode from the address text once it has its own field, so the
 * printed address is not repeated twice on the purchase.
 */
function splitAddress(address, pincode) {
  if (!address) return { address: null, addressConfidence: 0 };
  // The pincode is kept in the address. It is printed there ("ALKAPURI,
  // VADODARA-390007") and is also offered on its own in the Pincode field; the
  // two are the same printed text, and stripping it left the address ending in a
  // stray hyphen because the invoice glued city and pincode together.
  let text = address;
  if (pincode) {
    text = text.replace(new RegExp(`\\b${pincode}\\b`, 'g'), pincode);
  }
  text = text.replace(/\s{2,}/g, ' ').replace(/(,\s*)+,/g, ', ')
    // The pincode was often printed glued to the city by a hyphen
    // ("ALKAPURI,VADODARA-390007"). Removing it leaves the hyphen dangling at the
    // end of the address, so a trailing separator is cleaned up here.
    .replace(/[-\u2013\u2014/]\s*$/, '')
    .replace(/[,;\s-]+$/, '').trim();
  return { address: fit(text, LIMIT.address), addressConfidence: 1 };
}

const ITEM_NAME_RE = /^(tax\s+)?(sales\s+)?invoice\b/i;

function buildPurchaseDraft(parsed, math, { ownCompany } = {}) {
  const supplier = parsed.supplier || {};

  // A document that is not a purchase produces no draft at all.
  //
  // This is the guard that stops "Party Name = Tax Invoice" and its relatives.
  // There is no supplier on a sales invoice, so every supplier field stays empty
  // and the review screen shows the classification instead of a half-filled form
  // the user might save by accident.
  const classification = parsed.classification || null;
  const isPurchase = classification ? classification.importable !== false : parsed.documentRole === 'purchase';

  if (!isPurchase) {
    return {
      // Deliberately empty. Not "Tax Invoice", not the buyer, not blank-but-
      // hopeful: no party is offered for a document that is not a purchase.
      partyName: '', partyGstin: '', contactPerson: '', partyAddress: '',
      partyCity: '', partyState: '', partyPincode: '', partyPhone: '',
      partyEmail: '', invoiceNo: '', invoiceDate: '', items: [],
      notApplicable: true,
      reason: classification?.headline || 'This document is not a purchase invoice.',
    };
  }

  const pincode = supplier.pincode?.value || null;
  const { address } = splitAddress(supplier.address?.value, pincode);

  // OCR commonly mangles a GSTIN into something the structure check rejects.
  // The number is only rewritten when the arithmetic checksum identifies exactly
  // one valid reading of the misread characters - the same number has to be the
  // only one that could have been printed.
  const gstinRepair = supplier.gstin?.value ? repairGstin(supplier.gstin.value) : { value: null, repaired: false };
  const resolvedGstin = gstinRepair.repaired ? gstinRepair.value : supplier.gstin?.value || null;

  const items = (parsed.items || []).map((item) => {
    const rate = item.gstRate?.value ?? math.recommendedRate ?? null;
    let quantity = item.quantity?.value ?? null;
    let quantityWarning = null;
    // purchase_items.quantity is an integer column: a fractional quantity is
    // rounded rather than silently refused, and the user is told about it.
    if (quantity !== null && !Number.isInteger(quantity)) {
      quantityWarning = `Quantity ${quantity} was rounded to ${Math.round(quantity)} — this purchase stores whole units only`;
      quantity = Math.max(1, Math.round(quantity));
    }
    if (quantity === null || quantity < 1) quantity = 1;

    return {
      lineNo: item.lineNo,
      itemName: fit(item.itemName?.value, LIMIT.itemName) || '',
      // HSN stays blank when the invoice did not print one.
      hsnCode: fit(item.hsnCode?.value, LIMIT.hsnCode) || '',
      quantity,
      rate: item.unitRate?.value === null || item.unitRate?.value === undefined ? 0 : round2(item.unitRate.value),
      category: rate ? `${Number(rate)}% GST` : null,
      serials: (item.serials || []).map((s) => fit(s.value, LIMIT.serial)).filter(Boolean),
      notes: item.notes || [],
      warnings: [...(item.warnings || []), quantityWarning].filter(Boolean),
    };
  }).filter((item) => item.itemName);

  const draft = {
    partyName: fit(supplier.name?.value, LIMIT.partyName) || '',
    partyGstin: fit(resolvedGstin, LIMIT.gstin) || '',
    contactPerson: fit(supplier.contactPerson?.value, LIMIT.contactPerson) || '',
    partyAddress: address || '',
    partyCity: fit(supplier.city?.value, LIMIT.city) || '',
    // The printed state name is normalised to its canonical spelling - a state
    // dictionary, matched by resemblance, so "Gujaral" resolves to GUJARAT. An
    // unrecognised name is passed through rather than guessed at.
    partyState: fit(normalizeState(supplier.state?.value || '').value, LIMIT.state) || '',
    partyPincode: fit(pincode, LIMIT.pincode) || '',
    partyPhone: fit(supplier.phone?.value, LIMIT.phone) || '',
    partyEmail: fit(supplier.email?.value, LIMIT.email) || '',
    invoiceNo: fit(parsed.invoice?.number?.value, LIMIT.invoiceNo) || '',
    invoiceDate: parsed.invoice?.date?.value || '',
    items,
  };

  // A sales invoice whose number could not be read leaves the invoice number
  // blank on purpose — filling it with anything else would be an invented value.
  if (math.recommendedRate !== null && math.recommendedRate !== undefined) {
    draft.taxRate = round2(math.recommendedRate);
  }

  // ── The totals the invoice itself printed ──
  //
  // The draft used to carry no totals at all, so the review screen recomputed
  // them from the items and the tax rate. That is only ever a fallback: it
  // silently disagreed with the invoice whenever a rate was unreadable, which is
  // how a printed 2,350.00 / 423.00 / 2,773.00 became 1,200 / 216 / 1,416.
  // Whatever was actually printed on the document is carried through here, and
  // the form uses it in preference to its own arithmetic.
  const printed = parsed.totals || {};
  const printedValue = (key) => (printed[key] && printed[key].value !== undefined ? printed[key].value : null);
  draft.taxableValue = printedValue('taxableValue');
  draft.cgstAmount = printedValue('cgstAmount');
  draft.sgstAmount = printedValue('sgstAmount');
  draft.igstAmount = printedValue('igstAmount');
  draft.gstAmount = printedValue('totalTax');
  draft.grandTotal = printedValue('grandTotal');
  draft.totalQty = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  // A line total is only meaningful per item; it is not part of the item schema
  // the form posts, so it is reported here rather than inside the item.
  draft.amounts = items.map((_, index) => {
    const line = parsed.items?.[index];
    const value = line?.lineAmount?.value;
    return value === null || value === undefined ? null : round2(value);
  });
  return draft;
}

/**
 * A short, factual remark — enough to audit where the entry came from without
 * dumping the whole invoice text into the narration box.
 */
function buildRemark(parsed, math) {
  const classification = parsed.classification || null;
  const role = classification ? classification.role : parsed.documentRole;

  // A document that is not a purchase gets a remark that says so. It must never
  // say "supplier invoice imported".
  if (role !== 'purchase') {
    return fit([
      classification?.headline || 'This document was not imported as a purchase.',
      'No purchase entry was created from this invoice.',
    ].join('\n'), LIMIT.remark);
  }

  const lines = ['Supplier invoice imported using OCR.'];
  const number = parsed.invoice?.number?.value;
  const date = parsed.invoice?.dateDisplay || parsed.invoice?.date?.value;
  if (number) lines.push(`Invoice No: ${number}`);
  if (date) lines.push(`Invoice Date: ${date}`);
  // Product metadata (model, part number, check number, warranty) deliberately
  // stays with the item instead of being dumped into the narration box.
  if (math?.summary?.grandTotal !== null && math?.summary?.grandTotal !== undefined) {
    lines.push(`Invoice total as printed: ${round2(math.summary.grandTotal)}`);
  }
  return fit(lines.join('\n'), LIMIT.remark);
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Reads one invoice and returns everything that was understood.
 *
 * @param {object} input
 * @param {Buffer} input.buffer            the uploaded file
 * @param {string} input.fileName
 * @param {string} input.mimeType
 * @param {object} input.ownCompany        { name, gstin } — who "we" are, used to
 *                                         tell a purchase invoice from our own sales invoice
 * @param {number|string} [input.storeId]
 * @param {boolean} [input.checkDuplicates=true]
 * @param {function} [input.onStage]       progress callback for the processing screen
 */
async function extractInvoice(input) {
  const {
    buffer, fileName = '', mimeType = '', dpi = null,
    ownCompany = {}, storeId = null, checkDuplicates = true, onStage,
    identity = null,
  } = input || {};

  if (!Buffer.isBuffer(buffer)) {
    throw new InvoiceOcrError('invalid-file', 'No invoice file was received.');
  }
  assertSupported(fileName, mimeType, buffer.length);

  const startedAt = Date.now();
  const decoded = await decodeIntoPages(buffer, { fileName, mimeType, onStage, dpi });

  if (onStage) onStage('detecting-structure');
  // The canonical identity is what tells a purchase from one of our own sales.
  // `identity` is resolved by the caller from this tenant's own configuration;
  // without one the parser falls back to the client hint.
  const parsed = parseInvoice({ pages: decoded.pages, ownCompany, identity });

  // The header table is the smallest type on the page, so page-level OCR drops it
  // on low-res photos. A targeted, high-resolution re-read of the header strip
  // recovers an invoice number / date the first pass missed.
  if (onStage) onStage('reading-header');
  if (decoded.pages && decoded.pages.some((p) => (p.source || '').includes('ocr'))) {
    await readHeaderReferenceFields(decoded, parsed);
  }

  if (onStage) onStage('validating');
  const math = validator.validateMath(parsed);
  applyDocumentLevelFallbacks(parsed, math);
  for (const warning of math.issues) {
    // Surface the maths problems as item warnings too, so the review screen can
    // put them next to the line they belong to.
    if (warning.item) {
      const item = (parsed.items || []).find((i) => i.lineNo === warning.item);
      if (item) item.warnings = [...(item.warnings || []), warning.message];
    }
  }

  const repeated = validator.findRepeatedSerials(parsed.items);
  if (repeated.length) {
    parsed.warnings.push({
      code: 'repeated-serials',
      message: `The same serial number was read more than once (${repeated.join(', ')}). Please check it.`,
    });
  }

  if (onStage) onStage('checking-duplicates');
  let duplicate = null;
  let serialCheck = null;
  if (checkDuplicates) {
    try {
      duplicate = await validator.checkDuplicateInvoice({
        partyName: parsed.supplier?.name?.value,
        invoiceNo: parsed.invoice?.number?.value,
        gstin: parsed.supplier?.gstin?.value,
        storeId,
      });
    } catch (err) {
      duplicate = { checked: false, duplicates: [], sameParty: [], otherParty: [], error: err.message };
    }
    try {
      serialCheck = await validator.checkDuplicateSerials({
        serials: validator.allSerials(parsed.items),
        storeId,
      });
    } catch (err) {
      serialCheck = { checked: false, duplicates: [], error: err.message };
    }
  }

  // Read health is measured before anything is concluded about the document, and
  // it decides which of the three states the user is actually looking at.
  const readHealth = assessReadHealth({ pages: decoded.pages, quality: decoded.quality });
  const classification = { ...(parsed.classification || {}) };
  if (readHealth.ocrFailed || readHealth.imageUnreadable) {
    classification.state = 'unreadable';
    classification.ocrFailed = true;
    classification.readable = false;
    classification.remedies = readHealth.remedies;
    classification.headline = readHealth.ocrFailed
      ? 'Could not read this invoice. The image or the OCR result did not contain enough readable text to tell what kind of document this is.'
      : 'This invoice image is not clear enough to read reliably.';
  } else {
    classification.state = classification.importable === false && classification.role === 'sales'
      ? 'sales'
      : (classification.importable ? 'purchase' : 'unknown');
    classification.ocrFailed = false;
    classification.readable = true;
    classification.remedies = [];
  }

  const validation = validator.buildValidationReport({
    parsed,
    math,
    duplicate,
    serialCheck,
    qualityAssessment: decoded.quality,
    readHealth,
  });

  const supplier = parsed.supplier || {};
  const rawText = (decoded.pages || []).map((p) => p.text).join('\n').slice(0, MAX_RAW_TEXT_CHARS);

  return {
    source: {
      fileName,
      fileType: mimeType,
      pageCount: decoded.pageCount,
      pagesProcessed: (decoded.pages || []).length,
      textSource: decoded.textSource,
      enhanced: Boolean(decoded.enhanced),
      ocrEngine: ocrEngine.engineState().LANG === 'eng' ? 'tesseract' : 'ocr',
      processedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      // The file itself is deliberately NOT kept here. It is only written to
      // disk if, and when, the user confirms the purchase and asks for it.
      documentRetained: false,
    },
    quality: decoded.quality,
    readHealth,
    documentRole: parsed.documentRole,
    // The direction decision, in full: which side is us, which signals decided
    // it, and whether this document may be imported at all.
    classification,
    ourRole: parsed.ourRole || null,
    confidence: parsed.confidence,
    supplier: {
      partyName: withBand(supplier.name),
      partyGstin: withBand(supplier.gstin),
      gstinSuggestions: supplier.gstinRepairs || [],
      contactPerson: withBand(supplier.contactPerson),
      partyAddress: {
        value: splitAddress(supplier.address?.value, supplier.pincode?.value).address,
        confidence: Number(supplier.address?.confidence || 0),
        band: confidenceBand(supplier.address?.confidence || 0),
        source: supplier.address?.source || '',
        warnings: supplier.address?.warnings || [],
      },
      partyCity: withBand(supplier.city),
      partyState: withBand(supplier.state),
      partyPincode: withBand(supplier.pincode),
      partyPhone: withBand(supplier.phone),
      partyEmail: withBand(supplier.email),
    },
    invoice: {
      number: withBand(parsed.invoice?.number),
      date: withBand(parsed.invoice?.date),
      dateDisplay: parsed.invoice?.dateDisplay || null,
    },
    items: (parsed.items || []).map((item) => ({
      lineNo: item.lineNo,
      itemName: withBand(item.itemName),
      quantity: withBand(item.quantity),
      unitRate: withBand(item.unitRate),
      hsnCode: withBand(item.hsnCode),
      serials: (item.serials || []).map((s) => ({
        ...withBand(s),
        // A serial that looks like a name or a plain word is almost always a
        // mis-read line rather than a device serial.
        looksValid: /\d/.test(String(s.value || '')) && /^[A-Za-z0-9][A-Za-z0-9\-/.]{3,59}$/.test(String(s.value || '')),
      })),
      gstRate: item.gstRate?.value ?? null,
      taxableValue: item.taxableValue?.value ?? null,
      lineAmount: item.lineAmount?.value ?? null,
      notes: item.notes || [],
      // The product's own printed details (model, part number, check number,
      // warranty) stay attached to the item. They belong to the inventory
      // record, not to the purchase narration.
      metadata: item.metadata || {},
      warnings: item.warnings || [],
      confidence: item.confidence,
    })),
    tax: {
      recommendedRate: math.recommendedRate,
      rateSource: math.rateSource,
      taxableValue: math.summary.taxableValue,
      taxAmount: math.summary.taxAmount,
      grandTotal: math.summary.grandTotal,
      cgstRate: parsed.items?.find((i) => i.cgstRate)?.cgstRate?.value ?? null,
      sgstRate: parsed.items?.find((i) => i.sgstRate)?.sgstRate?.value ?? null,
      igstRate: parsed.items?.find((i) => i.igstRate)?.igstRate?.value ?? null,
    },
    payment: parsed.payment || {},
    issuer: parsed.issuer || null,
    buyer: parsed.buyer ? { name: parsed.buyer.name?.value || null, gstin: parsed.buyer.gstin?.value || null } : null,
    tableDetected: Boolean(parsed.tableDetected),
    duplicate,
    serialCheck,
    validation,
    purchaseDraft: buildPurchaseDraft(parsed, math, { ownCompany }),
    remark: buildRemark(parsed, math),
    pages: (decoded.pages || []).map((p) => ({
      pageNumber: p.pageNumber,
      source: p.source,
      characterCount: p.characterCount ?? (p.text || '').length,
      lineCount: (p.lines || []).length,
      meanConfidence: Number(p.meanConfidence || 0),
      preview: (p.text || '').slice(0, 1200),
    })),
    rawText,
    // The recognised text is kept server-side only for the duration of the call;
    // it is returned to the caller only so the user can eyeball what was read.
    textPreview: cleanLine(rawText.slice(0, 400)),
  };
}

module.exports = {
  extractInvoice,
  // Duplicate / serial lookups are exposed on their own so the purchase form can
  // re-check them after the user edits the party or invoice number.
  duplicateCheck: (input) => validator.checkDuplicateInvoice(input),
  serialCheck: (input) => validator.checkDuplicateSerials(input),
  validateMath: validator.validateMath,
  buildValidationReport: validator.buildValidationReport,
  companyIdentity,
  InvoiceOcrError,
  MAX_FILE_BYTES,
  ACCEPTED_MIME,
  ACCEPTED_EXT,
  warmUp: ocrEngine.warmUp,
  shutdown: ocrEngine.shutdown,
  engineState: ocrEngine.engineState,
  preprocessAvailable: preprocess.isAvailable,
};