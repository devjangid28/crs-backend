// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — validation layer
//
//  The OCR is an assistant, never the authority. Everything it produced is
//  re-checked here before a single field can reach the purchase form:
//
//    · the tax arithmetic on the invoice is recomputed and compared, allowing
//      for a rupee or two of rounding;
//    · the GST rate the purchase form needs is derived from what the invoice
//      actually charged, rather than assumed to be 18%;
//    · a supplier invoice that is already in the database is reported before
//      the user can save it a second time;
//    · a serial number that already exists in stock is reported, because a
//      duplicated serial silently corrupts inventory.
//
//  Nothing here writes to the database.
// ─────────────────────────────────────────────────────────────────────────────

const { round2, diff, collapseSpaces, parseAmount } = require('./normalize');
const { query } = require('../../config/database');

// Invoices round to the rupee, so a couple of paise of difference is normal.
const TOLERANCE = 0.02;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const valueOf = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);

/**
 * Recomputes the invoice's own arithmetic and reports every place the printed
 * numbers disagree. The application's purchase engine remains responsible for
 * the final totals — this only proves the read is sane.
 */
function validateMath(parsed) {
  const issues = [];
  const items = parsed.items || [];

  let sumTaxable = 0;
  let sumTax = 0;
  let sumLineTotal = 0;
  let taxableSeen = false;
  let taxSeen = false;

  for (const item of items) {
    const taxable = isNum(valueOf(item.taxableValue)) ? valueOf(item.taxableValue) : null;
    const lineTax = ['cgstAmount', 'sgstAmount', 'igstAmount']
      .map((k) => (isNum(valueOf(item[k])) ? valueOf(item[k]) : null))
      .filter(isNum)
      .reduce((s, n) => s + n, 0);
    const printedTotal = isNum(valueOf(item.lineAmount)) ? valueOf(item.lineAmount) : null;
    const rate = isNum(valueOf(item.gstRate)) ? valueOf(item.gstRate) : null;

    if (isNum(taxable)) { sumTaxable += taxable; taxableSeen = true; }
    if (lineTax > 0) { sumTax += lineTax; taxSeen = true; }

    // Rate printed on the line vs the rate the money implies.
    if (isNum(taxable) && taxable > 0 && rate && lineTax > 0) {
      const implied = round2((lineTax / taxable) * 100);
      if (Math.abs(implied - rate) > 0.5) {
        issues.push({
          code: 'line-tax-rate-mismatch',
          item: item.lineNo,
          message: `Item ${item.lineNo}: the printed GST rate (${rate}%) does not match the tax charged on that line (${implied}%).`,
        });
      }
    }
    if (isNum(taxable) && lineTax > 0 && printedTotal !== null) {
      if (diff(taxable + lineTax, printedTotal) > TOLERANCE) {
        issues.push({
          code: 'line-total-mismatch',
          item: item.lineNo,
          message: `Item ${item.lineNo}: taxable value plus tax is ${round2(taxable + lineTax)} but the invoice prints ${round2(printedTotal)}.`,
        });
      }
    }
    if (isNum(printedTotal)) sumLineTotal += printedTotal;
  }

  const totals = parsed.totals || {};
  const printedTaxable = isNum(valueOf(totals.taxableValue)) ? valueOf(totals.taxableValue) : null;
  const printedTax = isNum(valueOf(totals.totalTax))
    ? valueOf(totals.totalTax)
    : ['cgstAmount', 'sgstAmount', 'igstAmount']
      .map((k) => (isNum(valueOf(totals[k])) ? valueOf(totals[k]) : null))
      .filter(isNum)
      .reduce((s, n) => s + n, 0) || null;
  const printedGrand = isNum(valueOf(totals.grandTotal))
    ? valueOf(totals.grandTotal)
    : (isNum(valueOf(totals.subtotal)) && isNum(printedTax)
      ? round2(valueOf(totals.subtotal) + printedTax)
      : null);

  if (printedTaxable !== null && taxableSeen && diff(printedTaxable, sumTaxable) > TOLERANCE) {
    issues.push({
      code: 'taxable-value-mismatch',
      message: `Total taxable value on the invoice (${printedTaxable}) does not match the sum of the items (${round2(sumTaxable)}).`,
    });
  }
  if (printedTax !== null && taxSeen && diff(printedTax, sumTax) > TOLERANCE) {
    issues.push({
      code: 'tax-amount-mismatch',
      message: `Total tax on the invoice (${printedTax}) does not match the sum of the item taxes (${round2(sumTax)}).`,
    });
  }
  if (isNum(printedGrand) && printedTaxable !== null && isNum(printedTax)) {
    if (diff(printedGrand, printedTaxable + printedTax) > TOLERANCE) {
      issues.push({
        code: 'invoice-total-mismatch',
        message: `Invoice total of ${printedGrand} does not equal taxable value plus tax (${round2(printedTaxable + printedTax)}).`,
      });
    }
  }

  // ── The GST rate the purchase form should use.
  // Taken from the rate printed on the items when there is one, otherwise derived
  // from the money. Never defaulted to 18%.
  const rateTally = new Map();
  for (const item of items) {
    const rate = valueOf(item.gstRate);
    if (isNum(rate) && rate > 0) rateTally.set(String(rate), (rateTally.get(String(rate)) || 0) + 1);
  }
  let recommendedRate = null;
  let rateSource = null;
  if (rateTally.size) {
    const [rate, count] = [...rateTally.entries()].sort((a, b) => b[1] - a[1])[0];
    recommendedRate = Number(rate);
    rateSource = 'item-tax-columns';
    if (rateTally.size > 1) {
      issues.push({
        code: 'mixed-gst-rates',
        message: `The invoice uses more than one GST rate (${[...rateTally.keys()].sort().join('%, ')}%). The purchase form applies a single rate — please check the items.`,
      });
    }
    if (count !== items.length) {
      issues.push({
        code: 'partial-gst-rates',
        message: 'Only some items carried a readable GST rate. Please check every item.',
      });
    }
  }
  const effectiveTaxable = printedTaxable !== null ? printedTaxable : (taxableSeen ? round2(sumTaxable) : null);
  const effectiveTax = printedTax !== null ? printedTax : (taxSeen ? round2(sumTax) : null);
  if (recommendedRate === null && effectiveTaxable > 0 && effectiveTax > 0) {
    recommendedRate = round2((effectiveTax / effectiveTaxable) * 100);
    rateSource = 'derived-from-amounts';
    const rounded = Math.round(recommendedRate);
    if (recommendedRate >= 0.05 && Math.abs(recommendedRate - rounded) > 0.05) {
      issues.push({
        code: 'unusual-gst-rate',
        message: `The invoice's tax works out to ${recommendedRate}%, which is not a standard GST slab. Please verify.`,
      });
    }
  }
  // Also try deriving from CGST+SGST amounts in the totals block.
  if (recommendedRate === null) {
    const cgst = isNum(valueOf(totals.cgstAmount)) ? valueOf(totals.cgstAmount) : null;
    const sgst = isNum(valueOf(totals.sgstAmount)) ? valueOf(totals.sgstAmount) : null;
    const taxable = effectiveTaxable;
    if (cgst !== null && sgst !== null && taxable > 0) {
      const derivedRate = round2(((cgst + sgst) / taxable) * 100);
      if (derivedRate > 0) {
        recommendedRate = derivedRate;
        rateSource = 'derived-from-cgst-sgst';
      }
    } else if (cgst !== null && taxable > 0) {
      // Only CGST found — double it for the full rate.
      const derivedRate = round2((cgst * 2 / taxable) * 100);
      if (derivedRate > 0) { recommendedRate = derivedRate; rateSource = 'derived-from-cgst'; }
    }
  }
  if (recommendedRate === null && items.length && printedGrand !== null && effectiveTaxable) {
    const derived = round2(((printedGrand - effectiveTaxable) / effectiveTaxable) * 100);
    if (derived > 0) {
      recommendedRate = derived;
      rateSource = 'derived-from-grand-total';
    }
  }

  return {
    issues,
    recommendedRate,
    rateSource,
    summary: {
      taxableValue: effectiveTaxable,
      taxAmount: effectiveTax,
      grandTotal: printedGrand !== null ? printedGrand : (isNum(valueOf(totals.subtotal)) ? valueOf(totals.subtotal) : null),
      sumLineTotal: sumLineTotal ? round2(sumLineTotal) : null,
      totalTaxableFromItems: taxableSeen ? round2(sumTaxable) : null,
      totalTaxFromItems: taxSeen ? round2(sumTax) : null,
    },
  };
}

// ── Duplicates ───────────────────────────────────────────────────────────────

const normKey = (value) => collapseSpaces(value).toLowerCase().replace(/\s+/g, '');

/**
 * Has this supplier invoice already been entered?
 *
 * The natural key is supplier + supplier invoice number. The invoice number is
 * also compared without spaces, because "INV 1025" and "INV-1025" are the same
 * document as far as the user is concerned. An invoice number already used by a
 * different party is reported separately — it is only a hint, not a block.
 */
async function checkDuplicateInvoice({ partyName, invoiceNo, gstin, storeId, excludePurchaseId = null }) {
  const number = collapseSpaces(invoiceNo || '');
  if (!number) return { duplicates: [], sameParty: [], otherParty: [], checked: false };

  const params = [number];
  let sql = `
    SELECT p.id, p.voucher_no, p.purchase_date::text AS purchase_date,
           p.party_name, p.party_gstin, p.invoice_no, p.total_amount
      FROM purchases p
     WHERE TRIM(COALESCE(p.invoice_no, '')) <> ''
       AND (
         LOWER(TRIM(p.invoice_no)) = LOWER($1)
         OR LOWER(REPLACE(TRIM(p.invoice_no), ' ', '')) = LOWER(REPLACE($1, ' ', ''))
       )`;
  if (storeId) { params.push(parseInt(storeId, 10)); sql += ` AND p.store_id = $${params.length}`; }
  if (excludePurchaseId) { params.push(parseInt(excludePurchaseId, 10)); sql += ` AND p.id <> $${params.length}`; }
  sql += ' ORDER BY p.purchase_date DESC, p.id DESC LIMIT 10';

  const result = await query(sql, params);
  const rows = result.rows || [];

  const partyKey = normKey(partyName);
  const gstinKey = normKey(gstin);
  const sameParty = rows.filter((row) => (
    (partyKey && normKey(row.party_name) === partyKey)
    || (gstinKey && normKey(row.party_gstin) === gstinKey)
  ));
  const otherParty = rows.filter((row) => !sameParty.includes(row));

  return {
    checked: true,
    duplicates: rows,
    sameParty,
    otherParty,
    isDuplicate: sameParty.length > 0,
  };
}

/**
 * Serial numbers already present in purchased stock.
 *
 * A serial that is already recorded belongs to a unit that is physically in the
 * shop; entering it twice would put two stock records behind one device, so it
 * has to be looked at before the purchase is saved.
 */
async function checkDuplicateSerials({ serials = [], storeId, excludePurchaseId = null }) {
  const cleaned = [...new Set(serials.map((s) => collapseSpaces(s)).filter((s) => s.length >= 4))];
  if (!cleaned.length) return { checked: false, duplicates: [], serials: cleaned };

  const keys = cleaned.map((s) => s.toUpperCase());
  const params = [keys];
  let sql = `
    SELECT pi.purchase_id, p.voucher_no, p.purchase_date::text AS purchase_date,
           pi.item_name, pi.serials
      FROM purchase_items pi
      JOIN purchases p ON p.id = pi.purchase_id
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(COALESCE(pi.serials, '[]'::jsonb)) AS s
        WHERE UPPER(BTRIM(s)) = ANY($1)
     )`;
  if (storeId) { params.push(parseInt(storeId, 10)); sql += ` AND p.store_id = $${params.length}`; }
  if (excludePurchaseId) { params.push(parseInt(excludePurchaseId, 10)); sql += ` AND p.id <> $${params.length}`; }
  sql += ' LIMIT 200';

  const result = await query(sql, params);
  const duplicates = [];
  const seen = new Set();
  for (const row of result.rows || []) {
    const list = Array.isArray(row.serials) ? row.serials : [];
    for (const value of list) {
      const key = collapseSpaces(value).toUpperCase();
      if (!keys.includes(key) || seen.has(key)) continue;
      seen.add(key);
      duplicates.push({
        serial: collapseSpaces(value),
        purchaseId: row.purchase_id,
        voucherNo: row.voucher_no,
        purchaseDate: row.purchase_date,
        itemName: row.item_name,
      });
    }
  }
  return { checked: true, serials: cleaned, duplicates, isDuplicate: duplicates.length > 0 };
}

/**
 * Final gate before the form is filled in: everything that makes this invoice
 * unsafe to trust without a human, in one list the UI can render verbatim.
 */
function buildValidationReport({ parsed, math, duplicate, serialCheck, qualityAssessment, engineNote, readHealth }) {
  const blocking = [];
  const warnings = [...(parsed.warnings || [])];

  // ── Was the page read at all?
  //
  // This comes first and it is not the same problem as the one below. A document
  // whose text could not be read has told us nothing about its direction, so it
  // must never be reported as "this is not a purchase invoice" — the user would
  // be told their invoice is the wrong kind of document when in fact the camera
  // simply failed.
  const unreadable = Boolean(readHealth && (readHealth.ocrFailed || readHealth.imageUnreadable));

  if (unreadable) {
    blocking.push({
      code: 'ocr-unreadable',
      message: 'Could not read this invoice. The image did not yield enough readable text to identify the document.',
      remedies: readHealth.remedies || [],
    });
  }

  // ── Invoice direction is checked next, before any field is trusted.
  //
  // A sales invoice is not a purchase with a mistake in it — importing one
  // creates a supplier that does not exist and pollutes stock with goods that
  // were never bought. So it blocks rather than warns. The same is true when the
  // direction could not be established, and when this company appears on both
  // sides. Nothing is filled in for the user to "confirm" in those cases,
  // because there is no honest value to confirm.
  const classification = parsed.classification || null;
  const role = classification ? classification.role : parsed.documentRole;

  if (role === 'sales') {
    blocking.push({
      code: 'document-is-sales-invoice',
      message: classification?.headline
        || 'This invoice is issued by this company, so it is a sales invoice and cannot be imported as a purchase.',
      role,
      buyerName: classification?.buyerName || null,
    });
  } else if (role === 'ambiguous') {
    blocking.push({
      code: 'both-sides-look-like-us',
      message: classification?.headline
        || 'This company appears on both sides of this invoice. Please review it before importing.',
      role,
    });
  } else if (role === 'unknown' && !unreadable) {
    // Only meaningful once the page was actually readable. On an unreadable
    // photo the OCR block above is the honest one to show.
    blocking.push({
      code: 'direction-not-determined',
      message: classification?.headline
        || 'It could not be determined whether this company is the buyer or the seller on this invoice.',
      role,
    });
  }

  for (const issue of math.issues) warnings.push({ code: issue.code, message: issue.message });

  if (qualityAssessment && qualityAssessment.issues && qualityAssessment.issues.length) {
    for (const issue of qualityAssessment.issues) {
      warnings.push({ code: `image-${issue.code}`, message: issue.message });
    }
    if (qualityAssessment.issues.some((i) => ['blurry', 'blank', 'low-contrast'].includes(i.code))) {
      blocking.push({
        code: 'image-quality',
        message: 'The invoice image is not clear enough to read reliably. Please retake the photo or upload a clearer file.',
      });
    }
  }

  if (engineNote) warnings.push({ code: 'engine', message: engineNote });

  // When the direction is not "purchase" the direction message above is the one
  // the user has to act on. Reporting a missing supplier or missing items on top
  // of it would just be noise about a document that is not a purchase at all.
  const isPurchase = role === 'purchase';

  if (!parsed.supplier || !parsed.supplier.name.value) {
    if (isPurchase) {
      blocking.push({
        code: 'supplier-missing',
        message: 'The supplier could not be identified from this invoice. Please select or type the party manually.',
      });
    } else {
      warnings.push({
        code: 'supplier-not-applicable',
        message: 'No supplier was read, because this document is not a purchase invoice.',
      });
    }
  }
  if (!parsed.items.length) {
    if (isPurchase) {
      blocking.push({
        code: 'items-missing',
        message: 'No items could be read from this invoice. Please add the items manually.',
      });
    }
  }
  if (!parsed.invoice.number.value) {
    warnings.push({ code: 'invoice-number-missing', message: 'The supplier invoice number could not be read. Please enter it manually.' });
  }
  if (!parsed.invoice.date.value) {
    warnings.push({ code: 'invoice-date-missing', message: 'The supplier invoice date could not be read. Please enter it manually.' });
  }

  if (duplicate && duplicate.isDuplicate) {
    warnings.push({
      code: 'possible-duplicate-invoice',
      message: 'This supplier invoice number already exists in an earlier purchase.',
    });
  }
  if (serialCheck && serialCheck.isDuplicate) {
    warnings.push({
      code: 'duplicate-serials',
      message: `${serialCheck.duplicates.length} serial number(s) already exist in purchased stock.`,
    });
  }

  // How many individual fields still need a human eye.
  const reviewFields = [];
  const bandOf = (f) => (f && confidenceOf(f) >= 0.85 ? null : true);
  const supplierName = parsed.supplier?.name;
  if (bandOf(supplierName)) reviewFields.push('supplier_name');
  if (bandOf(parsed.invoice.number)) reviewFields.push('invoice_number');
  if (bandOf(parsed.invoice.date)) reviewFields.push('invoice_date');
  if (bandOf(parsed.supplier?.gstin)) reviewFields.push('supplier_gstin');
  for (const item of parsed.items) {
    if (bandOf(item.itemName)) reviewFields.push(`item_${item.lineNo}_name`);
    if (bandOf(item.quantity)) reviewFields.push(`item_${item.lineNo}_quantity`);
    if (bandOf(item.unitRate)) reviewFields.push(`item_${item.lineNo}_rate`);
    (item.serials || []).forEach((serial, index) => {
      if (bandOf(serial)) reviewFields.push(`item_${item.lineNo}_serial_${index}`);
    });
  }

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    reviewFields: [...new Set(reviewFields)],
    reviewCount: new Set(reviewFields).size,
  };
}

function confidenceOf(f) {
  return typeof f === 'number' ? f : (f && typeof f === 'object' ? Number(f.confidence) || 0 : 0);
}

/** All serials in the document, de-duplicated, for the inventory check. */
function allSerials(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    for (const serial of item.serials || []) {
      const value = collapseSpaces(valueOf(serial));
      if (!value) continue;
      const key = value.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

/** Serial numbers read twice for the same document — a classic OCR repeat. */
function findRepeatedSerials(items) {
  const tally = new Map();
  for (const item of items || []) {
    for (const serial of item.serials || []) {
      const value = collapseSpaces(valueOf(serial));
      if (!value) continue;
      tally.set(value.toUpperCase(), (tally.get(value.toUpperCase()) || 0) + 1);
    }
  }
  return [...tally.entries()].filter(([, count]) => count > 1).map(([serial]) => serial);
}

/** A one-line description of the invoice, for the review screen. */
function summarize(parsed, math) {
  const supplier = parsed.supplier?.name?.value || null;
  const items = (parsed.items || []).length;
  const quantity = (parsed.items || []).reduce((sum, i) => sum + (Number(valueOf(i.quantity)) || 0), 0);
  const total = math?.summary?.grandTotal ?? null;
  return { supplier, items, quantity, total };
}

module.exports = {
  TOLERANCE,
  validateMath,
  checkDuplicateInvoice,
  checkDuplicateSerials,
  buildValidationReport,
  allSerials,
  findRepeatedSerials,
  summarize,
  valueOf,
};