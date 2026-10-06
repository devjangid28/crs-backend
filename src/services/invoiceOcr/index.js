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
const { parseInvoice } = require('./parser');
const validator = require('./validate');
const { valueOf } = validator;
const { confidenceBand, collapseSpaces, round2, cleanLine } = require('./normalize');

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
  phone: 20, email: 191, contactPerson: 150, invoiceNo: 80, remark: 4000,
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
  let text = address;
  if (pincode) {
    text = text.replace(new RegExp(`[,\\s]*\\b${pincode}\\b[,\\s]*`, 'g'), ', ');
  }
  text = text.replace(/\s{2,}/g, ' ').replace(/(,\s*)+,/g, ', ').replace(/[,;\s]+$/, '').trim();
  return { address: fit(text, LIMIT.address), addressConfidence: 1 };
}

const ITEM_NAME_RE = /^(tax\s+)?(sales\s+)?invoice\b/i;

function buildPurchaseDraft(parsed, math, { ownCompany } = {}) {
  const supplier = parsed.supplier || {};
  const pincode = supplier.pincode?.value || null;
  const { address } = splitAddress(supplier.address?.value, pincode);

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
    partyGstin: fit(supplier.gstin?.value, LIMIT.gstin) || '',
    contactPerson: fit(supplier.contactPerson?.value, LIMIT.contactPerson) || '',
    partyAddress: address || '',
    partyCity: fit(supplier.city?.value, LIMIT.city) || '',
    partyState: fit(supplier.state?.value, LIMIT.state) || '',
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
  return draft;
}

/**
 * A short, factual remark — enough to audit where the entry came from without
 * dumping the whole invoice text into the narration box.
 */
function buildRemark(parsed, math) {
  const lines = ['Supplier invoice imported using OCR.'];
  const number = parsed.invoice?.number?.value;
  const date = parsed.invoice?.dateDisplay || parsed.invoice?.date?.value;
  if (number) lines.push(`Invoice No: ${number}`);
  if (date) lines.push(`Invoice Date: ${date}`);
  if (parsed.documentRole === 'sales') {
    lines.push('Note: this document is a sales invoice issued by this company — the supplier has to be confirmed.');
  }
  for (const note of new Set((parsed.items || []).flatMap((i) => i.notes || []))) {
    if (lines.length < 14) lines.push(note);
  }
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
  } = input || {};

  if (!Buffer.isBuffer(buffer)) {
    throw new InvoiceOcrError('invalid-file', 'No invoice file was received.');
  }
  assertSupported(fileName, mimeType, buffer.length);

  const startedAt = Date.now();
  const decoded = await decodeIntoPages(buffer, { fileName, mimeType, onStage, dpi });

  if (onStage) onStage('detecting-structure');
  const parsed = parseInvoice({ pages: decoded.pages, ownCompany });

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

  const validation = validator.buildValidationReport({
    parsed,
    math,
    duplicate,
    serialCheck,
    qualityAssessment: decoded.quality,
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
    documentRole: parsed.documentRole,
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
  InvoiceOcrError,
  MAX_FILE_BYTES,
  ACCEPTED_MIME,
  ACCEPTED_EXT,
  warmUp: ocrEngine.warmUp,
  shutdown: ocrEngine.shutdown,
  engineState: ocrEngine.engineState,
  preprocessAvailable: preprocess.isAvailable,
};