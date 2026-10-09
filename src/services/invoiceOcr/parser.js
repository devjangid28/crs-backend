// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — invoice structure parser
//
//  Takes positioned text (from a PDF text layer or from OCR) and works out what
//  the invoice actually says. It is deliberately conservative:
//
//    · every value returned carries the text it came from and a confidence;
//    · nothing is returned unless it was actually printed on the document;
//    · roles are resolved before any party is filled in, because on a purchase
//      the supplier is the party that SOLD the goods — which is not always the
//      company whose name is at the top of the page.
//
//  The parser never computes the purchase. It reports what the invoice printed
//  (taxable value, rate, tax, total) and lets the validation layer and the
//  application's own purchase engine do the arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

const {
  CONFIDENCE, field, missing, confidenceBand,
  collapseSpaces, cleanLine, parseAmount, parsePercent, cellNumber, isNumericCell, round2,
  normalizeDate, validateGstin, suggestGstinRepairs, findPhrase,
  findEmail, normalizePhone, looksLikePhone, findPincode, companySimilarity, GST_STATE_CODES,
} = require('./normalize');
const {
  flattenLines, lineCenterY, lineHeight,
  findLabeledValue, findLabeledValueInCells, assignToColumns, rowHasNumbers, sameRow,
  matchLabel, hasAnyLabel, segmentCells, buildColumnBands,
} = require('./layout');
const companyIdentity = require('./companyIdentity');
const { buildDocumentGeometry, clipLinesToRegion } = require('./regions');
const { buildWords, wordsInRegion } = require('./words');
const { claimSupplierFields } = require('./ownership');

// ── Label dictionaries ───────────────────────────────────────────────────────

// Every label also carries the words it is made of, so a mis-read label is still
// found. These are the exact spellings an invoice uses; the fuzzy match exists
// only to survive OCR's dropped characters, never to invent a match.
const INVOICE_NUMBER_LABELS = [
  {
    key: 'invoice_number',
    priority: 5,
    match: /\b(?:tax\s*invoice|invoice|inv|bill)\s*(?:no\.?|number|#)|invoice\s*#/i,
    exclude: /\b(?:order|purchase\s*order|po|ref|reference|voucher|challan|job|delivery|gate|grn|dc)\b/i,
    phrases: [['invoice', 'no'], ['invoice', 'number'], ['inv', 'no'], ['bill', 'no'], ['invoice', 'date']],
    tolerance: 1,
  },
  // A bare "Invoice" heading with the number printed underneath it. Its regex is
  // anchored on purpose — the word "Invoice" also opens "Tax Invoice", and a
  // loose match here read the heading of the document as an invoice-number label
  // and then took the copy marker beside it as the number.
  { key: 'invoice_number', priority: 2, match: /^invoice\s*[:\-]?\s*$/i },
];

// "date" is four letters, and one substitution turns it into "Dale", "Gate",
// "Rate" and "Late" — all of which occur inside addresses and item
// descriptions. A short word is therefore matched exactly; only a multi-word
// phrase, where a dropped letter is unambiguous, is matched loosely.
const INVOICE_DATE_LABELS = [
  { key: 'invoice_date', priority: 5, match: /\b(?:tax\s*invoice\s*date|invoice\s*date|inv\.?\s*date|bill\s*date)\b/i, exclude: /\b(due|payment|order|delivery|dispatch|expiry|period)\b/i, phrases: [['invoice', 'date']], tolerance: 1 },
  { key: 'invoice_date', priority: 4, match: /\bdated\b/i, exclude: /\b(due|payment|order|delivery|dispatch|expiry)\b/i, phrases: [['dated']], tolerance: 0 },
  { key: 'invoice_date', priority: 1, match: /\b(?:date)\b/i, exclude: /\b(due|payment|order|delivery|dispatch|expiry|period|from|to|cheque|chq|utr|neft|rtgs)\b/i, phrases: [['date']], tolerance: 0 },
];

// A buyer heading names the party underneath it. "Buyer" on its own does that —
// but "Buyer's Order No" is a document reference, not a party, and treating it
// as a heading made the words after the apostrophe look like a company name.
// The negative lookahead keeps those two apart.
const SELLER_LABELS = [
  // A bare "From" is only a seller heading when it is written as a label; the
  // word appears mid-sentence far too often ("goods from the supplier").
  {
    key: 'seller',
    match: /\b(?:sold\s*by|seller|supplier|vendor|bill\s*from|supplied\s*by|from)\b\s*:?\s*/i,
    phrases: [['seller'], ['supplier'], ['sold', 'by'], ['vendor'], ['bill', 'from'], ['from']],
    tolerance: 1,
  },
];
const BUYER_LABELS = [
  {
    key: 'buyer',
    match: /\b(?:bill\s*to|ship\s*to|consignee|buyer(?!\s*'?s?\s*order)|customer|purchaser|sold\s*to|delivered\s*to)\b\s*:?\s*/i,
    // "Buyer (Bill To)" is the standard form, and OCR commonly drops a letter
    // from either word. Missing this label is what made a valid purchase invoice
    // report no buyer at all.
    phrases: [['bill', 'to'], ['billed', 'to'], ['buyer'], ['ship', 'to'], ['consignee'], ['customer'], ['purchaser'], ['sold', 'to'], ['delivered', 'to']],
    tolerance: 1,
  },
];

// Document references that merely contain a role word, and must never be read as
// a party block or as a name.
const REFERENCE_LINE_RE = /\b(?:buyer'?s?\s*order|purchase\s*order|sales\s*order|order|reference|ref|delivery\s*note|dispatch|challan|gate\s*no|grn|delivery\s*challan|job\s*no|voucher|quotation\s*no)\s*(?:no\.?|number|#)\b/i;

// Words that only ever appear on a printed *label*. If what is left of a role
// heading contains one of these, the rest of that line is another field of the
// invoice and not the name of the party underneath it — which is what turned
// "Buyer (Bill to)   Dispatch Doc No.   Delivery Note Date" into a company name.
const NAME_RESIDUE_NOISE_RE = /\b(?:doc|docs|note|notes|dated|date|mode|terms|reference|ref|order|dispatch|dispatched|delivery|consignee|printer|printed|page|copy|duplicate|original|invoice|inv|through|destination|code|subject|email|phone|tel|gstin)\b/i;

const PHONE_LABELS = [
  { key: 'phone', match: /\b(?:ph(?:one)?|mob(?:ile)?|tel(?:ephone)?|contact\s*(?:no\.?|number)|mobile\s*no\.?)\b\s*[:\-.]?\s*/i },
];
const EMAIL_LABELS = [
  { key: 'email', match: /\b(?:e-?mail|email\s*id|mail)\b\s*[:\-.]?\s*/i },
];
const CONTACT_PERSON_LABELS = [
  { key: 'contact_person', match: /\b(?:contact\s*person|attn|attention|contact\s*name|prop(?:rietor)?|proprietor|partner)\b\s*[:\-.]?\s*/i },
  // "For <company>" is the signatory's company, not a person.
  { key: 'contact_person', match: /\bfor\b\s*[:\-.]?\s*/i, exclude: /\b(pvt|ltd|llp|inc|company|enterprises|systems|solutions|store|shop|dealer|traders|industries|co\b)\b/i },
];

// Labels that end a party block — anything from here on belongs to something else.
const BLOCK_STOP_WORDS = /\b(?:gstin|gst\s*registration|state\s*code|state\b|city\b|pin(?:code)?\b|post\s*code|declaration|bank|account|beneficiary|terms|signature|authoris?ed\s*signatory|amount\s*in\s*words|grand\s*total|total\b|summary|tax\s*summary|particulars|description|hsn|qty|quantity|rate\b|payment|mode|terms\s*of\s*payment|remarks?|notes?|page\s*\d|buyer'?s?\s*order|reference)\b/i;

// A document's own title is not a company. Without this, an invoice whose header
// reads "Tax Invoice" over the letterhead produces a supplier called
// "Tax Invoice" — the single most damaging mistake this parser can make,
// because it is written straight into the purchase's Party Name.
const DOCUMENT_TITLE_RE = /^(?:tax\s*)?(?:sales\s*)?(?:invoice|tax\s*invoice|bill|cash\s*memo|delivery\s*challan|challan|quotation|estimate|statement\s*of\s*account|purchase\s*order|sales\s*order|proforma\s*invoice|original\s*invoice|original\s*for\s*\w+|duplicate|for\s+duplicate|copy|memo|receipt)(?:\s*(?:no\.?|number|date|#))?\s*$/i;

// Printed around the edges of the page: copy markers, page numbers, subjects.
// None of them is anybody's name.
const DOCUMENT_BOILERPLATE_RE = /^(?:page\s*\d+(?:\s*of\s*\d+)?|subject|subject\s*:|ref(?:erence)?\s*:|buyer'?s?\s*order|order\s*no\.?|purchase\s*order|delivery\s*date|due\s*date|terms|conditions|declaration|signature|authoris?ed\s*signatory|for\s+\w+\s+(?:pvt|ltd|llp|inc))[\s:.\-–—]*$/i;

// True when a line cannot possibly be a party's name.
function isDocumentTitle(text) {
  const value = cleanLine(text);
  if (!value) return true;
  // A title is very often printed with a copy marker beside or under it — "Tax
  // Invoice (ORIGINAL FOR RECIPIENT)" — and while the marker is attached the
  // line is no longer a bare title, so it competes with the company name below it
  // for "the top line of the letterhead" and wins on word count. The marker is
  // removed before deciding.
  const withoutMarkers = value
    .replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return DOCUMENT_TITLE_RE.test(value)
    || DOCUMENT_TITLE_RE.test(withoutMarkers)
    || DOCUMENT_BOILERPLATE_RE.test(value);
}

// A run of spaces is where one printed column ended and the next began. OCR keeps
// the gap when it reads both columns as one line, and it is a far better place to
// split than any guessed fraction of the page width.
const CELL_GAP_RE = /\s{3,}/;
const firstCell = (text) => String(text || '').split(CELL_GAP_RE)[0].trim();

/**
 * True when a line is only an invoice reference or date label ("Invoice No. 22",
 * "Dated 17-09-2026"). Such a line names the document, never a party on it.
 */
function isReferenceLabel(text) {
  const value = cleanLine(text);
  if (!value) return false;
  if (REFERENCE_LINE_RE.test(value) && value.length <= 60) return true;

  // A label only makes the whole line a reference when the line *is* a
  // reference. OCR frequently reads both invoice columns as one line — "JBR
  // SOLUTIONS   Invoice No.   Dated" — and rejecting that line outright threw the
  // company name away with the metadata.
  //
  // So there has to be a reference label, near the front of the line, with
  // essentially nothing in front of it. Measuring "nothing in front" in words
  // rather than characters matters: collapsing the column gap turns that same
  // merged line into 30 characters, which is short enough to look like a bare
  // reference on its own.
  const isPureReference = (label) => {
    const hit = matchLabel(value, label);
    if (!hit || hit.index > 30) return false;
    const before = value.slice(0, hit.index);
    const wordsBefore = (before.match(/[A-Za-z]{2,}/g) || []).length;
    return wordsBefore <= 1;
  };

  const byInvoice = INVOICE_NUMBER_LABELS.some((l) => (!l.exclude || !l.exclude.test(value))
    && isPureReference(l));
  const byDate = INVOICE_DATE_LABELS.some((l) => (!l.exclude || !l.exclude.test(value))
    && isPureReference(l));
  return byInvoice || byDate;
}

// Removes a GSTIN (in any of its printed spellings) from a line that is being
// assembled into an address.
const stripGstinFromText = (text) => String(text || '')
  .replace(new RegExp(`${GST_LABEL}\\s*[:\\-./]?\\s*[0-9A-Za-z]{15}`, 'ig'), ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

const stripStateCodeFromText = (text) => String(text || '')
  .replace(/\bstate\s*(?:name|code)?\s*[:\-.]?\s*,?\s*code\s*[:\-.]?\s*\d{1,2}\b/ig, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

// ── Description sub-labels (a product's own details, not extra products) ─────

const DESCRIPTION_ATTRIBUTES = [
  { key: 'serial', match: /^\s*(?:serial\s*(?:no\.?|number)?|s\/n|sn|sr\s*no\.?|imei|device\s*serial)\b\s*[:\-]?\s*(.+)$/i },
  // A bare warranty statement — "6 MONTH WARRANTY", "1 YEAR OF HARDWARE
  // WARRANTY" — carries no label, but it is the warranty and not the product.
  // Without this it was read as another line of the product description, and a
  // short description could end up named after its own warranty.
  { key: 'warranty', fallbackToLine: true, match: /^\s*(?:\d+(?:\.\d+)?\s*(?:years?|yrs?|months?|mos?)\s*)?(?:of\s+)?(?:(?:hardware|software|comprehensive|limited)\s+)?warranty\b\s*[:\-]?\s*(.*)$/i },
  { key: 'model', match: /^\s*(?:model\s*(?:no\.?|number)?|model)\b\s*[:\-]?\s*(.+)$/i },
  { key: 'partNo', match: /^\s*(?:part\s*(?:no\.?|number)|part)\b\s*[:\-]?\s*(.+)$/i },
  { key: 'checkNo', match: /^\s*(?:check\s*(?:no\.?|number)|chq\s*no)\b\s*[:\-]?\s*(.+)$/i },
  { key: 'warranty', match: /^\s*(?:warranty)\b\s*[:\-]?\s*(.+)$/i },
  { key: 'colour', match: /^\s*(?:colou?r)\b\s*[:\-]?\s*(.+)$/i },
  { key: 'size', match: /^\s*(?:size|pack\s*size|dimensions?)\b\s*[:\-]?\s*(.+)$/i },
  { key: 'mrp', match: /^\s*(?:m\.?r\.?p\.?|price|mrp)\b\s*[:\-]?\s*(.+)$/i },
];

// "Serial No: ABC123, ABC124" → two serials.
const splitSerials = (value) => String(value || '')
  .split(/\s*(?:,|;|\/|\||\band\b)\s*/i)
  .map((s) => s.trim())
  .filter((s) => s && /\d/.test(s) && s.length >= 4 && s.length <= 60);

// A long batch of serial numbers wraps onto a second line on a narrow
// description column, and the continuation line carries no label at all.
const SERIAL_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9\-/.]{2,}$/;
const looksLikeSerialList = (text) => {
  const tokens = String(text || '').split(/\s*[,;]\s*/).map((t) => t.trim()).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => SERIAL_TOKEN_RE.test(t) && /\d/.test(t));
};

// Lines that are purely tax labels in the totals area — never items.
// A tax summary row is not an item line. OCR renders "CGST" as "casT" and "SGST"
// as "sesT" often enough that the strict spelling misses them, so a single-token
// row that is only a tax label - with whatever column-box junk OCR appended
// ("casT]|  9%  103.50 |") - is skipped. A real product description is never a
// single token like this, with or without a percentage.
const TAX_LABEL_ONLY_RE = /^\s*[|.:)\]\-~]*(?:c[a-z]{0,2}st|s[a-z]{0,2}st|igst|utgst|gst|cess|central\s*tax|state\s*tax|integrated\s*tax)\s*(?:@?\s*[\d.]+\s*%)?\s*[|.:)\]\-~]*$/i;

const ATTR_LINE_RE = /^\s*(?:serial\s*(?:no|#|:)|model\s*(?:no|#|:|$)|part\s*(?:no|#|:|$)|check\s*(?:no|#|:|$)|warranty\b|batch\s*(?:no|#|:|$)|brand\b|mfg\s*(?:date|on)?\b|expiry\s*(?:date)?\b|certificate\b)/i;

/** A line whose description cell is nothing but a (mangled) tax label. */
function isTaxLabelRow(buckets, text) {
  if (TAX_LABEL_ONLY_RE.test(text)) return true;
  const descCell = String(buckets.desc?.text || '').replace(/[^A-Za-z]/g, '');
  if (!descCell) return false;
  return /^(?:c[a-z]{0,2}st|s[a-z]{0,2}st|igst|utgst|gst|cess)$/i.test(descCell);
}

// ── Totals / section detection ───────────────────────────────────────────────

const TOTALS_LINE = /^\s*(?:sub\s*[-_]?\s*total|total\s+taxable|total\s*(?:cgst|sgst|igst|tax|gst|amount|invoice)|round\s*off|grand\s*total|invoice\s*total|total\s*amount|net\s*amount|amount\s*payable|total\s*invoice\s*value|tax\s*total|total\s*tax|total|amount\s+chargeable|taxable\s+value|tax\s+amount|cess)\b/i;
const PAYMENT_SECTION = /\b(?:payment\s*(?:details?|info(?:rmation)?|mode)|paid\s*via|mode\s*of\s*payment|payment\s*status|advance\s*paid|balance\s*due|amount\s*paid)\b/i;

// Lines that end the item table. A tax component printed on its own — "CGST",
// "SGST" — sits inside the table's own column band on many invoices, so the table
// has to stop at it by name or it becomes an inventory item called "CGST".
const ITEM_TABLE_STOP_RE = new RegExp([
  '^\\s*(?:cgst|sgst|igst|utgst|cess)\\b',            // a bare tax component row
  '^\\s*(?:round\\s*off|grand\\s*total|total|amount\\s*chargeable|taxable\\s*value)',
  '^\\s*(?:tax\\s*amount|total\\s*tax|total\\s*taxable)',
  '\\bamount\\s+chargeable\\b',
  '\\bbank\\s+details\\b',
  '\\bdeclaration\\b',
  '\\bauthoris?ed\\s+signatory\\b',
  '\\bterms\\s*(?:and|&)\\s*conditions\\b',
  '\\bamount\\s*\\(?in\\s+words\\)?\\b',
  '\\bthis\\s+is\\s+a\\s+computer\\s+generated\\b',
  "\\bcustomer'?s?\\s+seal\\b",
].join('|'), 'i');

// ── Column detection ─────────────────────────────────────────────────────────

const NUMERIC_KEYS = ['qty', 'rate', 'taxable', 'discount', 'total', 'cgstAmt', 'sgstAmt', 'igstAmt'];

// A unit cell holds "nos" or "pcs", never a number. It must never be merged into
// the rate or the amount, and it must never be read as an HSN.
const UNIT_RE = /^(?:nos?\.?|pcs?\.?|nos|pc|nos\/pc|units?|each|per|set|pkt\.?|box|dozen|kg|gm|kgs|gms|mt|pcs?)$/i;

const TAX_COMPONENTS = [
  { name: 'cgst', word: /cgst/i },
  { name: 'sgst', word: /sgst/i },
  { name: 'igst', word: /igst/i },
  { name: 'utgst', word: /utgst/i },
];

/** Strips punctuation so "Rate (Excl." and "HSN/SAC" compare cleanly. */
const headerWord = (word) => collapseSpaces(word).toLowerCase().replace(/[()[\]]/g, '').replace(/\.$/, '');

/**
 * Classifies one word of a table header. `next` is the following word, which is
 * how "CGST %" and "CGST Amount" are told apart when the header prints just
 * "CGST" over one column and the qualifier sits in the next cell.
 */
function classifyHeaderWord(raw, next) {
  const w = headerWord(raw);
  const n = headerWord(next || '');
  if (!w) return null;

  // A column heading is short printed text, so OCR mangles it more often than it
  // mangles body copy: "Rate" arrives as "Rae", "HSN/SAC" as "FSR/SAC". Missing a
  // heading means the column it introduces does not exist, and the values under
  // it end up concatenated into their neighbour — which is exactly how
  // "8523 nos 1,200.00 nos 1,200.00" ends up in a single field.
  const fuzzy = (phrases, tolerance = 1) => (findPhrase(w, phrases, { tolerance, maxWords: 2 }) ? true : false);

  // "Sl No." is two or three short words that OCR mangles constantly ("Si",
// "SiNo", "S.No"), and the row-number column matters more than its size suggests:
// without it there is nothing to the left of the description column, so the row
// number and the start of the product text have nowhere to go but into the
// product name.
if (/^(?:sl|s\.?\s?l\.?|sr|s\.?\s?no\.?|sno|srno|serial\s*no\.?|#|no)\b/.test(w)
    || fuzzy([['sl'], ['sl', 'no'], ['sr', 'no'], ['serial', 'no'], ['s', 'no']])) return { key: 'sl' };
  if (/^(?:description|particulars|commodity|product|items?|nature|nomenclature|goods)/.test(w)
    || fuzzy([['description'], ['particulars'], ['commodity'], ['nomenclature']])) return { key: 'desc' };
  if (/^(?:hsn|sac|hsn\/sac|hsn\s*code|hsncode)/.test(w)
    || fuzzy([['sac'], ['hsn', 'sac'], ['hsn', 'code']])) return { key: 'hsn' };
  if (/^(?:qty|qnty|quantity)/.test(w) || fuzzy([['quantity'], ['qnty']])) return { key: 'qty' };
  // "per" is its own column between Rate and Amount on many invoices, holding
  // only the unit ("nos", "pcs"). Without a column for it, that unit lands in
  // whichever numeric column is nearest and drags the rate along with it.
  if (/^(?:per|uom|unit|units?)\b/.test(w) || fuzzy([['per'], ['unit']])) return { key: 'unit' };
  if (/^(?:rate|unit\s*price|unit\s*rate|basic\s*rate|price|basic)/.test(w)
    || (/rate/.test(w) && /(excl|pre|basic|without)/.test(w))
    || fuzzy([['rate'], ['unit', 'rate']])) return { key: 'rate' };
  if (/^(?:taxable|tax\s*value|assessable|value)/.test(w)
    || fuzzy([['taxable'], ['assessable'], ['tax', 'value']])) return { key: 'taxable' };
  if (/^(?:discount|disc|less)/.test(w)) return { key: 'discount' };

  const tax = TAX_COMPONENTS.find((t) => t.word.test(w));
  if (tax) {
    const mentionsAmount = /(amt|amount|value|rs\.?|inr|₹)/.test(w) || /(amt|amount|value|rs\.?|inr|₹)/.test(n);
    const mentionsPercent = w.includes('%') || n.includes('%') || /(rate|percent)/.test(w);
    if (mentionsAmount) return { key: `${tax.name}Amt` };
    if (mentionsPercent) return { key: `${tax.name}Pct` };
    return { key: `${tax.name}Amt` };
  }
  if (w.includes('%') || /(rate|percent)/.test(w)) return null;
  if (/^(?:amount|total|value|grand)/.test(w)) return { key: 'total' };
  return null;
}

/**
 * Reads the item table's header line and locates every column on the page.
 * Multi-word headers ("Taxable Value", "Rate (Excl. Tax)") are absorbed into one
 * column so its centre lands in the middle of the printed heading rather than on
 * its first word.
 *
 * Returns `null` for any line that is not an item-table header. A document whose
 * items continue onto page 2 repeats the header there, which is why this returns
 * a match per region rather than one header for the whole document.
 */
// Words that merely qualify the column heading in front of them: "Taxable Value",
// "Rate (Excl. Tax)", "Sl No." are one column each. Absorbing them puts the
// column's centre in the middle of the printed heading, which is where the data
// cells line up.
const PURE_QUALIFIER_RE = /^(?:value|values|amt|excl|incl|inclusive|exclusive|tax|no\.?|nos?\.?|number|code|percent|of|de|la|&|\/)$/i;
// After a tax component, "Amount" and "Rate" qualify it ("CGST Amount"); anywhere
// else they are the start of the next column.
const TAX_QUALIFIER_RE = /^(?:amount|amt|value|values|rate|percent|%)$/i;
const TAX_COLUMN_KEYS = new Set(['cgstPct', 'cgstAmt', 'sgstPct', 'sgstAmt', 'igstPct', 'igstAmt', 'utgstPct', 'utgstAmt']);

/**
 * The leading numeric run of a money cell.
 *
 * Used only where the cell has already been decided to be a money column by its
 * position in the table. A rate or amount is sometimes printed tight against the
 * column rule, and OCR folds a speck of that rule into the digits: "1,160.00\"",
 * "1.150.00". The cell then fails the whole-cell numeric test and the value is
 * lost. Taking the leading run recovers it. Nothing is invented and no digit is
 * rewritten - "1.150.00" stays 1.15 and is still wrong in the same way OCR read
 * it, which is what the review flag is for.
 */
function leadingNumber(value, { thousandsLookalike = false } = {}) {
  const text = typeof value === 'string' ? value : (value?.text || '');
  const cell = String(text).trim();
  // An amount is written with EITHER a decimal point or comma-grouped thousands,
  // never both. "1,200.00" and "1200,00" are ordinary amounts.
  //
  // OCR sometimes reads the thousands separator as a decimal point, giving
  // "1.150.00" for 1,150.00. That reading is safe exactly when the middle group
  // is three digits: a decimal part is one or two digits, so a three-digit group
  // between two points can only be thousands. "1.15.00" has no such group and is
  // left alone rather than guessed at.
  const dots = (cell.match(/\./g) || []).length;
  if (dots > 1) {
    const grouped = cell.match(/^(\d{1,3})\.(\d{3})\.(\d{1,2})$/);
    if (!grouped) return null;
    // `parseFloat` would stop at the separator and read "1" out of "1,150.00", so the
    // digits are rejoined before being converted.
    return Number.parseFloat(`${grouped[1]}${grouped[2]}.${grouped[3]}`);
  }

  const m = cell.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const cleaned = m[0].replace(/,/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Every OCR word printed below the table header, up to the totals block. */
function itemRowWordsBelow(lines, headerIndex) {
  const header = lines[headerIndex];
  if (!header) return [];
  const top = lineCenterY(header) + lineHeight(header) * 0.5;
  const out = [];
  for (let k = headerIndex + 1; k < lines.length; k += 1) {
    const l = lines[k];
    if (!l || !l.words || !l.words.length) continue;
    if (lineCenterY(l) <= top) continue;
    const text = cleanLine(l.text);
    if (TOTALS_LINE.test(text) || PAYMENT_SECTION.test(text)) break;
    for (const w of l.words) {
      if (!w.bbox) continue;
      if (w.bbox.x1 - w.bbox.x0 <= 0) continue;
      out.push({ x0: w.bbox.x0, x1: w.bbox.x1, text: w.text, centerY: lineCenterY(l) });
    }
  }
  return out;
}

/**
 * Re-derives the description and right-hand column edges from the item rows
 * themselves rather than from the printed header.
 *
 * The header is not a reliable guide. On this document OCR read
 * "Sl - Description of Goods" as ONE cell spanning x=92..704, so the heading that
 * survived best ("Goods") sat hundreds of pixels right of where the product text
 * actually begins. Anchoring on it put the description's left edge in the middle
 * of the product column and its right edge inside the HSN column.
 *
 * The item rows, in contrast, are unambiguous: the whitespace between the printed
 * columns is visible. So the columns are found by locating the widest real gutter
 * in the item rows. On this invoice that gutter runs 574 -> 819, which separates
 * the description from HSN with a margin three times the next-widest gap.
 *
 * Nothing here reads a word's meaning, so the same rule works on any invoice; and
 * if no gutter stands out, no change is made and the header model stands.
 */
function refineColumnsFromItemRows(lines, headerIndex, columns, tableLeft) {
  const boxes = itemRowWordsBelow(lines, headerIndex);
  if (boxes.length < 4) return null;

  const merged = [];
  for (const b of boxes.slice().sort((a, c) => a.x0 - c.x0)) {
    const last = merged[merged.length - 1];
    if (last && b.x0 <= last.x1 + 0.5) last.x1 = Math.max(last.x1, b.x1);
    else merged.push({ x0: b.x0, x1: b.x1 });
  }
  if (merged.length < 3) return null;

  if (merged.length < 3) return null;
  const desc = columns.find((c) => c.key === 'desc');
  if (!desc) return null;

  // Every run of words the item rows actually print, left to right. A column
  // owns the runs that sit nearest its own heading, which is read from the page
  // rather than guessed from the gap sizes.
  const ordered = columns.slice().sort((a, b) => a.center - b.center);
  const owned = ordered.map(() => null);
  for (const band of merged) {
    const mid = (band.x0 + band.x1) / 2;
    let bestIndex = 0;
    let bestDistance = Infinity;
    ordered.forEach((column, index) => {
      const d = Math.abs(column.center - mid);
      if (d < bestDistance) { bestDistance = d; bestIndex = index; }
    });
    const slot = owned[bestIndex] || { x0: band.x0, x1: band.x1 };
    slot.x0 = Math.min(slot.x0, band.x0);
    slot.x1 = Math.max(slot.x1, band.x1);
    owned[bestIndex] = slot;
  }

  const descIndex = ordered.indexOf(desc);
  const leftSlot = descIndex > 0 ? owned[descIndex - 1] : null;
  const rightSlot = descIndex < owned.length - 1 ? owned[descIndex + 1] : null;
  if (!owned[descIndex] || !rightSlot || !(rightSlot.x0 > owned[descIndex].x0)) return null;

  const descX0 = owned[descIndex].x0;
  const descX1 = owned[descIndex].x1;
  const tableRight = boxes.reduce((m, b) => Math.max(m, b.x1), tableLeft);
  const rightNeighbour = ordered[descIndex + 1];

  return {
    desc,
    rightNeighbour,
    descX0,
    descX1,
    // The description stops where the next printed run begins; the column after
    // it starts there too, so the two share one boundary and neither can claim
    // the other's words.
    neighbourX0: rightSlot.x0,
    // Where the row-number column ends, which is where the description starts.
    leftEdge: leftSlot ? leftSlot.x1 : tableLeft,
    tableRight,
  };
}

function detectItemTableAt(lines, i, options = {}) {
  // When the ordinary single-line scan finds nothing, the merged fallback
  // recognises a heading that OCR split across two rows. That heading is passed
  // in as an overlay so the column refinement can still read the ITEM ROWS from
  // the real line list — with only the fake header line it would see no rows at
  // all and leave the description column mis-anchored.
  const line = options.headerOverride || lines[i];
  const words = (line.words || []).map((w) => w.text);
  if (!words.length) return null;

  const columns = [];
  let cursor = 0;

  // ── Multi-word headings are read as one anchor, not as loose words ──
  //
  // "Description of Goods" is a single printed heading. When each word is judged
  // on its own, the word that survives OCR best wins the column — and here that
  // was "Goods", which sits at the far right of a heading whose text occupies the
  // left of the table. The column's centre was then ~400px too far right, so the
  // midpoint that separates it from the row-number column landed in the middle of
  // the product text: the row number went into the product name, and "LAPTOP",
  // "ASUS" and the warranty lines were swallowed by the row-number column.
  //
  // So the longest heading phrases are matched first and consume their words.
  const PHRASE_ANCHORS = [
    {
      key: 'desc',
      phrases: [
        ['description', 'of', 'goods'], ['description', 'goods'],
        ['description'], ['particulars'], ['commodity'], ['nomenclature'], ['product', 'details'],
      ],
      tolerance: 1,
    },
  ];

  const consumed = new Set();
  for (const anchor of PHRASE_ANCHORS) {
    const cells = segmentCells(line);
    for (const cell of cells) {
      if (consumed.has(cell)) continue;
      const hit = findPhrase(cell.text, anchor.phrases, { tolerance: anchor.tolerance, maxWords: 4 });
      if (!hit) continue;
      // segmentCells may merge the whole printed row into one cell (a heading's
      // inter-column gaps are barely wider than its word spaces), so the anchor
      // never spans the entire merged blob. The column is clamped to the words
      // the matched phrase actually covers, otherwise the description swallows
      // the row-number and HSN columns beside it.
      const spanWords = [];
      let offset = 0;
      for (const w of cell.words) {
        const wordStart = offset;
        const wordEnd = offset + w.text.length;
        if (wordEnd > hit.index && wordStart < hit.index + hit.length) spanWords.push(w);
        offset = wordEnd + 1;
      }
      const x0 = spanWords.length ? Math.min(...spanWords.map((w) => w.x0)) : cell.x0;
      const x1 = spanWords.length ? Math.max(...spanWords.map((w) => w.x1)) : cell.x1;
      columns.push({
        key: anchor.key,
        label: cell.text,
        x0,
        x1,
        center: (x0 + x1) / 2,
        fromPhrase: true,
      });
      consumed.add(cell);
      break;
    }
  }

  while (cursor < words.length) {
    // A word already claimed by a phrase anchor above is not re-classified.
    if (line.words[cursor] && consumed.has(line.words[cursor])) { cursor += 1; continue; }
    const verdict = classifyHeaderWord(words[cursor], words[cursor + 1]);
    if (!verdict) { cursor += 1; continue; }
    if (columns.some((c) => c.key === verdict.key)) { cursor += 1; continue; }

    // Grow the heading across its qualifier words. The same word is never taken
    // twice, which is what stops "SGST Amount" from swallowing the "Amount"
    // column that follows it.
    const phrase = new Set([headerWord(words[cursor])]);
    let span = 1;
    while (cursor + span < words.length && span < 3) {
      const nextWord = words[cursor + span];
      const nextHead = headerWord(nextWord);
      if (phrase.has(nextHead)) break;
      // Another tax column ("SGST") always starts a new column.
      if (TAX_COMPONENTS.some((t) => t.word.test(nextHead))) break;
      if (PURE_QUALIFIER_RE.test(nextHead)) { phrase.add(nextHead); span += 1; continue; }
      if (TAX_COLUMN_KEYS.has(verdict.key) && TAX_QUALIFIER_RE.test(nextHead)) { phrase.add(nextHead); span += 1; continue; }
      break;
    }

    const first = line.words[cursor];
    const last = line.words[Math.min(words.length - 1, cursor + span - 1)];
    const x0 = first?.bbox?.x0 ?? 0;
    const x1 = last?.bbox?.x1 ?? x0;
    columns.push({
      key: verdict.key,
      headX1: last.x1,
      label: words.slice(cursor, cursor + span).join(' '),
      x0,
      x1,
      center: (x0 + x1) / 2,
    });
    cursor += span;
  }

  const keys = new Set(columns.map((c) => c.key));
  // A real item header always has a description and at least two numbers.
  const hasDescription = keys.has('desc');
  const numericFound = ['qty', 'rate', 'taxable', 'total'].filter((k) => keys.has(k)).length;
  if (!hasDescription || numericFound < 2) return null;
  if (!keys.has('qty') && !keys.has('rate') && !keys.has('taxable')) return null;

  columns.sort((a, b) => a.center - b.center);

  // ── Column boundaries are the midpoints between header anchors ──
  //
  // A heading's own left edge is not the start of its column. "Description of
  // Goods" is one heading, and OCR read it here as "Descriphan ol Goods" — so the
  // word that happened to be recognised was "Goods", which put the description
  // column's left edge several hundred pixels too far right. Everything to the
  // left of it then fell into the wrong bucket: the row number and the amounts
  // ended up inside the product name, HSN absorbed the unit, and Rate and Amount
  // came back empty.
  //
  // Each column therefore runs from halfway between its heading and the previous
  // one to halfway between its heading and the next one. No token can then leak
  // into a neighbouring column, whatever the OCR made of the heading's wording.
  const tableLeft = columns[0].x0;
  const tableRight = columns[columns.length - 1].x1;
  columns.forEach((column, index) => {
    // The description column is positioned afterwards from its neighbours,
    // because its own heading is not a reliable guide to where the product text
    // begins.
    if (column.key === 'desc') return;
    const previous = index > 0 ? columns[index - 1] : null;
    const next = index < columns.length - 1 ? columns[index + 1] : null;
    column.x0 = previous ? (previous.center + column.center) / 2 : tableLeft;
    column.x1 = next ? (column.center + next.center) / 2 : tableRight;
  });

  // The description column holds the whole product text, so its real bounds are
  // not where its own heading sits — they are the space between the columns on
  // either side of it. OCR merged the row-number and description headings into one
  // cell here ("Si - Descriphan ol Goods"), so the heading's position is useless
  // for this: the description runs from the end of the row-number column to the
  // start of the HSN column, and that is where its left and right edges belong.
  const sl = columns.find((c) => c.key === 'sl');
  const desc = columns.find((c) => c.key === 'desc');
  const rightNeighbour = desc ? columns.find((c) => c.center > desc.center) : null;
  let tableRightOverride = null;
  const refined = refineColumnsFromItemRows(lines, i, columns, tableLeft);
  if (refined) {
    if (sl) sl.x1 = refined.leftEdge;
    refined.desc.x0 = refined.descX0;
    refined.desc.x1 = refined.descX1;
    if (refined.rightNeighbour) refined.rightNeighbour.x0 = refined.neighbourX0;
    tableRightOverride = refined.tableRight;
    // The last column's right edge came from the last heading, which on this page
    // ended at 1421 while the amounts themselves are printed out to 1475. Taking
    // the extent of the real item rows keeps the amount column whole.
    const rightmost = columns.reduce((best, c) => (best === null || c.center > best.center ? c : best), null);
    if (rightmost && rightmost !== refined.desc) rightmost.x1 = refined.tableRight;
  } else if (desc) {
    if (sl) {
      desc.x0 = Math.min(desc.x0, sl.headX1 ?? sl.x1);
      if (sl && desc.x0 > sl.x1) desc.x0 = sl.x1;
    } else {
      // No row-number column. OCR often mangles a split header line so that only
      // the last word of the heading survives ("Goods"), which anchors the
      // description several hundred pixels right of the product text. The item
      // rows know where the description really begins, so the column opens at the
      // leftmost word printed in the table band.
      const leftmost = itemRowWordsBelow(lines, i).map((b) => b.x0);
      if (leftmost.length) desc.x0 = Math.min(desc.x0, ...leftmost);
    }
    if (rightNeighbour) desc.x1 = rightNeighbour.x0;
  }

  // The description opens where the product text actually begins (the heading is
  // indented, the product is not) and ends where the product meets the figures.
  // The figures only decide the edge when they sit clearly right of the prose —
  // a number inside a product name must not truncate it.
  if (desc) {
    const textStart = firstItemRowTextX(lines, i, tableLeft);
    if (textStart !== null && textStart < desc.x0) desc.x0 = textStart;
    const numericStart = firstItemRowNumberX(lines, i, desc.x0, tableRight);
    if (numericStart !== null && numericStart > desc.x0 + 20) {
      desc.x1 = numericStart;
      if (rightNeighbour) rightNeighbour.x0 = numericStart;
    }
  }

  return {
    headerIndex: i,
    headerLine: line,
    pageNumber: line.pageNumber,
    columns,
    keys: [...keys],
    bbox: {
      x0: tableLeft,
      y0: line.bbox?.y0 ?? 0,
      x1: tableRightOverride ?? tableRight,
      y1: line.bbox?.y1 ?? 0,
    },
    score: numericFound + (keys.has('qty') ? 1 : 0) + (keys.has('hsn') ? 0.5 : 0),
  };
}

/** Every item-table region in the document, one per repeated header. */
function findItemTables(lines) {
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    const table = detectItemTableAt(lines, i);
    if (table) tables.push(table);
  }
  return tables;
}

/**
 * The first real number printed on an item row, as an x position.
 *
 * Product prose and the HSN cell are often read as one glued line
 * ("...PARTS 8523 1 1200.00"), so the header midpoints place the description
 * boundary inside the product text and hand the tail of the name to HSN. The
 * numbers themselves are unambiguous: the description ends exactly where the
 * first figure begins. A pure digit run far left of the product text (a row
 * number) is excluded by the description's own left edge.
 */
function firstItemRowNumberX(lines, headerIndex, descX0, tableRight) {
  const rows = [];
  for (let k = headerIndex + 1; k < lines.length; k += 1) {
    const line = lines[k];
    if (!line || !line.words || !line.words.length) continue;
    if (TOTALS_LINE.test(cleanLine(line.text)) || PAYMENT_SECTION.test(cleanLine(line.text))) break;
    const numbers = [];
    for (const w of line.words) {
      if (!w.bbox || !w.text) continue;
      const token = String(w.text).trim();
      if (!token || w.bbox.x0 < descX0 - 1 || w.bbox.x0 > tableRight) continue;
      if (/^\d[\d,]*$/.test(token) || /^\d{1,3}(?:,\d{3})*\.\d{1,2}$/.test(token)) {
        numbers.push(Math.round(w.bbox.x0 / 4) * 4);
      }
    }
    if (numbers.length) rows.push(numbers);
  }
  // A figure that is really a printed column repeats across the item rows; a
  // number sitting inside product prose ("6 MONTH WARRANTY") is a one-off and is
  // ignored. Tables with a single item row simply keep the header-derived edge.
  if (rows.length < 2) return null;
  const counts = new Map();
  for (const numbers of rows) {
    for (const x of numbers) counts.set(x, (counts.get(x) || 0) + 1);
  }
  let found = null;
  for (const [x, count] of counts) {
    if (count < 2) continue;
    if (found === null || x < found) found = x;
  }
  return found;
}

/**
 * The leftmost word that is really product text on the first item row.
 *
 * The description heading is indented by its own "Sl " cell ("Sl Description of
 * Goods"), so the phrase-anchored left edge lands a word or two right of where
 * the product text actually begins. The product's own words start right after
 * the row number, and only its row carries a figure beside the prose — so the
 * first item row's leftmost letter word is where the description opens.
 */
function firstItemRowTextX(lines, headerIndex, tableLeft) {
  for (let k = headerIndex + 1; k < lines.length; k += 1) {
    const line = lines[k];
    if (!line || !line.words || !line.words.length) continue;
    if (TOTALS_LINE.test(cleanLine(line.text)) || PAYMENT_SECTION.test(cleanLine(line.text))) break;
    const rowWords = (line.words || []).filter((w) => w.bbox);
    if (!rowWords.some((w) => /^\d/.test(String(w.text || '').trim()))) continue;
    let found = null;
    for (const w of rowWords) {
      const token = String(w.text || '').trim();
      if (!/[A-Za-z]/.test(token)) continue;
      if (w.bbox.x0 < tableLeft) continue;
      if (found === null || w.bbox.x0 < found) found = w.bbox.x0;
    }
    return found;
  }
  return null;
}

/**
 * Merges the rows OCR read from a single printed header line.
 *
 * A two-column printed row is frequently split into one OCR line per column:
 * "FSNISACT CUET [Rate [per] Amount |" and, on the very next row, "Descipion of
 * Goods". Neither line alone looks like a table header — the numeric headings
 * and the description heading never appear in the same line — so the header is
 * never found and the document reads as if it had no items. Rows whose vertical
 * centres sit within a single line-height are one printed line, so their words
 * are merged left-to-right.
 */
function mergeAdjacentHeaderRows(lines, index, median) {
  const rows = [lines[index]];
  const center = lineCenterY(lines[index]);
  for (let j = index + 1; j < Math.min(lines.length, index + 4); j += 1) {
    if (lineCenterY(lines[j]) - center > Math.max(median * 1.2, 4)) break;
    if (rows.length >= 3) break;
    rows.push(lines[j]);
  }
  if (rows.length < 2) return null;
  const words = [];
  for (const line of rows) {
    words.push(...(line.words || []).filter((w) => w && w.bbox && String(w.text || '').trim()));
  }
  if (words.length < 2) return null;
  words.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  return {
    ...rows[0],
    text: words.map((w) => String(w.text).trim()).join(' '),
    words,
    mergedRows: rows.length,
    bbox: {
      x0: 0,
      y0: Math.min(...rows.map((l) => l.bbox?.y0 || 0)),
      x1: Math.max(...words.map((w) => w.bbox.x1), 0),
      y1: Math.max(...rows.map((l) => l.bbox?.y1 || 0), 0),
    },
  };
}

/**
 * The fallback item-table scan used only when the ordinary one finds nothing.
 *
 * It rescans every row merged with its vertical neighbours, so a header that OCR
 * split across rows is still recognised. Because it only ever runs after the
 * single-line scan came back empty, a document whose table the ordinary scan
 * already finds (like JBR) goes through exactly the same path as before.
 */
function findItemTablesMerged(lines) {
  const tables = [];
  const median = medianLineHeight(lines);
  for (let i = 0; i < lines.length; i += 1) {
    if (detectItemTableAt(lines, i)) continue;
    const fake = mergeAdjacentHeaderRows(lines, i, median);
    if (!fake) continue;
    const table = detectItemTableAt(lines, i, { headerOverride: fake });
    if (!table) { const t = detectItemTableAt([fake], 0); if (t) tables.push({ ...t, headerIndex: i }); continue; }
    const recovered = table.columns.some((c) => c.key === 'qty') && table.columns.some((c) => c.key === 'hsn')
      ? null
      : recoverNumericColumnsFromRows(lines, i, table);
    tables.push({ ...(recovered || table), headerIndex: i });
  }
  return tables;
}

/**
 * Rebuilds the right-hand numeric columns from the item rows themselves, used
 * only in the merged fallback (JBR never reaches it because the ordinary scan
 * already finds its table).
 *
 * The merged heading is OCR-mangled beyond fixing ("FSNISACT CUET [Rate [per]
 * Amount |"), so the recognised columns stop at rate/unit/amount and the HSN and
 * quantity columns do not exist as far as the header is concerned. The item rows
 * still print those cells cleanly — a textbook row like
 *
 *     "847 | 1NOS| 1150.00|Nos|"
 *
 * is HSN=847, Qty=1 NOS, Rate=1150.00, Per=Nos. The cells are read from that row
 * by their content (an integer, a digit+unit, a money figure, a lone unit) and
 * their position, which is exactly how a human reads the grid.
 */
function recoverNumericColumnsFromRows(lines, headerIndex, table) {
  const desc = table.columns.find((c) => c.key === 'desc');
  const descRight = desc ? desc.x1 : 0;
  const descLeft = desc ? desc.x0 : 0;

  for (let k = headerIndex + 1; k < lines.length && k <= headerIndex + 5; k += 1) {
    const l = lines[k];
    if (!l || !l.words || !l.words.length) continue;
    const text = cleanLine(l.text);
    if (TOTALS_LINE.test(text) || PAYMENT_SECTION.test(text) || ITEM_TABLE_STOP_RE.test(text)) break;
    if (TAX_LABEL_ONLY_RE.test(text)) continue;

    const wordsRight = (l.words || [])
      .filter((w) => w.bbox && ((w.bbox.x0 + (w.bbox.x1 || w.bbox.x0)) / 2) > descRight - 1)
      .filter((w) => String(w.text || '').trim())
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    if (wordsRight.length < 3) continue;

    // A printed column rule merges into the cell before or after it ("1NOS|",
    // "1150.00|Nos|"), so every token is split on the vertical bars and each
    // piece keeps an even share of the word's own span for its position.
    const pieces = [];
    for (const w of wordsRight) {
      const parts = String(w.text).split('|');
      const n = parts.length;
      const span = ((w.bbox.x1 || w.bbox.x0) - w.bbox.x0) / n;
      parts.forEach((part, index) => {
        const t = part.replace(/[^0-9A-Za-z.,%]/g, '').trim();
        if (!t) return;
        pieces.push({ t, x0: w.bbox.x0 + span * index, x1: w.bbox.x0 + span * (index + 1) });
      });
    }
    pieces.sort((a, b) => a.x0 - b.x0);
    if (pieces.length < 3) continue;

    const right = [];
    const keys = new Set();
    let moneySeen = 0;
    let hsnSeen = false;
    for (const piece of pieces) {
      const t = piece.t;
      let key = null;
      if (/^\d[\d,]*(?:\.\d{1,2})$/.test(t)) {
        moneySeen += 1;
        key = moneySeen === 1 ? 'rate' : 'total';
      } else if (/^\d+[A-Za-z]{1,4}$/.test(t)) {
        key = 'qty';
      } else if (/^\d{1,7}$/.test(t)) {
        key = hsnSeen ? 'qty' : 'hsn';
      } else if (/^[A-Za-z]{1,6}$/.test(t)) {
        key = 'unit';
      }
      if (!key || keys.has(key)) continue;
      keys.add(key);
      if (key === 'hsn') hsnSeen = true;
      right.push({ key, x0: piece.x0, x1: piece.x1, center: (piece.x0 + piece.x1) / 2, source: 'data-row' });
    }

    if (right.length < 2 || !right.some((c) => c.key === 'rate')) continue;

    // A clean row decided the columns, so a second run over a later row is only a
    // sanity check that nothing drifts — the first decision stands.
    const firstRight = right.slice().sort((a, b) => a.x0 - b.x0);
    if (firstRight.length && desc) desc.x1 = Math.min(desc.x1, firstRight[0].x0);

    // OCR often prints the rate and its unit as ONE word ("1150.00|Nos|") whose
    // single centre can only land in one column. Folding the unit into the rate
    // column keeps the money figure in the rate cell — a stray "Nos" in the same
    // cell does not disturb the value, since the leading number still parses.
    const unitCol = firstRight.find((c) => c.key === 'unit');
    const rateCol = firstRight.find((c) => c.key === 'rate');
    const rightCols = unitCol && rateCol && rateCol.x1 < unitCol.x1
      ? firstRight.filter((c) => c.key !== 'unit').map((c) => (c.key === 'rate'
        ? { ...c, x1: unitCol.x1, center: (c.x0 + unitCol.x1) / 2 }
        : c))
      : firstRight;

    const finalColumns = [desc, ...rightCols].filter(Boolean);
    return { ...table, columns: finalColumns, keys: finalColumns.map((c) => c.key) };
  }
  return null;
}

function findItemTable(lines) {
  const tables = findItemTables(lines);
  if (!tables.length) return null;
  return tables.slice().sort((a, b) => b.score - a.score)[0];
}

// ── Party blocks ─────────────────────────────────────────────────────────────

const medianLineHeight = (lines) => {
  const heights = lines.map(lineHeight).sort((a, b) => a - b);
  return heights.length ? heights[Math.floor(heights.length / 2)] : 12;
};

/**
 * Reads a labelled party block: the label line plus the lines below it, up to
 * the next label, the table header, or an obvious gap in the page.
 */
function readPartyBlock(lines, labelHit, table) {
  const block = [];
  const median = medianLineHeight(lines);
  let previousY = lineCenterY(lines[labelHit.lineIndex]);
  const anchorLine = lines[labelHit.lineIndex];
  // Use the anchor line's left edge as the column boundary.
  // Lines that start significantly to the right of the anchor are in a
  // different column (invoice metadata) and must not enter the party block.
  const anchorX0 = anchorLine?.bbox?.x0 ?? 0;
  const pageWidth = anchorLine?.pageWidth || 0;
  const splitX = pageWidth > 100 ? pageWidth * 0.55 : Infinity;

  for (let i = labelHit.lineIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (table && i === table.headerIndex) break;
    if (i > labelHit.lineIndex && hasAnyLabel(line.text, SELLER_LABELS)
      && hasAnyLabel(line.text, BUYER_LABELS)) break;
    if (i > labelHit.lineIndex
      && (hasAnyLabel(cleanLine(line.text).slice(0, 24), SELLER_LABELS)
        || hasAnyLabel(cleanLine(line.text).slice(0, 24), BUYER_LABELS))) break;
    if (i > labelHit.lineIndex && BLOCK_STOP_WORDS.test(line.text) && lineCenterY(line) - previousY > median * 0.6) break;
    if (lineCenterY(line) - previousY > median * 3.2) break;
    // Skip lines that are clearly in the right column (invoice metadata).
    const lineX0 = line.bbox?.x0 ?? 0;
    if (i > labelHit.lineIndex && lineX0 > splitX && !sameRow(anchorLine, line)) continue;

    block.push(line);
    previousY = lineCenterY(line);
  }
  return block;
}

/**
 * Reads a party from a block of lines, recovering the name even when OCR split
 * it across two printed lines — "Bluechip Computer s" then "h uter Systom". The
 * GSTIN and address below are untouched; only the name is recovered, and it is
 * matched by similarity afterwards, so a wrong join cannot identify anything on
 * its own.
 */
function readPartyFromBlock(block, roleLabel) {
  if (!block || !block.length) return null;
  const party = extractPartyFromBlock(block, { roleLabel });
  if (party.name.value) return party;
  const joined = collapseSpaces(block.slice(0, 3).map((l) => l.text).join(' '))
    .replace(/\s*[|/\\]\s*/g, ' ');
  if (joined && joined.length >= 4 && !isDocumentTitle(joined)) {
    party.name = field(joined, Math.max(0.4, (block[0].confidence || 0) / 100), 'joined-lines');
  }
  return party;
}

/**
 * Own-company blocks in the header that carry no role label.
 *
 * On some invoices the whole "Buyer (Bill To)" heading is illegible — OCR reads
 * nearly nothing of it — so the labelled-block scan finds no buyer at all and a
 * genuine purchase reports an unknown direction. Any block below the issuer's
 * own letterhead that carries a party name or a GSTIN is therefore checked
 * against the company profile: a block that matches us on the buying side is
 * strong evidence the document really is incoming.
 *
 * The issuer's lines are excluded, so a supplier's letterhead can never double
 * as buyer evidence. A block with a GSTIN is put first, because it is the
 * strongest possible proof of who the block belongs to.
 */
function findOwnBuyerBlocks(lines, { headerLimit, geometry, issuer, profile }) {
  const blocks = [];
  if (!profile || profile.isEmpty) return blocks;

  const issuerLines = new Set((issuer && issuer.lines) || []);
  const pageWidth = geometry.pageWidth
    || Math.max(...lines.map((l) => (l.bbox?.x1 || 0)), 0);
  const divider = geometry.columnDivider;
  const splitX = divider === null || divider === undefined ? pageWidth * 0.55 : divider;
  const median = medianLineHeight(lines);

  let current = [];

  const closeBlock = () => {
    if (!current.length) return;
    const blockLines = current.map((i) => lines[i]);
    current = [];
    if (blockLines.some((l) => issuerLines.has(l))) return;
    const party = readPartyFromBlock(blockLines, 'buyer');
    if (!party) return;
    if (!party.name.value && !party.gstin.value) return;
    const match = companyIdentity.matchParty(party, profile);
    if (!match.isOwn) return;
    // This block IS us, so the OCR-mangled name is replaced by the canonical
    // configured name — "Bluechip Computer s / h uter Systom" is reported to the
    // review screen as the company it actually is.
    if (profile.legalName) {
      party.name = field(profile.legalName, 0.97, 'own-identity-block');
    }
    blocks.push({ party, match });
  };

  for (let i = 0; i < headerLimit; i += 1) {
    const line = lines[i];
    if (!line || !(line.words || []).length) { closeBlock(); continue; }
    const text = cleanLine(line.text);
    if (!text) { closeBlock(); continue; }
    if (TOTALS_LINE.test(text) || PAYMENT_SECTION.test(text)) break;
    // Lines to the right of the column divider are invoice metadata, never part
    // of a party block. They are skipped without breaking the current block, so
    // a wide two-column party block is kept whole.
    const lineX0 = line.bbox?.x0 ?? 0;
    if (lineX0 > splitX) continue;
    if (current.length) {
      const previous = lineCenterY(lines[current[current.length - 1]]);
      if (lineCenterY(line) - previous > median * 1.8) closeBlock();
    }
    current.push(i);
  }
  closeBlock();

  blocks.sort(
    (a, b) => (Number(Boolean(b.party.gstin?.value)) - Number(Boolean(a.party.gstin?.value)))
      || (b.match.score - a.match.score),
  );
  return blocks.map((b) => b.party);
}

// GST invoices label this field a dozen different ways. "GSTIN/UIN" is the most
// common of all and it used to be missed completely, because the old pattern
// stopped at "GSTIN" — leaving the "/UIN" in front of the number, so the fifteen
// characters that follow were never reached. That mattered a great deal: the
// GSTIN is the one identifier on an invoice that is exact by law, and it is what
// proves which company a block belongs to.
const GST_LABEL = String.raw`GST(?:\s*IN)?(?:\s*\/\s*(?:UIN|UID))?(?:\s*No\.?)?`;
const GSTIN_ON_LINE = new RegExp(`\\b${GST_LABEL}\\b\\s*[:\\-./]?\\s*([0-9A-Za-z]{15})\\b`, 'i');
const GSTIN_LOOSE = new RegExp(`GST(?:\\s*IN)?(?:\\s*\\/\\s*(?:UIN|UID))?(?:\\s*No\\.?)?[^0-9A-Z]{0,4}([0-9A-Z]{15})`, 'i');

// The words that name a *role* rather than a party. A block headed
// "Buyer (Bill To)" would otherwise be read as a company called "Buyer".
const ROLE_WORD_RE = /^(?:buyer|seller|supplier|vendor|consignee|ship\s*to|bill\s*to|party|customer|purchaser|dear\s*(?:sir|madam)|for)\b/i;

/** Removes any leading role words and the brackets they leave behind. */
function stripRoleWords(value) {
  let text = String(value || '');
  for (let i = 0; i < 4; i += 1) {
    const next = text
      // "M/s JBR Solutions" and "Messrs JBR Solutions" are how a party is
      // introduced, not part of its name.
      .replace(/^(?:m\s*\/\s*s|messrs?|proprietors?\s+of)\b\.?\s*/i, '')
      .replace(ROLE_WORD_RE, '')
      .replace(/^[\s:()\[\].,-]+/, '')
      .replace(/[\s()\[\].,-]+$/, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function gstinIn(lines) {
  for (const line of lines) {
    const m = cleanLine(line.text).match(GSTIN_ON_LINE);
    if (m) return { raw: m[1], line };
    // Sometimes the GSTIN is printed on its own with only "GSTIN" above it.
    const loose = collapseSpaces(line.text).replace(/\s+/g, '');
    const m2 = loose.match(GSTIN_LOOSE);
    if (m2) return { raw: m2[1], line };
  }
  return null;
}

/**
 * Turns a block of lines into party fields. Only values printed inside the block
 * are used; a GSTIN is additionally put through the real GSTIN rules, and an
 * unrecognisable one is reported rather than repaired.
 */
function extractPartyFromBlock(block, { roleLabel }) {
  const result = {
    name: missing(),
    gstin: missing(),
    contactPerson: missing(),
    address: missing(),
    city: missing(),
    state: missing(),
    pincode: missing(),
    phone: missing(),
    email: missing(),
  };
  if (!block.length) return result;

  const warnings = [];
  // `raw` is kept because the gap between two printed columns is a run of spaces
  // that `cleanLine` collapses away — and that gap is the only honest place to
  // split a line OCR read as two columns.
  const lines = block.map((l) => ({ ...l, clean: cleanLine(l.text), raw: String(l.text || '') }));

  // ── GSTIN first: it is the most reliable anchor in the whole block.
  const foundGstin = gstinIn(lines);
  let stateFromGstin = null;
  if (foundGstin) {
    const graded = validateGstin(foundGstin.raw);
    const ocrConfidence = ((foundGstin.line.confidence || 0) / 100) || 0.9;
    const confidence = graded.valid
      ? Math.min(0.99, 0.6 + ocrConfidence * 0.4)
      : (graded.shapeOk ? 0.6 + ocrConfidence * 0.2 : Math.min(0.84, ocrConfidence));
    if (!graded.valid) {
      warnings.push('GSTIN could not be confidently verified');
    }
    result.gstin = field(
      graded.value,
      confidence,
      'gstin-line',
      [
        !graded.lengthOk ? 'GSTIN is not 15 characters' : null,
        !graded.shapeOk && graded.lengthOk ? 'GSTIN does not match the expected format' : null,
        graded.shapeOk && !graded.checksumOk ? 'GSTIN check digit does not match — please verify' : null,
      ]
    );
    result.gstinRepairs = graded.valid ? [] : suggestGstinRepairs(foundGstin.raw);
    stateFromGstin = graded.state;
  } else if (lines.some((l) => /GST\s*(?:IN)?\b/i.test(l.clean) && /[0-9A-Za-z]{10,}/.test(l.clean))) {
    result.gstin = missing('GSTIN is printed but could not be read');
    warnings.push('GSTIN could not be confidently verified');
  }

  // ── Name: the first line that is not a label, a contact detail or an address.
  const nameCandidates = [];
  for (const line of lines) {
    const text = line.clean;
    if (!text) continue;
    if (GSTIN_ON_LINE.test(text)) continue;
    if (/^(?:gstin|gst|phone|ph\b|mob|mobile|tel|email|e-?mail|web|website|fax|state|city|pin|pincode|post\s*code)\b/i.test(text)) continue;
    if (findEmail(text)) continue;
    if (looksLikePhone(text) && text.replace(/\D/g, '').length >= 10 && text.length < 22) continue;
    if (hasAnyLabel(text, SELLER_LABELS) || hasAnyLabel(text, BUYER_LABELS)) {
      const stripped = stripRoleWords(text
        .replace(SELLER_LABELS[0].match, '')
        .replace(BUYER_LABELS[0].match, ''));

      // A role label introduces the party; it is not one. What follows the label
      // on the same line is only a name if it really reads like one, and it does
      // not when the label is a two-column heading — "Buyer (Bill to)   Dispatch
      // Doc No.   Delivery Note Date" — where everything to the right belongs to
      // the invoice, not to the buyer.
      // What is left of a role heading is only a name when it actually contains
      // one. "Buyer (Bl to)" leaves "Bl to" behind, and neither word is long
      // enough to be part of a company name — reading it as one hid the real
      // buyer ("BLUECHIP COMPUTER SYSTEM", printed on the next line) and left
      // the invoice's direction undetermined.
      const hasRealNameWord = /[A-Za-z]{3,}/.test(stripRoleWords(stripped));

      const besideIsCleanName = stripped.length >= 3
        && hasRealNameWord
        && !isDocumentTitle(stripped)
        && !isReferenceLabel(stripped)
        && !TOTALS_LINE.test(stripped)
        && !PAYMENT_SECTION.test(stripped)
        // Two or more unrelated labels on the line means the rest of the line is
        // a different field entirely, not a company name.
        && !REFERENCE_LINE_RE.test(stripped)
        && !NAME_RESIDUE_NOISE_RE.test(stripped)
        && stripRoleWords(stripped).length >= 3;

      if (besideIsCleanName) nameCandidates.push({ line, text: stripped, fromLabel: true });
      // Otherwise the name is on one of the following lines, which the loop
      // below reaches in the normal way.
      continue;
    }
    // A line that is nothing but role words is a heading, not a company.
    const withoutRole = stripRoleWords(text);
    if (withoutRole.length < 3) continue;
    if (BLOCK_STOP_WORDS.test(text)) continue;
    // The document's own title ("Tax Invoice") heads many letterheads. It is
    // never the party, and it must not become the Party Name.
    if (isDocumentTitle(text) || isDocumentTitle(withoutRole)) continue;
    // Neither is the document's reference line ("Invoice No. 22").
    if (isReferenceLabel(text)) continue;
    nameCandidates.push({ line, text: withoutRole, fromLabel: false });
  }

  const nameHit = nameCandidates[0];
  if (nameHit) {
    const ocrConfidence = ((nameHit.line.confidence || 0) / 100) || 0.9;
    // A line that OCR read as two printed columns carries the gap between them
    // as a run of spaces, so the party is only what lies left of that gap. This
    // is what keeps "BLUECHIP COMPUTER SYSTEM   |  Prime: …" from becoming a
    // company name with a printer's label welded to it.
    const nameText = firstCell(nameHit.line.raw || nameHit.text) || firstCell(nameHit.text);
    const cleanliness = /[A-Za-z]{3}/.test(nameText) ? 1 : 0.5;
    result.name = field(
      collapseSpaces(nameText).replace(/[,;]$/, ''),
      Math.min(0.98, ocrConfidence * cleanliness * (nameHit.fromLabel ? 0.98 : 1)),
      roleLabel ? `${roleLabel}-label` : 'party-block'
    );
  }

  // ── Everything else.
  const used = new Set(nameHit ? [nameHit.line] : []);
  const addressLines = [];

  for (const line of lines) {
    if (used.has(line)) continue;
    const text = line.clean;
    if (!text) continue;
    // A document title is not part of the postal address.
    if (/^(?:tax\s*)?(?:sales\s*)?(?:invoice|tax\s*invoice|bill|cash\s*memo|delivery\s*challan|challan|quotation|estimate)(?:\s*(?:no\.?|number|date))?\s*$/i.test(text)) continue;
    // "GSTIN: 24AAECM1234F1Z5   Ph: 0265 2334455" is one printed line. The GSTIN
    // belongs to its own field, but the phone on the same line is still this
    // party's phone — so the GSTIN is cut out of the text and the rest of the
    // line keeps being read for contacts instead of being skipped whole.
    const carriesGstin = GSTIN_ON_LINE.test(text) || /\bGST\s*IN\b/i.test(text);
    const textWithoutGstin = carriesGstin
      ? text.replace(/\bGST\s*(?:IN)?\b\s*[:\-.]?\s*[0-9A-Za-z]{15}\b/ig, ' ').replace(/\s{2,}/g, ' ').trim()
      : text;
    if (carriesGstin && !textWithoutGstin) continue;
    // Contact detection and address assembly both run against the GSTIN-free
    // text, so a phone printed beside a GSTIN is still found.
    const probe = carriesGstin ? { ...line, clean: textWithoutGstin } : line;
    const probeText = probe.clean;
    // Invoice metadata and payment instructions are printed inside the same
    // header region on a two-column layout, but they are not the party's postal
    // address. "Invoice No: …", "Mode/Terms of Payment: Cash", "Buyer's Order
    // No: …" and the bank block all have to stay out of it.
    if (isReferenceLabel(probeText)) continue;
    if (TOTALS_LINE.test(probeText) || PAYMENT_SECTION.test(probeText)) continue;
    if (/\bbank\b|\bifsc\b|\ba\s*\/?\s*c\b|account\s*(?:no|number)|\bbeneficiary\b/i.test(probeText)) continue;
    if (/^(?:www\.?|https?:\/\/|website|web\s*site|url)\b/i.test(probeText)) continue;
    if (/^(?:fax|pan|vat|bank)\b/i.test(probeText)) continue;

    if (!result.phone.value) {
      const hit = findLabeledValue([probe], PHONE_LABELS, { limit: 1 });
      if (hit) {
        const value = normalizePhone(hit.raw);
        if (value) {
          result.phone = field(value, Math.min(0.97, (line.confidence || 0) / 100 + 0.05), 'phone-label');
          continue;
        }
      }
      if (!result.phone.value && /^\s*(?:ph|phone|mob|mobile|tel)\b/i.test(probeText)) {
        const value = normalizePhone(probeText);
        if (value) { result.phone = field(value, 0.8, 'phone-label'); continue; }
      }
    }
    if (!result.email.value) {
      const email = findEmail(probeText);
      if (email) {
        result.email = field(email, Math.min(0.98, (line.confidence || 0) / 100 + 0.06), 'email-pattern');
        continue;
      }
    }
    if (!result.contactPerson.value) {
      const hit = findLabeledValue([line], CONTACT_PERSON_LABELS, { limit: 1 });
      if (hit) {
        const value = collapseSpaces(hit.raw).replace(/[,;]$/, '');
        // "For Bluechip Computer System" is a company, not a person.
        const looksLikePerson = /^[A-Za-z][A-Za-z.'\s-]{2,40}$/.test(value)
          && !/\b(pvt|ltd|llp|inc|company|enterprises|systems|solutions|store|shop|dealer|traders|industries|s\.?a)\b/i.test(value);
        if (looksLikePerson && value.split(/\s+/).length >= 2) {
          result.contactPerson = field(value, Math.min(0.9, (line.confidence || 0) / 100 + 0.05), 'contact-label');
          continue;
        }
      }
    }
    // "State Name: Gujarat, Code: 24" is one very common way to print the state, and
// the label sits in the middle of the sentence. Reading it as "Name: Gujarat,
// Code: 24" put a whole sentence in the State box, so the label, the trailing
// "Code: 24" and the comma all have to come off before the name is left.
const STATE_LABEL_RE = /^\s*state(?:\s*(?:name|code))?\s*[:\-.]?\s*/i;

if (!result.state.value && STATE_LABEL_RE.test(probeText)) {
      const codeMatch = probeText.match(/code\s*[:\-.]?\s*(\d{1,2})\b/i);
      const printed = collapseSpaces(probeText.replace(STATE_LABEL_RE, ''))
        .replace(/,?\s*code\s*[:\-.]?\s*\d{1,2}\s*$/i, '')
        .replace(/[,;]\s*$/, '')
        .trim();
      const fromCode = codeMatch ? GST_STATE_CODES[codeMatch[1].padStart(2, '0')] : null;
      const name = (printed && printed.length <= 40) ? printed : (fromCode || null);
      if (name) {
        result.state = field(name, printed ? 0.92 : 0.85, printed ? 'state-label' : 'state-code-label');
        continue;
      }
    }
    if (!result.city.value && /^(?:city|town|district)\b/i.test(probeText)) {
      const value = collapseSpaces(probeText.replace(/^(?:city|town|district)\b\s*[:\-.]?\s*/i, ''));
      if (value && value.length <= 40) { result.city = field(value, 0.9, 'city-label'); continue; }
    }
    addressLines.push(probe);
  }

  if (addressLines.length) {
    const addressText = addressLines
      .map((l) => l.clean)
      // A GSTIN or state code printed alongside other text still has to go.
      .map((t) => stripStateCodeFromText(stripGstinFromText(t)))
      .join(', ')
      .replace(/\s{2,}/g, ' ')
      .replace(/(,\s*)+$/, '')
      .replace(/(^|,\s*),\s*/g, '$1')
      .replace(/\s*,\s*,/g, ',')
      .trim();
    if (addressText) {
      const confidences = addressLines.map((l) => (l.confidence || 0) / 100);
      const mean = confidences.reduce((s, c) => s + c, 0) / confidences.length;
      result.address = field(addressText, Math.min(0.95, mean * 0.98), 'party-block');

      // Pincode must be a real six-digit pincode. "Vadodara-07" is a district
      // code and is left alone rather than being turned into a pincode.
      const pincode = findPincode(addressText);
      if (pincode) result.pincode = field(pincode, 0.93, 'address-pattern');
      if (!result.city.value) {
        const cityMatch = addressText.match(/(?:^|,\s*)([A-Za-z][A-Za-z .'-]{2,30}?)\s*(?:-\s*\d{1,2})?\s*$/);
        const candidate = cityMatch ? collapseSpaces(cityMatch[1]) : null;
        // A state name is not a city, and neither is a bare "India".
        const stateNames = new Set(Object.values(GST_STATE_CODES).map((s) => s.toLowerCase()));
        const isUsable = candidate
          && !stateNames.has(candidate.toLowerCase())
          && !/^(?:india|gujarat|guj|state|country)$/i.test(candidate)
          && candidate.length >= 3;
        if (isUsable) result.city = field(candidate, 0.7, 'address-pattern');
      }
      if (!result.state.value && stateFromGstin) {
        result.state = field(stateFromGstin, 0.75, 'gstin-state-code');
      }
    }
  }

  result.warnings = warnings;
  return result;
}

/**
 * Reads the company whose name heads the document — the issuer. On a purchase
 * invoice this is the supplier; on one of our own sales invoices it is us, which
 * the caller must be told about rather than silently turned into the supplier.
 */
function readHeaderIssuer(lines, table) {
  const limit = table ? Math.min(lines.length, table.headerIndex) : Math.min(lines.length, 24);
  const headerLines = lines.slice(0, limit);
  if (!headerLines.length) return null;

  // A letterhead puts the company's name first; everything after it is address,
  // phone, email and GSTIN. OCR word boxes are not reliable enough to rank by
  // height alone — a long address line often comes out "taller" than the name —
  // so the topmost line that could be a company name wins, with height only
  // breaking ties on the same row.
  const isTitleLine = (text) => isDocumentTitle(text);
  const isDetailLine = (text) => (
    GSTIN_ON_LINE.test(text)
    || /^(?:gstin|gst|phone|ph\b|mob|mobile|tel|email|e-?mail|web|website|fax|pan|vat|state|city|pin|pincode|post\s*code)\b/i.test(text)
    || findEmail(text)
    || (looksLikePhone(text) && text.replace(/\D/g, '').length >= 10)
    || TOTALS_LINE.test(text)
    || PAYMENT_SECTION.test(text)
    // An invoice reference printed at the top of the page — "Invoice No. 22" —
    // is a label, not a company. Without this the topmost line wins and the
    // issuer is read as "Invoice No. 22", which then matches no company at all.
    || isReferenceLabel(text)
  );

  const candidates = [];
  for (let i = 0; i < limit; i += 1) {
    const line = headerLines[i];
    const text = cleanLine(line.text);
    if (!text) continue;
    if (TOTALS_LINE.test(text) || PAYMENT_SECTION.test(text)) break;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    if (letters < 3) continue;
    if (isDetailLine(text)) continue;
    // A line that is only a role heading ("Bill To", "Consignee") names a
    // section, not the company in it.
    if (!stripRoleWords(text)) continue;
    const words = text.split(/[\s,]+/).filter((w) => /[A-Za-z]/.test(w)).length;
    candidates.push({
      line,
      index: i,
      text,
      height: lineHeight(line),
      top: lineCenterY(line),
      nameScore: isTitleLine(text) ? 0 : words,
    });
  }

  const usable = candidates.filter((c) => !isTitleLine(c.text));
  const pool = usable.length ? usable : candidates;
  if (!pool.length) return null;

  const top = Math.min(...pool.map((c) => c.top));
  // The top-most company name sits on its own printed row, but OCR often splits
  // one letterhead band into a pair of lines ("CIRIENT)" then "[mATESHwAR Some")
  // whose centres are only a few pixels apart. The row window is therefore wider
  // than a single line box, so fragments of the same band compete on word count
  // — but it must not reach the NEXT printed row: an address ("Shop 12, Tilak
  // Road…") holds more words than a company name and would steal the name.
  const topRow = pool.filter((c) => c.top <= top + 6);
  const chosen = topRow.reduce((best, c) => (c.nameScore > best.nameScore || (c.nameScore === best.nameScore && c.height > best.height) ? c : best), topRow[0]);

  const gstin = gstinIn(headerLines);
  // Everything under the name that still belongs to the letterhead. The window
  // starts at the name itself — a header that opens with "Tax Invoice" and
  // "Invoice No. 22" must not have its letterhead cut off before the company
  // name is even reached — and runs down to the first sign of a different
  // section, so a supplier block with its address, phone, email and GSTIN is
  // never cut short.
  const issuerLines = [];
  const nameBottom = lineCenterY(chosen.line);
  // A name printed in the right-hand column shares its row with the left-hand
  // one, so anything on the same visual row belongs to the same letterhead.
  let start = chosen.index;
  while (start > 0 && sameRow(headerLines[start - 1], chosen.line)) start -= 1;

  // Determine the page midpoint to separate left-column (issuer) from
  // right-column (invoice metadata). Use the chosen name line's right edge
  // as a proxy when page width is unavailable.
  const pageWidth = chosen.line.pageWidth || 0;
  const issuerRight = chosen.line.bbox?.x1 ?? 0;
  // The split point: anything starting past this x is invoice metadata, not issuer.
  // We use 55% of page width, or the issuer name's right edge + 20px, whichever is larger.
  const splitX = pageWidth > 100
    ? Math.max(issuerRight + 20, pageWidth * 0.55)
    : (issuerRight > 0 ? issuerRight + 20 : Infinity);

  for (let i = start; i < limit; i += 1) {
    const line = headerLines[i];
    const text = cleanLine(line.text);
    if (i > start) {
      if (lineCenterY(line) > nameBottom + medianLineHeight(headerLines) * 12) break;
      // A new party section really does end the letterhead.
      if (hasAnyLabel(text, SELLER_LABELS) || hasAnyLabel(text, BUYER_LABELS)) break;
      if (TOTALS_LINE.test(text) || PAYMENT_SECTION.test(text)) break;
      // Skip invoice metadata lines (right column) — they are not part of the issuer.
      if (isReferenceLabel(text)) continue;
      // Skip lines that start in the right column (invoice metadata region).
      const lineX0 = line.bbox?.x0 ?? 0;
      if (lineX0 > splitX && !sameRow(chosen.line, line)) continue;
    }
    issuerLines.push(line);
  }
  if (!issuerLines.length) issuerLines.push(chosen.line);

  // The chosen line may still carry the invoice metadata OCR read into the same
  // line ("JBR SOLUTIONS   Invoice No.   Dated"). The company's name ends where
  // the first other label on that line begins.
  const issuerNameText = firstCell(chosen.line.text && chosen.line.text.indexOf('  ') >= 0
    ? chosen.line.text
    : collapseSpaces(chosen.text));

  return {
    name: firstCell(issuerNameText).replace(/[,;]$/, ''),
    nameLine: chosen.line,
    nameHeight: chosen.height,
    gstin: gstin ? validateGstin(gstin.raw) : null,
    party: extractPartyFromBlock(issuerLines, { roleLabel: 'issuer' }),
    // The exact lines the letterhead spans. The label-less buyer scan uses this
    // to exclude the issuer's own block from its search, so a supplier's
    // letterhead can never double as buyer evidence.
    lines: issuerLines,
  };
}

// ── Items ────────────────────────────────────────────────────────────────────

function parseItemRows(lines, table, allTables = [table]) {
  const items = [];
  if (!table) return items;

  const { columns } = table;
  const numericKeys = NUMERIC_KEYS.filter((k) => columns.some((c) => c.key === k));

  // The region ends where the totals block starts, at the next repeated table
  // header, or at the end of the page.
  let end = lines.length;
  for (let i = table.headerIndex + 1; i < lines.length; i += 1) {
    if (allTables.some((other) => other !== table && other.headerIndex === i)) { end = i; break; }
    const text = cleanLine(lines[i].text);
    if (!text) continue;
    if (TOTALS_LINE.test(text) || PAYMENT_SECTION.test(text) || ITEM_TABLE_STOP_RE.test(text)) { end = i; break; }
    if (i > table.headerIndex + 1 && lineCenterY(lines[i]) < lineCenterY(lines[table.headerIndex]) - lineHeight(lines[table.headerIndex])) {
      // Back above the header on a new page — the table is over.
      end = i; break;
    }
  }

  let current = null;

  for (let i = table.headerIndex + 1; i < end; i += 1) {
    const line = lines[i];
    if (!line.words || !line.words.length) continue;
    const text = cleanLine(line.text);
    if (!text) continue;
    if (TOTALS_LINE.test(text) || PAYMENT_SECTION.test(text)) break;
    // A line that is only a tax label (CGST, SGST, IGST) belongs to the
    // tax summary, never to the item table — even when it appears before
    // the totals line because the invoice prints them inside the table grid.
    if (TAX_LABEL_ONLY_RE.test(text)) continue;

    const buckets = assignToColumns(line, columns);
    // A tax summary row can sit inside the table grid, printed as
    // "casT]|  9%  103.50 |". Its description cell then holds exactly the tax
    // label, which OCR mangles ("casT]" for CGST, "sesT|" for SGST). A product
    // name is never a single token like that, so the row is recognised by the
    // description cell alone and skipped before it becomes a phantom item.
    if (isTaxLabelRow(buckets, text)) continue;
    const hasNumbers = rowHasNumbers(buckets, numericKeys);
    if (process.env.OCR_TRACE) {
      console.log(`[trace] i=${i} hasNumbers=${hasNumbers} text=${JSON.stringify(text)} buckets=`, Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.text])));
    }

    // ── A description is a set of words, not a set of OCR lines ──
    //
    // A printed row carries the product text, the HSN, the quantity, the rate and
    // the amount on ONE OCR line. Reading the line therefore handed the HSN and
    // the amount to the product name, and a continuation line that held only
    // product text was read whole even when part of it sat outside the
    // description column. The column geometry decides ownership instead: only
    // words whose centre falls inside the description column belong here.
    const descColumn = columns.find((c) => c.key === 'desc');
    const descWords = descColumn
      ? (line.words || [])
        .filter((w) => w.bbox && w.bbox.x0 >= descColumn.x0 - 1 && w.bbox.x0 < descColumn.x1)
        .filter((w) => String(w.text || '').trim())
        .map((w) => ({
          text: String(w.text).trim(),
          centerX: w.bbox.x0,
          centerY: lineCenterY(line),
          // "Serial No:", "Warranty:" and friends are attributes, not part of the
          // product name; the name is rebuilt from the description column only.
          fromAttrLine: ATTR_LINE_RE.test(cleanLine(line.text)),
        }))
      : [];

    if (hasNumbers) {
      current = {
        rawRowText: text,
        confidence: (line.confidence || 0) / 100,
        // Whether these cells came out of a PDF text layer or out of OCR matters
        // for serials: see the serial confidence cap below.
        ocr: line.source ? line.source !== 'pdf-text' : false,
        descLines: [],
        descWords,
        attributes: {},
        cells: buckets,
        lineIndexes: [i],
      };
      items.push(current);
    } else if (current) {
      // A description (or one of its details) continuing onto the next line. The
      // full printed line is kept: a serial or warranty VALUE is often printed
      // wider than the description column itself ("Serial No: W3N0RJ…" reads to
      // the right of the heading), so the description cell alone would truncate
      // it. The line can only have reached this branch because it is prose, not
      // a numbered item row.
      const descText = line.text.replace(/^\s*\d{1,3}\s*[.)-]?\s*/, '');
      current.descLines.push({ text: descText, line });
      current.descWords = current.descWords.concat(descWords);
      current.lineIndexes.push(i);
    }
  }

  // A line of figures with no product text in it is the summary, not a purchase
  // line. Amounts such as "2,350.00" now parse as numbers, so a tax-summary line
  // can look like an item row; without this it was added as a phantom line with a
  // quantity and an amount but nothing to buy.
  const priced = items
    .filter((raw) => (raw.descWords || []).some((w) => String(w.text || '').trim()));

  // How this table writes its money, decided once from every row. An invoice
  // prints its amounts one way throughout ("1200.00", or "1,200.00"), so one
  // unambiguous row settles the shape for the whole table.
  const moneyCells = priced.flatMap((raw) => ['rate', 'total', 'taxable']
    .map((key) => raw.cells?.[key]?.text)
    .filter((t) => t && collapseSpaces(t)));
  const plainDecimals = moneyCells.filter((t) => /^\d+(?:\.\d{1,2})?$/.test(collapseSpaces(t))).length;
  const thousandsDecimals = moneyCells.filter((t) => /^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(collapseSpaces(t))).length;
  // A rate printed "1.150.00" can only be 1,150.00 if this table otherwise writes
  // plain decimals. If the table already uses comma grouping, the two-dot token is
  // a misread of something else and is left alone.
  const thousandsLookalike = plainDecimals > 0 && plainDecimals >= thousandsDecimals;

  return priced.map((raw) => finalizeItem(raw, columns, { thousandsLookalike }));
}

/**
 * Reads every item region in the document and merges them into one list.
 *
 * A multi-page invoice prints the table header again on each page, and each of
 * those regions has its own column geometry — so the regions are parsed
 * separately and only then joined. Overlapping regions (a "continued" table that
 * repeats a header without new items) are de-duplicated on line position.
 */
function parseAllItems(lines, tables) {
  if (!tables || !tables.length) return [];
  const seenRows = new Set();
  const merged = [];
  for (const table of tables.slice().sort((a, b) => a.headerIndex - b.headerIndex)) {
    for (const item of parseItemRows(lines, table, tables)) {
      const key = item.lineIndexes?.join(',');
      if (key && seenRows.has(key)) continue;
      if (key) seenRows.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/** Reads one collected row into the item the purchase form understands. */
function finalizeItem(raw, columns, options = {}) {
  const has = (key) => columns.some((c) => c.key === key);
  const cell = (key) => (raw.cells[key]?.text ? collapseSpaces(raw.cells[key].text) : null);
  const cellConfidence = (key) => (raw.cells[key]?.confidence ?? 0);

  const descriptions = [];
  const attributes = {};
  const serials = [];
  const notes = [];

  // The row's own description cell comes first, followed by any lines that
// continued underneath it.
const descriptionEntries = [];
if (collapseSpaces(raw.cells.desc?.text || '')) {
  descriptionEntries.push({ text: raw.cells.desc.text });
}
for (const entry of raw.descLines) descriptionEntries.push(entry);

let lastAttributeKey = null;
for (const entry of descriptionEntries) {
    const text = collapseSpaces(entry.text);
    if (!text) continue;
    let matchedAttribute = false;
    for (const attribute of DESCRIPTION_ATTRIBUTES) {
      const m = text.match(attribute.match);
      if (!m) continue;
      // A bare "6 MONTH WARRANTY" states the warranty in the words themselves, so
      // when nothing follows the label the whole line is the value. Without this
      // the empty capture made the line look unmatched, and the warranty went
      // back into the product name.
      let value = collapseSpaces(m[1]).replace(/[,;]$/, '');
      if (!value && attribute.fallbackToLine) value = collapseSpaces(text).replace(/[,;]$/, '');
      if (!value) continue;
      attributes[attribute.key] = attributes[attribute.key]
        ? `${attributes[attribute.key]}, ${value}`
        : value;
      if (attribute.key === 'serial') {
        for (const serial of splitSerials(value)) serials.push(serial);
      }
      lastAttributeKey = attribute.key;
      matchedAttribute = true;
      break;
    }
    if (matchedAttribute) continue;
    // The tail of a serial list that wrapped onto its own line.
    if (lastAttributeKey === 'serial' && looksLikeSerialList(text)) {
      for (const serial of splitSerials(text)) serials.push(serial);
      attributes.serial = attributes.serial ? `${attributes.serial}, ${text}` : text;
      continue;
    }
    // The row number column is not part of the description.
    const stripped = text.replace(/^\s*\d{1,3}\s*[.)-]\s*/, '').trim();
    if (stripped) descriptions.push(stripped);
    lastAttributeKey = null;
  }

  // The product name is the whole description block, not just its first line. An
// invoice that prints
//
//     LAPTOP ACCESSORIES PARTS
//     ASUS E2N17V25 ORG BATTERY
//
// describes one product in two lines, and the second half is what makes the
// description searchable against the product database. Taking only the first
// line produced two items that were both called "LAPTOP ACCESSORIES PARTS".
  // When the column geometry is available the product name is rebuilt from the
  // description column's own words, so that nothing printed in a neighbouring
  // column on the same OCR line can reach it. The words are put back in reading
  // order first: visual row top to bottom, then left to right inside the row.
  const wordDescription = raw.descWords && raw.descWords.length
    ? (() => {
      const rows = [];
      for (const w of raw.descWords
        .filter((word) => !word.fromAttrLine)
        .slice()
        .sort((a, b) => a.centerY - b.centerY || a.centerX - b.centerX)) {
        const last = rows[rows.length - 1];
        if (last && Math.abs(w.centerY - last.centerY) <= 6) last.push(w);
        else rows.push([w]);
      }
      return rows.map((r) => r.sort((a, b) => a.centerX - b.centerX).map((w) => w.text).join(' ')).join(' ');
    })()
    : '';

  const itemName = (wordDescription || descriptions.join(' '))
    .replace(/\s{2,}/g, ' ')
    .replace(/(?:\s*-\s*)+$/, '')
    .replace(/[.,;:]\s*$/, '')
    .trim();
  if (attributes.model) notes.push(`Model No: ${attributes.model}`);
  if (attributes.partNo) notes.push(`Part No: ${attributes.partNo}`);
  if (attributes.warranty) notes.push(`Warranty: ${attributes.warranty}`);
  if (attributes.checkNo) notes.push(`Check No: ${attributes.checkNo}`);

  const warnings = [];
  let confidence = raw.confidence || 0.8;

  const qtyRaw = has('qty') ? cell('qty') : null;
  // A printed quantity is often "1 nos" or "2 pcs" on one line. The count is the
  // number; the trailing token is the unit of measure, and it is reported as
  // such rather than being read as part of the count.
  // `cell()` returns the parsed value when it has one, so the cell's own text is
  // read back from the bucket instead of assuming its shape.
  const qtyCellParts = qtyRaw && qtyRaw.text !== undefined
    ? String(qtyRaw.text).trim().split(/\s+/).filter(Boolean)
    : (qtyRaw ? String(qtyRaw).trim().split(/\s+/).filter(Boolean) : []);
  // The count is the numeric token; a trailing word in the same cell ("1 nos") is
  // the unit and is reported as the unit, not swallowed into the count. When the
  // cell holds only the unit word, that word is the unit and there is no count.
  const qtyNumberText = qtyCellParts.find((t) => cellNumber(t) !== null) || null;
  const qtyTrailingUnit = qtyCellParts.slice(1).find((t) => /^[A-Za-z.]{1,6}$/.test(t)) || null;
  const qtyUnitOnlyText = qtyNumberText === null && qtyTrailingUnit ? qtyTrailingUnit : null;
  let quantity = qtyNumberText !== null ? cellNumber(qtyNumberText) : null;
  let quantityConfidence = cellConfidence('qty');

  // A cell may hold a value plus a stray glyph OCR picked up from the printed rule
// ("1.150.00", "1,160.00\""). The cell is a number as a whole once that trailing
// debris is set aside; reading only the leading numeric run recovers it without
// altering the digits OCR actually saw.
  // Whether a two-dot token in this row may be read as comma-grouped thousands is
  // decided by the row's OTHER money cells: if the amount column printed a plain
  // decimal amount ("1200.00"), then a rate reading "1.150.00" is the same shape
  // with one separator misread, and not a rate of 1.15.
  const thousandsLookalike = options.thousandsLookalike === true;

  const rateRaw = has('rate') ? cell('rate') : null;
  // The cell is read from its own text: `cellNumber` is handed the string, not the
  // bucket, so it cannot truncate "1.150.00" to its leading digit.
  const rateText = rateRaw ? collapseSpaces(rateRaw.text ?? rateRaw) : '';
  let unitRate = rateRaw ? (cellNumber(rateText) ?? leadingNumber(rateText)) : null;
  let rateConfidence = cellConfidence('rate');

  const taxableRaw = has('taxable') ? cell('taxable') : null;
  const taxableValue = taxableRaw ? cellNumber(taxableRaw) : null;

  const totalRaw = has('total') ? cell('total') : null;
  const totalText = totalRaw ? collapseSpaces(totalRaw.text ?? totalRaw) : '';
  const lineTotal = totalRaw ? (cellNumber(totalText) ?? leadingNumber(totalText)) : null;

  // CGST + SGST + IGST rates and amounts for this line.
  const pct = (key) => (has(key) && isNumericCell(cell(key)) ? parsePercent(cell(key)) : null);
  const amt = (key) => (has(key) ? cellNumber(cell(key)) : null);
  const cgstRate = pct('cgstPct');
  const sgstRate = pct('sgstPct');
  const igstRate = pct('igstPct');
  const utgstRate = pct('utgstPct');
  const cgstAmount = amt('cgstAmt');
  const sgstAmount = amt('sgstAmt');
  const igstAmount = amt('igstAmt');
  const utgstAmount = amt('utgstAmt');

  const declaredRate = round2((cgstRate ?? 0) + (sgstRate ?? 0) + (igstRate ?? 0) + (utgstRate ?? 0)) || null;

  // Quantity: if the invoice omitted it but the money adds up, it can be derived
  // — flagged, because a derived quantity must be checked before saving.
  if (quantity === null && taxableValue && unitRate && unitRate > 0) {
    const derived = taxableValue / unitRate;
    if (Number.isFinite(derived) && derived > 0 && derived < 100000) {
      quantity = Math.round(derived * 1000) / 1000;
      quantityConfidence = 0.55;
      warnings.push('Quantity was derived from rate and taxable value — please verify');
    }
  }
  if (quantity === null) {
    quantity = 1;
    quantityConfidence = 0.4;
    warnings.push('Quantity was not readable — defaulted to 1, please verify');
  }

  // Rate: the pre-tax unit rate. The tax-inclusive "Amount" column is never used
  // as a rate — it is divided back down instead, so inventory and GST stay right.
  if (unitRate === null && taxableValue && quantity) {
    unitRate = round2(taxableValue / quantity);
    rateConfidence = 0.6;
    warnings.push('Rate was derived from the taxable value — please verify');
  }
  if (unitRate === null && lineTotal !== null && declaredRate) {
    const netOfTax = round2(lineTotal / (1 + declaredRate / 100));
    unitRate = round2(netOfTax / quantity);
    rateConfidence = 0.45;
    warnings.push('Rate was derived from the tax-inclusive amount — please verify');
  }
  if (unitRate === null) {
    unitRate = null;
    rateConfidence = 0;
  }

  // A printed rate that disagrees with qty × rate = taxable value.
  if (unitRate && taxableValue && quantity) {
    const expected = round2(unitRate * quantity);
    if (Math.abs(expected - taxableValue) > 1 && Math.abs(expected - taxableValue) / Math.max(1, taxableValue) > 0.005) {
      warnings.push('Rate and taxable value on the invoice do not agree — please verify');
      rateConfidence = Math.min(rateConfidence, 0.7);
    }
  }

  if (serials.length > quantity) {
    warnings.push(`${serials.length} serial numbers were read for a quantity of ${quantity} — please verify`);
  }
  if (!itemName) warnings.push('Item name could not be read');

  const item = {
    lineNo: 0,
    itemName: itemName ? field(itemName, Math.min(0.98, confidence), 'item-table') : missing('Item name could not be read'),
    quantity: quantity === null ? missing() : field(quantity, quantityConfidence, has('qty') ? 'qty-column' : 'derived', warnings),
    unitRate: unitRate === null ? missing('Rate could not be read') : field(round2(unitRate), rateConfidence, has('rate') ? 'rate-column' : 'derived', warnings),
    hsnCode: has('hsn') && cell('hsn')
      ? field(collapseSpaces(cell('hsn')).replace(/[^0-9A-Za-z/\-.]/g, ''), cellConfidence('hsn'), 'hsn-column')
      // HSN is left blank unless it is actually printed — never invented.
      : missing('HSN not printed on the invoice'),
    // A serial is only ever reported from a "Serial No: …" line under a product.
    // OCR's classic 0/O, 1/I, 5/S confusions are never "corrected" here — a wrong
    // serial silently corrupts inventory — so a serial that was read by OCR is
    // deliberately held below the "trusted" band and shown for confirmation,
    // because a single mis-read character cannot be detected from the page.
    serials: serials.map((value) => field(
      value,
      raw.ocr ? Math.min(0.93, confidence * 0.95) : Math.min(0.98, confidence),
      'description-attribute',
      raw.ocr ? ['Serial numbers read by OCR are always shown for verification'] : [],
    )),
    gstRate: declaredRate ? field(declaredRate, Math.min(0.95, confidence), 'tax-columns') : null,
    cgstRate: cgstRate === null ? null : field(cgstRate, cellConfidence('cgstPct'), 'tax-columns'),
    sgstRate: sgstRate === null ? null : field(sgstRate, cellConfidence('sgstPct'), 'tax-columns'),
    igstRate: igstRate === null ? null : field(igstRate, cellConfidence('igstPct'), 'tax-columns'),
    taxableValue: taxableValue === null ? null : field(taxableValue, cellConfidence('taxable'), 'taxable-column'),
    cgstAmount: cgstAmount === null ? null : field(cgstAmount, cellConfidence('cgstAmt'), 'tax-column'),
    sgstAmount: sgstAmount === null ? null : field(sgstAmount, cellConfidence('sgstAmt'), 'tax-column'),
    igstAmount: igstAmount === null ? null : field(igstAmount, cellConfidence('igstAmt'), 'tax-column'),
    lineAmount: lineTotal === null ? null : field(lineTotal, cellConfidence('total'), 'amount-column'),
    notes,
    warnings: [...warnings],
    lineIndexes: raw.lineIndexes,
    confidence: Number(Math.min(1, confidence).toFixed(3)),
  };
  return item;
}

/**
 * Fallback for invoices whose table header could not be identified: a numbered
 * list of "1  Laptop … 1  5000  5000". It is deliberately conservative — a line
 * has to look like an item row before it is accepted.
 */
function parseItemRowsLoose(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = collapseSpaces(lines[i].text);
    if (!text) continue;
    if (TOTALS_LINE.test(text)) break;
    const m = text.match(/^\s*(\d{1,2})\s*[.)-]?\s+(.{2,60}?)\s+((?:[\d,]+(?:\.\d{1,2})?\s+){2,5})[\d,]*\.?\d*\s*$/);
    if (!m) continue;
    const numbers = m[3].trim().split(/\s+/).map(parseAmount).filter((n) => n !== null);
    if (numbers.length < 2) continue;
    const quantity = numbers[0];
    const unitRate = numbers[1];
    if (!(quantity > 0) || !(unitRate > 0)) continue;
    items.push({
      itemName: field(collapseSpaces(m[2]), (lines[i].confidence || 0) / 100, 'loose-row'),
      quantity: field(quantity, (lines[i].confidence || 0) / 100, 'loose-row'),
      unitRate: field(round2(unitRate), (lines[i].confidence || 0) / 100, 'loose-row'),
      hsnCode: missing('HSN not printed on the invoice'),
      serials: [],
      gstRate: null,
      taxableValue: null,
      lineAmount: null,
      notes: [],
      warnings: [],
      confidence: Number(((lines[i].confidence || 0) / 100).toFixed(3)),
    });
  }
  return items;
}

// ── Totals, tax summary and payment ──────────────────────────────────────────

const LABELLED_TOTAL_LABELS = [
  { key: 'taxableValue', match: /\btotal\s*taxable(?:\s*value)?\b/i },
  { key: 'taxableValue', match: /\btotal\s*taxable\s*value\b/i },
  // "Total" with no qualifier is the invoice's grand total when it is the last
  // such row on the page and nothing more specific claimed it. It is listed
  // after the specific labels so it can only fill a field nothing else filled,
  // and the amount it takes is the row's last number - the printed grand total
  // sits in the row's rightmost cell.
  { key: 'grandTotal', match: /\b(?:grand\s*total|invoice\s*total|total\s*(?:invoice\s*value|amount|payable|value)|net\s*amount|amount\s*payable)\b/i },
  { key: 'grandTotal', match: /^\s*[-|_]?\s*total\b/i },
  { key: 'cgstAmount', match: /\btotal\s*cgst\b/i },
  { key: 'sgstAmount', match: /\btotal\s*sgst\b/i },
  { key: 'igstAmount', match: /\btotal\s*igst\b/i },
  // "Total CGST" / "Total SGST" are the two halves of the tax, not the total —
  // so this deliberately matches only a real tax total.
  { key: 'totalTax', match: /\b(?:total\s*tax|tax\s*total|total\s*gst|total\s+tax\s*amount)\b/i },
  { key: 'roundOff', match: /\bround\s*off\b/i },
];

// The JBR invoice prints a tax summary table at the bottom:
//   HSN/SAC | Taxable Value | Central Tax Rate | Amount | State Tax Rate | Amount | Total Tax Amount
// The "Total" row of that table carries the grand taxable value and tax amounts.
// This regex matches that "Total" row so the amounts can be read from it.
// A summary row's "Total" label is printed among other cells, so it rarely
// stands alone as "Total" - here it reads "Total | _:Znos | 2,773.00", and the
// tax table's row reads "- Total 2,350.00) 211.50 211.50 423.0". Requiring the
// label to be the entire line therefore matched nothing and every total came
// back empty. The label now only has to come first on the line.
const TAX_SUMMARY_TOTAL_RE = /^\s*[-|_]?\s*total\b/i;

function extractTotals(lines, fromIndex) {
  const totals = {};
  const start = fromIndex || 0;
  for (let i = start; i < lines.length; i += 1) {
    const text = cleanLine(lines[i].text);
    if (!text) continue;

    // ── Tax summary table "Total" row (JBR-style bottom table)
    // The row looks like: "Total  2350.00  211.50  211.50  423.00"
    // We extract: taxableValue, cgstAmount, sgstAmount, totalTax from the numbers.
    if (TAX_SUMMARY_TOTAL_RE.test(text) && lines[i].words && lines[i].words.length >= 3) {
      const nums = lines[i].words
        .map((w) => parseAmount(w.text))
        .filter((n) => n !== null && n > 0);
      // Expect at least: taxable, cgst-amount, sgst-amount [, total-tax]
      if (nums.length >= 3) {
        const conf = Math.min(0.95, (lines[i].confidence || 0) / 100 + 0.05);
        if (!totals.taxableValue) totals.taxableValue = field(round2(nums[0]), conf, 'tax-summary-table');
        if (!totals.cgstAmount) totals.cgstAmount = field(round2(nums[1]), conf, 'tax-summary-table');
        if (!totals.sgstAmount) totals.sgstAmount = field(round2(nums[2]), conf, 'tax-summary-table');
        if (!totals.totalTax && nums[3] !== undefined) totals.totalTax = field(round2(nums[3]), conf, 'tax-summary-table');
      }
    }

    for (const label of LABELLED_TOTAL_LABELS) {
      const key = label.key;
      if (totals[key] && totals[key].value !== null) continue;
      const m = text.match(label.match);
      if (!m) continue;
      let rest = text.slice(m.index + m[0].length).trim();
      let value = parseAmount(rest);
      let confidence = (lines[i].confidence || 0) / 100;
      if (value === null) {
        // The amount sits in the next cell, to the right, or on the next line.
        const next = lines[i + 1];
        if (next && lineCenterY(next) - lineCenterY(lines[i]) < lineHeight(lines[i]) * 2.5) {
          const nextValue = parseAmount(cleanLine(next.text).replace(/^[\d.,\s\u20b9]*$/, (s) => s));
          if (nextValue !== null) { value = nextValue; confidence = (next.confidence || 0) / 100; }
        }
      }
      if (value === null) {
        const amountMatch = rest.match(/[\d][\d,]*\.?\d*/);
        if (amountMatch) value = parseAmount(amountMatch[0]);
      }
      // A summary row prints several numbers in separate cells - "Total |
      // _:Znos | 2,773.00". The first is an HSN or a struck-through figure, so
      // the total is the row's LAST number, which is the one in its rightmost
      // cell.
      if (key === 'grandTotal') {
        const all = rest.match(/[\d][\d,]*\.?\d*/g);
        if (all && all.length) {
          const last = parseAmount(all[all.length - 1]);
          if (last !== null) value = last;
        }
      }
      if (value === null) continue;
      totals[key] = field(round2(value), Math.min(0.97, confidence + 0.05), 'totals-block');
    }
  }
  return totals;
}

const PAYMENT_MODE_RE = /\b(?:upi|cash|card|credit\s*card|debit\s*card|net\s*banking|bank\s*transfer|rtgs|neft|imps|cheque|check|cheq|demand\s*draft|dd|online|payment\s*gateway|finance|emi)\b/i;

/**
 * The name printed in the bank-details block ("Account Holders Name: …").
 * The letterhead is OCR's noisiest region, but the bank block is set in plain
 * caps and reads cleanly even when its label is mangled ("ue Holders Namie:").
 */
function extractBankHolderName(lines) {
  let value = null;
  for (const line of lines) {
    const text = cleanLine(line.text || '');
    if (!/holder/i.test(text)) continue;
    const colon = text.indexOf(':');
    const rest = colon >= 0 ? text.slice(colon + 1) : (text.match(/nam(?:ie|e|o)?\.?\s*(.+)$/i) || [])[1];
    if (!rest) continue;
    const cleaned = collapseSpaces(rest).replace(/[.]+$/, '').replace(/[|,\]]+$/, '').trim();
    if (!cleaned) continue;
    const letters = cleaned.replace(/[^A-Za-z]/g, '');
    if (letters.length < 3) continue;
    // A second copy of the label inside the value means the split missed.
    if (!/holder\s*name/i.test(cleaned)) { value = cleaned; break; }
  }
  return value;
}

/**
 * The words of a printed cheque-style amount: "One Thousand Three Hundred Fifty
 * Seven Only". Returns null the moment an unrecognised token appears, so a value
 * is never invented from a half-matched sentence.
 */
const WORD_NUM = Object.freeze({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});
const WORD_SCALE = Object.freeze({
  hundred: 100, thousand: 1000, lakh: 100000, lac: 100000, crore: 10000000,
  million: 1000000, billion: 1000000000,
});
function readAmountInWords(text) {
  const tokens = collapseSpaces(text).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  for (const token of tokens) {
    if (token === 'and' || token === 'only' || token === 'rupees' || token === 'paise' || token === 'paisa') continue;
    if (WORD_NUM[token] !== undefined) { current += WORD_NUM[token]; continue; }
    if (WORD_SCALE[token] !== undefined) {
      total += (current || 1) * WORD_SCALE[token];
      current = 0;
      continue;
    }
    return null;
  }
  return round2(total + current);
}

/**
 * Invoice total cross-check. OCR often reads the tax total (207.00) where the
 * cheque runner prints the grand total, or skips the printed "Total" figure
 * entirely. The components add up exactly when they are right — taxable + tax —
 * so that computed total is used as the grand total when it is corroborated,
 * by the printed "Amount Chargeable (Words)" line or by the mere fact that the
 * read "grand total" is plainly the tax figure.
 */
function reconcileGrandTotal(totals, lines) {
  const val = (key) => (totals[key] && typeof totals[key].value === 'number' ? totals[key].value : null);
  const taxable = val('taxableValue');
  const totalTax = val('totalTax');
  const taxParts = ['cgstAmount', 'sgstAmount', 'igstAmount', 'utgstAmount', 'cessAmount']
    .map(val).filter((v) => v !== null);
  const taxSum = totalTax !== null ? totalTax : (taxParts.length ? round2(taxParts.reduce((a, b) => a + b, 0)) : null);
  if (taxable === null || taxSum === null) return;
  const computed = round2(taxable + taxSum);
  const grandPrinted = val('grandTotal');
  if (grandPrinted !== null && Math.abs(grandPrinted - computed) < 0.01) return;

  let wordsFigure = null;
  for (const line of lines) {
    const t = cleanLine(line.text || '');
    if (!/chargeable|only|rupees/i.test(t)) continue;
    wordsFigure = readAmountInWords(t);
    if (wordsFigure !== null) break;
  }

  const printedIsTaxTotal = grandPrinted !== null && totalTax !== null && Math.abs(grandPrinted - totalTax) < 0.01;
  const corroborated = wordsFigure !== null && Math.abs(wordsFigure - computed) < 0.01;
  if (!corroborated && !(printedIsTaxTotal && grandPrinted !== null)) return;
  if (wordsFigure !== null && Math.abs(wordsFigure - computed) > 0.01) return;

  totals.grandTotal = field(computed, 0.78, 'reconciled',
    ['Grand total was reconciled from taxable value plus tax — please verify']);
}

function extractPayment(lines) {
  const payment = {
    mode: null, advancePaid: null, balanceDue: null, status: null,
    paymentDate: null, reference: null, bank: null,
  };
  for (let i = 0; i < lines.length; i += 1) {
    const text = cleanLine(lines[i].text);
    if (!text) continue;

    const mode = text.match(PAYMENT_MODE_RE);
    if (mode && !payment.mode && /(payment|mode|paid|via|method)/i.test(text)) {
      payment.mode = field(collapseSpaces(mode[0]).replace(/\b\w/g, (c) => c.toUpperCase()), (lines[i].confidence || 0) / 100, 'payment-section');
    }

    const advance = text.match(/(?:advance\s*paid|amount\s*paid|paid\s*amount|received\s*amount)\s*[:\-.]?\s*([\d,]*\.?\d+)/i);
    if (advance && payment.advancePaid === null) {
      payment.advancePaid = field(parseAmount(advance[1]), (lines[i].confidence || 0) / 100, 'payment-section');
    }
    const balance = text.match(/(?:balance\s*due|balance\s*payable|amount\s*due|remaining)\s*[:\-.]?\s*([\d,]*\.?\d+)/i);
    if (balance && payment.balanceDue === null) {
      payment.balanceDue = field(parseAmount(balance[1]), (lines[i].confidence || 0) / 100, 'payment-section');
    }
    const status = text.match(/(?:payment\s*status|status)\s*[:\-.]?\s*(paid|unpaid|partial|part\s*paid|pending|due|received|not\s*paid)/i);
    if (status && !payment.status) {
      payment.status = field(collapseSpaces(status[1]), (lines[i].confidence || 0) / 100, 'payment-section');
    }
    const reference = text.match(/(?:utr|rrn|transaction\s*(?:no\.?|id)|ref(?:erence)?\s*no\.?)\s*[:\-.]?\s*([A-Za-z0-9\/-]{4,})/i);
    if (reference && !payment.reference) {
      payment.reference = field(reference[1], (lines[i].confidence || 0) / 100, 'payment-section');
    }
    const date = text.match(/(?:payment\s*date|paid\s*on)\s*[:\-.]?\s*(.{6,20})/i);
    if (date && !payment.paymentDate) {
      const normalized = normalizeDate(date[1]);
      if (normalized) payment.paymentDate = field(normalized.iso, (lines[i].confidence || 0) / 100, 'payment-section');
    }
  }
  return payment;
}

// ── Invoice direction ────────────────────────────────────────────────────────

const sameGstin = (a, b) => Boolean(a && b && normalizeForCompare(a) === normalizeForCompare(b));
const normalizeForCompare = (value) => collapseSpaces(value).toUpperCase().replace(/[^0-9A-Z]/g, '');

/**
 * Backwards-compatible single-pair comparison, kept because other callers pass
 * only { name, gstin }. The canonical profile is preferred wherever one exists.
 */
function matchesOwnCompany(party, own) {
  if (!party || !own) return 0;
  if (party.gstin?.value && own.gstin && sameGstin(party.gstin.value, own.gstin)) return 1;
  return companySimilarity(party.name?.value || '', own.name || '');
}

/**
 * Decides which way the invoice runs BEFORE any party is chosen.
 *
 * This is the single most important decision in the whole reader, because on a
 * purchase the supplier is the party that SOLD the goods. The company at the top
 * of the page is only the seller because invoices are printed by their issuer —
 * so "who is at the top" is a layout hint, never an answer. The answer comes
 * from comparing both sides against this application's own company:
 *
 *   we are the seller  → this is one of OUR sales invoices → reject
 *   we are the buyer   → this is an incoming purchase     → supplier = seller
 *   we are both        → self-transfer / ambiguous       → ask a human
 *   we are neither     → direction unknown               → ask a human
 *
 * The one exception is an installation that has never configured its own company
 * details. With nothing to compare against, refusing every invoice would break a
 * working purchase module, so that case falls back to the historical behaviour
 * (supplier = the issuer) and says so out loud.
 */
function resolveRoles({ issuer, sellerBlock, buyerBlocks, identity, ownCompany }) {
  const warnings = [];
  const signals = [];
  const candidates = [];

  // Older callers only pass { name, gstin }. Turn that into a profile so the
  // matching below is identical either way.
  const profile = identity && identity.configured
    ? identity
    : companyIdentity.fromRequest(ownCompany || {});
  const profileIsConfigured = Boolean(profile && profile.configured);

  const issuerMatch = companyIdentity.matchParty(issuer?.party, profile);
  const sellerMatch = companyIdentity.matchParty(sellerBlock, profile);
  const buyerMatch = (buyerBlocks || []).reduce(
    (best, block) => {
      const m = companyIdentity.matchParty(block, profile);
      return m.score > best.score ? m : best;
    },
    { isOwn: false, score: 0, matchedOn: [] },
  );

  const issuerName = collapseSpaces(issuer?.party?.name?.value || issuer?.name || '');
  const sellerName = collapseSpaces(sellerBlock?.name?.value || '');
  const buyerName = collapseSpaces((buyerBlocks || [])[0]?.name?.value || '');
  const ourName = profile.legalName || ownCompany?.name || 'this company';

  const note = (code, message, weight) => {
    signals.push({ code, message, weight });
    return { code, message };
  };

  // ── Which printed block is the seller?
  // An explicit "Seller / Supplier" label settles it. Otherwise the issuer — the
  // letterhead at the top — is the seller, which is how invoices are printed.
  let seller = null;
  let sellerLabel = null;
  if (sellerBlock && sellerBlock.name?.value) {
    seller = sellerBlock;
    sellerLabel = 'Party printed under a seller / supplier label';
  } else if (issuer && issuer.party?.name?.value) {
    seller = issuer.party;
    sellerLabel = 'Company named at the top of the document (the issuer)';
  }

  const buyer = (buyerBlocks || [])[0] || null;

  if (seller) {
    candidates.push({
      role: 'seller',
      party: seller,
      score: sellerBlock ? 0.9 : Math.max(0.55, (issuer.nameLine?.confidence || 0) / 100) + 0.1,
      note: sellerLabel,
    });
  }

  // ── Direction.
  let role;
  let ourRole = null;

  if (!profileIsConfigured) {
    // Nothing to compare against. Preserve the existing behaviour rather than
    // refusing every invoice, and be explicit that it was a fallback.
    role = 'purchase';
    warnings.push({
      code: 'own-company-not-configured',
      message: `This application's own company details are not configured, so the seller and buyer could not be compared. `
        + 'The supplier was read from the top of the invoice — please check it carefully.',
    });
    signals.push({
      code: 'own-company-not-configured',
      message: 'No company identity is configured, so invoice direction was assumed.',
      weight: 0,
    });
  } else if (sellerMatch.isOwn && buyerMatch.isOwn) {
    role = 'ambiguous';
    warnings.push(note(
      'both-sides-look-like-us',
      'This company appears on both sides of the invoice, so the direction could not be decided. Please review before importing.',
    ));
  } else if (sellerMatch.isOwn || (issuerMatch.isOwn && !buyerMatch.isOwn)) {
    role = 'sales';
    ourRole = 'seller';
    warnings.push(note(
      'document-is-sales-invoice',
      `This invoice is issued by ${ourName}. ${buyerName ? `The buyer on it is ${buyerName}.` : ''} `
        + 'It cannot be imported as a purchase.',
    ));
  } else if (buyerMatch.isOwn) {
    role = 'purchase';
    ourRole = 'buyer';
    warnings.push(note(
      'buyer-is-us',
      'The invoice names this company as the buyer, which is consistent with a purchase.',
    ));
  } else {
    role = 'unknown';
    warnings.push(note(
      'direction-not-determined',
      `Neither the seller nor the buyer on this invoice matches ${ourName}, so it could not be confirmed whether this is a purchase.`,
    ));
  }

  // A GSTIN match is the strongest evidence available; record which signal
  // decided it so the review screen can explain the decision.
  const decidedBy = sellerMatch.matchedOn.includes('gstin') || issuerMatch.matchedOn.includes('gstin')
    ? 'gstin'
    : (sellerMatch.matchedOn.length || buyerMatch.matchedOn.length ? sellerMatch.matchedOn.concat(buyerMatch.matchedOn) : []);

  // ── The supplier is the seller, and only ever on a purchase.
  let supplierCandidate = null;
  if (role === 'purchase' && seller) {
    supplierCandidate = { party: seller, score: candidates[0].score, note: candidates[0].note };
    if (sellerMatch.isOwn) {
      // We are on both sides of the reading; the sale-side fallback took over.
      warnings.push({
        code: 'supplier-looks-like-us',
        message: 'The party read as supplier looks like this company. Please verify the supplier.',
      });
      supplierCandidate = { ...supplierCandidate, needsReview: true };
    }
  } else if (role !== 'purchase') {
    // No supplier is offered at all. Putting the buyer, the issuer or the first
    // line of text into Party Name is what made a sales invoice importable.
    supplierCandidate = null;
  }

  // A buyer block that matches us is strong evidence the document really is an
  // incoming invoice.
  const confidenceBoost = role === 'purchase' && buyerMatch.isOwn ? 0.05 : 0;

  const identitySummary = {
    legalName: profile.legalName || null,
    configured: profileIsConfigured,
    sources: profile.sources || [],
    gstins: profile.gstins || [],
    sellerMatch,
    issuerMatch,
    buyerMatch,
    decidedBy,
  };

  return {
    // `documentRole` is the name the rest of the pipeline already reads.
    documentRole: role,
    role,
    ourRole,
    seller,
    buyer,
    classification: {
      role,
      ourRole,
      // What the UI shows in the headline message.
      headline: headlineFor(role, { ourName, sellerName, buyerName, invoiceNo: null }),
      sellerName: sellerName || null,
      buyerName: buyerName || null,
      identity: identitySummary,
      signals,
      confidence: directionConfidence({ role, sellerMatch, buyerMatch, issuerMatch, profileIsConfigured }),
      importable: role === 'purchase',
    },
    supplierCandidate,
    warnings,
    ownMatchBuyer: buyerMatch.score,
    identityMatch: identitySummary,
    confidenceBoost,
  };
}

/**
 * How sure we are about the direction. A GSTIN match on the relevant side is
 * near-certain; an "unknown" is explicitly not confident at all.
 */
function directionConfidence({ role, sellerMatch, buyerMatch, issuerMatch, profileIsConfigured }) {
  if (!profileIsConfigured) return 0.4;
  if (role === 'unknown' || role === 'ambiguous') return 0.3;
  const decisive = role === 'sales' ? (sellerMatch.matchedOn.includes('gstin') ? 0.99 : sellerMatch.score)
    : (buyerMatch.matchedOn.includes('gstin') ? 0.99 : Math.max(buyerMatch.score, issuerMatch.score * 0.5));
  return Number(Math.min(0.99, Math.max(0.6, decisive)).toFixed(3));
}

/**
 * The sentence the review screen leads with. The three cases are worded
 * separately on purpose: a sales invoice, an unreadable direction and a
 * self-transfer need different words and different buttons.
 */
function headlineFor(role, { ourName, sellerName, buyerName }) {
  if (role === 'sales') {
    const who = buyerName ? ` The buyer on it is ${buyerName}.` : '';
    return `This invoice appears to be a SALES invoice issued by ${ourName}.${who} `
      + 'It cannot be imported as a Purchase Entry.';
  }
  if (role === 'ambiguous') {
    return `${ourName} appears on both sides of this invoice, so it could not be confirmed `
      + 'whether this is a purchase or a sale. Please review it before importing.';
  }
  if (role === 'unknown') {
    return `We could not determine whether ${ourName} is the buyer or the seller on this invoice. `
      + 'Please verify the invoice before importing it as a purchase.';
  }
  return `This invoice is a purchase from ${sellerName || 'an external supplier'}.`;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Reads a positioned invoice and returns everything that could be understood,
 * with a confidence value for each field. `ownCompany` ({ name, gstin }) is what
 * lets the parser tell a purchase invoice from one of our own sales invoices.
 */
function parseInvoice({ pages, ownCompany = {}, identity = null } = {}) {
  const allPages = pages || [];
  const lines = flattenLines(allPages);
  const warnings = [];

  if (!lines.length) {
    return {
      lines: [],
      supplier: null,
      invoice: { number: missing('No invoice number could be read'), date: missing('No invoice date could be read') },
      items: [],
      totals: {},
      payment: {},
      documentRole: 'unknown',
      classification: {
        role: 'unknown',
        ourRole: null,
        headline: 'No readable text was found on this document, so the invoice direction could not be determined.',
        sellerName: null,
        buyerName: null,
        identity: null,
        signals: [],
        confidence: 0,
        importable: false,
      },
      ourRole: null,
      warnings: [{ code: 'no-text', message: 'No readable text was found on this document.' }],
      confidence: 0,
    };
  }

  const tables = (() => {
    const found = findItemTables(lines);
    // The single-line scan found no header: rows OCR split into one line per
    // printed column are merged and rescanned. JBR goes through the ordinary
    // path unchanged, because its header is already found above.
    return found.length ? found : findItemTablesMerged(lines);
  })();
  const table = tables.length
    ? tables.slice().sort((a, b) => b.score - a.score)[0]
    : null;
  const headerLimit = table ? table.headerIndex : lines.length;

  // ── Party blocks
  //
  // Both invoice columns are printed on the same rows, so reading line by line
  // merges the supplier's address with the invoice metadata grid beside it — the
  // address came out as "M-35, PANORAMA COMPLEX, JBR/428/26-27 56-Oct-26, …".
  //
  // The page's regions are established first, and each block is read only from
  // the words printed inside its own region. Scoping has to happen per WORD: OCR
  // read the address and the metadata as one line because they sit side by side,
  // so a line-level test lets the whole line through and the contamination
  // survives.
  const geometry = buildDocumentGeometry(lines, table);

  const buyerHeading = (() => {
    for (let i = 0; i < headerLimit; i += 1) {
      if (!hasAnyLabel(lines[i].text || '', BUYER_LABELS)) continue;
      if (/order/i.test(lines[i].text || '')) continue;
      return i;
    }
    return -1;
  })();

  const issuerScope = buyerHeading > 0 ? lines.slice(0, buyerHeading) : lines.slice(0, headerLimit);
  const buyerScopeRaw = buyerHeading >= 0 ? lines.slice(buyerHeading, headerLimit) : [];
  const buyerScope = clipLinesToRegion(buyerScopeRaw, geometry.buyer);
  const supplierScope = clipLinesToRegion(issuerScope, geometry.supplier);

  const sellerHit = findLabeledValue(supplierScope, SELLER_LABELS, { limit: supplierScope.length });
  const buyerHit = findLabeledValue(buyerScope, BUYER_LABELS, { limit: buyerScope.length });

  const sellerBlock = sellerHit
    ? extractPartyFromBlock(readPartyBlock(supplierScope, sellerHit, table), { roleLabel: 'seller' })
    : null;
  const buyerBlocks = [];
  if (buyerScope.length) {
    // Consignee and Buyer are separate blocks; both are useful evidence.
    const seen = new Set();
    for (let i = 0; i < buyerScope.length; i += 1) {
      if (!hasAnyLabel(buyerScope[i].text || '', BUYER_LABELS)) continue;
      if (seen.has(i)) continue;
      const block = readPartyBlock(buyerScope, { lineIndex: i }, table);
      const party = extractPartyFromBlock(block, { roleLabel: 'buyer' });
      if (party.name.value) {
        seen.add(i);
        buyerBlocks.push(party);
      } else if (block && block.length) {
        // OCR regularly splits a company name across two printed lines - "Bluechip
        // Computer s" then "/ uter Systom" - and no single line is the name, so the
        // block extractor reports nothing and the whole party disappears. The
        // lines are joined and offered as the name. The GSTIN and address below
        // are untouched; only the name is recovered, and it is matched by
        // similarity afterwards, so a wrong join cannot identify anything on its
        // own.
        const joined = collapseSpaces(block.slice(0, 3).map((l) => l.text).join(' '))
          .replace(/\s*[|/\\]\s*/g, ' ');
        if (joined && joined.length >= 4 && !isDocumentTitle(joined)) {
          party.name = field(joined, Math.max(0.4, (block[0].confidence || 0) / 100), 'joined-lines');
          seen.add(i);
          buyerBlocks.push(party);
        }
      }
    }
  }
  if (!buyerBlocks.length && buyerHit) {
    const party = extractPartyFromBlock(readPartyBlock(buyerScope, buyerHit, table), { roleLabel: 'buyer' });
    if (party.name.value) buyerBlocks.push(party);
  }

  const issuer = readHeaderIssuer(lines, table);
  // The issuer's own details come from the left-hand column only. Its name comes
  // from the letterhead scan; everything under it is read from inside the supplier
  // region, so the metadata grid on the right cannot contribute.
  const scopedIssuer = (() => {
    if (!issuer || !supplierScope.length) return issuer;
    const party = extractPartyFromBlock(supplierScope, { roleLabel: 'issuer' });
    return { ...issuer, party: { ...party, name: issuer.party?.name || party.name } };
  })();

  // The parser resolves direction against one profile; resolve it here so the
  // label-less buyer scan below reasons about the same company the role check
  // does.
  const roleProfile = identity && identity.configured
    ? identity
    : companyIdentity.fromRequest(ownCompany || {});

  // A purchase whose "Buyer (Bill To)" heading could not be read at all has no
  // labelled buyer block — the direction would be reported as unknown. Blocks
  // below the issuer's letterhead that match our own company on the buying side
  // are added as buyer evidence in that case.
  if (!buyerBlocks.length) {
    const ownBuyer = findOwnBuyerBlocks(lines, {
      headerLimit,
      geometry,
      issuer: scopedIssuer,
      profile: roleProfile,
    });
    buyerBlocks.push(...ownBuyer);
  }

  const roles = resolveRoles({ issuer: scopedIssuer, sellerBlock, buyerBlocks, identity: roleProfile, ownCompany });
  warnings.push(...roles.warnings);

  const supplierParty = roles.supplierCandidate?.party || null;
  let supplier = null;
  if (supplierParty && supplierParty.name.value) {
    const score = Math.min(0.97, (roles.supplierCandidate.score || 0.7) + roles.confidenceBoost);
    const nameConfidence = roles.supplierCandidate.needsReview
      ? Math.min(score, 0.84)
      : Math.min(0.98, score);
    supplier = { ...supplierParty };
    supplier.name = field(supplierParty.name.value, nameConfidence, roles.supplierCandidate.note);
    supplier.band = confidenceBand(nameConfidence);
    if (roles.supplierCandidate.needsReview) {
      supplier.name.warnings = [...(supplier.name.warnings || []), 'Supplier could not be identified with certainty — please verify'];
    }
  } else {
    supplier = null;
    warnings.push({
      code: 'supplier-not-found',
      message: 'The supplier could not be identified from this invoice. Please enter the party manually.',
    });
  }

  // ── Supplier fields belong to words, not to whole printed lines ──
  //
  // `extractPartyFromBlock` above works on OCR LINES, and a printed line can
  // carry several fields at once, so assigning the line assigns all of them: the
  // address came back containing the phone, the GSTIN and the state code, while
  // city, pincode and phone stayed empty. The ownership pass below claims every
  // word of the supplier block for exactly one field, and the address is whatever
  // is left over.
  //
  // It runs AFTER `supplier` exists, and it is applied field by field: the block
  // extractor remains the fallback for any single field ownership could not
  // resolve, so one missing value can never drag the rest of the address back in.
  const supplierOwnership = (() => {
    const region = geometry && geometry.supplier;
    if (!region) return null;
    const words = wordsInRegion(buildWords(lines), region);
    if (!words.length) return null;
    let owned = null;
    try {
      owned = claimSupplierFields(words);
    } catch {
      return null;
    }
    if (!owned || !owned.partyName) return null;
    // A document title printed at the top of the page ("Tax Invoice") sits inside
    // the supplier region on some layouts. It is not a party, so ownership never
    // replaces a real name with it.
    if (isDocumentTitle(owned.partyName)) return null;
    // Ownership refines a party that was already found; it must never invent one.
    // A sales invoice legitimately has no supplier, and this keeps it that way.
    if (!supplier) return null;
    // A structured, geometry-owned value replaces the line-level one; a value
    // ownership could not resolve leaves the existing field untouched.
    const adopt = (existing, value, confidence, extra) => {
      if (value === null || value === undefined || value === '') return existing;
      const next = field(value, confidence, 'word-ownership');
      if (extra && extra.warnings) next.warnings = extra.warnings;
      if (existing && existing.warnings && !next.warnings) next.warnings = existing.warnings;
      return next;
    };
    const ev = owned.evidence || {};
    supplier.name = adopt(supplier.name, owned.partyName, 0.95);
    supplier.address = adopt(supplier.address, owned.address, 0.9);
    supplier.city = adopt(supplier.city, owned.city, 0.8);
    supplier.state = adopt(supplier.state, owned.state, ev.state?.confidence || 0.8);
    supplier.pincode = adopt(supplier.pincode, owned.pincode, 0.88);
    supplier.phone = adopt(supplier.phone, owned.phone, ev.phone?.confidence || 0.85);
    supplier.email = adopt(supplier.email, owned.email, 0.92);
    // The GSTIN is kept exactly as OCR read it. It fails the structural check, so
    // it is offered for review rather than discarded, and - importantly - it does
    // not fall back into the address.
    if (owned.gstin && (!supplier.gstin || !supplier.gstin.value)) {
      supplier.gstin = field(owned.gstin, 0.45, 'word-ownership', [
        'GSTIN was read but could not be verified — please check it',
      ]);
      supplier.gstin.reviewRequired = true;
    }
    return owned;
  })();

  // ── Supplier name recovery from the bank block ─────────────────────────────
  // The letterhead is the noisiest part of an OCR page; here it barely survived
  // ("[mATESHwAR Some"). The bank details block, printed deeper in the page,
  // reads cleanly, and its "Account Holders Name" is the same company. When the
  // letterhead name is obviously mangled (bracket/bar debris, fewer than four
  // letters) - or simply not a different company - that clean name replaces it,
  // rather than shipping a name full of OCR junk to the purchase form.
  const bankHolderName = extractBankHolderName(lines);
  if (supplier && bankHolderName) {
    const currentName = supplier.name?.value || '';
    const lettersOnly = currentName.replace(/[^A-Za-z]/g, '');
    const degenerate = !lettersOnly || lettersOnly.length < 4 || /[\[|~]/.test(currentName) || /^\W/.test(currentName);
    const sameCompany = currentName && companySimilarity(currentName, bankHolderName) >= 0.4;
    if (degenerate || sameCompany) {
      supplier.name = field(bankHolderName, degenerate ? 0.7 : 0.85, 'bank-details-name', [
        'Supplier name was read from the bank details block, not the letterhead — please verify',
      ]);
    }
  }

  // ── Invoice reference
  // The page's columns are read first, because on a two-column header the value
  // under "Invoice No." is a *different cell* on the next line, not the rest of
  // the string. The flattened-text search stays as the fallback for documents
  // where the OCR did give each label its own line.
  const bands = buildColumnBands(lines, { minCells: 3 });
  // Every heading on the page, so a cell holding one of them is never mistaken
  // for the value of the heading beside it.
  const allHeadings = [...INVOICE_NUMBER_LABELS, ...INVOICE_DATE_LABELS, ...SELLER_LABELS, ...BUYER_LABELS];
  // The exact, line-based search runs first: where the OCR did give each label its
  // own line it is the most trustworthy answer, because the value really is the
  // text beside the label. Only when it finds nothing is the column-aware search
  // used, which is what recovers a value printed under its label in a second
  // column — the case that produced "M-35, PANORAMA COMPLEX, JBR/428/26-27" as an
  // invoice number.
  /**
   * An invoice number is a short token. When the candidate came back as a slice
   * of the flattened line it has swallowed the address, the phone and the date —
   * "M-35, PANORAMA COMPLEX, JBR/428/26-27 5-Oct-26" — which is not a number
   * anybody typed, and writing that into a purchase would be worse than leaving
   * it blank. Such a candidate is rejected in favour of the value from the
   * column the label actually sits in.
   */
  const isContaminatedReference = (raw) => {
    const value = collapseSpaces(raw || '');
    if (!value) return true;
    if (value.length > 40) return true;
    // Two or more separate postal-looking fragments means more than one field.
    const commaChunks = value.split(',').map((s) => s.trim()).filter(Boolean);
    if (commaChunks.length >= 2) return true;
    if (/\b(?:complex|road|street|nagar|building|flat|floor|opp|plot|sector|district|hotel|school|society|apartment)\b/i.test(value)) return true;
    // A bare phone number is not a reference.
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 10 && value.replace(/\d/g, '').trim().length <= 3) return true;
    return false;
  };

  const flatNumberHit = findLabeledValue(lines, INVOICE_NUMBER_LABELS, { limit: headerLimit });
  const cellNumberHit = findLabeledValueInCells(lines, INVOICE_NUMBER_LABELS, bands, { limit: headerLimit, otherLabels: allHeadings });
  // The spatial cell wins whenever the flat reading looks polluted.
  // A label and its value are very often on DIFFERENT printed lines: the heading
  // row reads "Involce No.        Dated" and the row beneath it holds the two
  // values. Reading the flattened text therefore returned the whole address line
  // as the invoice number. The value is therefore also looked for as the cell
  // printed directly UNDER the label's own cell, inside the label's own column,
  // which is what this finds.
  const cellUnderLabel = (labelHit, labels) => {
    if (!labelHit || labelHit.lineIndex === undefined) return null;
    // The label's own cell is located here rather than carried on the hit: the
    // line-based search reports a text offset, not a cell.
    const anchor = segmentCells(lines[labelHit.lineIndex] || { words: [] })
      .find((cell) => (labels || []).some((label) => matchLabel(cell.text, label))) || null;
    if (!anchor) return null;
    const labelLine = labelHit.lineIndex;
    // The value is read from the WORDS sitting in the label's own column on the
    // rows below, not from the printed line. The header line beneath the label
    // also carries the supplier's address in the column to the left, and that is
    // exactly the text that used to end up as the invoice number.
    const tol = Math.max(8, (anchor.x1 - anchor.x0) * 0.5);
    for (let j = labelLine + 1; j < Math.min(lines.length, labelLine + 3); j += 1) {
      if (lines[j].pageNumber !== lines[labelLine].pageNumber) break;
      if (lineCenterY(lines[j]) - lineCenterY(lines[labelLine]) > lineHeight(lines[labelLine]) * 3) break;
      const inColumn = (lines[j].words || [])
        .filter((w) => w.bbox && w.text && String(w.text).trim())
        .filter((w) => w.bbox.x0 >= anchor.x0 - tol && w.bbox.x0 <= anchor.x1 + tol)
        .sort((a, b) => a.bbox.x0 - b.bbox.x0);
      if (!inColumn.length) continue;
      // Keep only the run of words that is horizontally joined to the label's own
      // position; a second column further right is a different field.
      const runs = [];
      for (const w of inColumn) {
        const last = runs[runs.length - 1];
        if (last && w.bbox.x0 - last.x1 <= lineHeight(lines[j]) * 0.6) { last.x1 = w.bbox.x1; last.words.push(w); }
        else runs.push({ x0: w.bbox.x0, x1: w.bbox.x1, words: [w] });
      }
      const run = runs.reduce((best, r) => {
        const d = Math.abs(r.x0 - anchor.x0);
        return !best || d < best.d ? { r, d } : best;
      }, null);
      if (!run) continue;
      const text = collapseSpaces(run.r.words.map((w) => String(w.text).trim()).join(' '));
      if (!text) continue;
      if (allHeadings.some((h) => matchLabel(text, h))) continue;
      return { raw: text, labelConfidence: labelHit.labelConfidence || 0.8, source: 'cell-below-label', lineIndex: j, cell: run.r };
    }
    return null;
  };

  const spatialNumberHit = cellUnderLabel(flatNumberHit, INVOICE_NUMBER_LABELS);
  // A label is worth trusting only if what sits under it really looks like an
  // invoice number: a short token that carries a digit. This is what tells a real
  // value from the address printed in the column below.
  const looksLikeInvoiceNo = (raw) => {
    const value = collapseSpaces(raw || '');
    if (!value || value.length > 40) return false;
    if (!/\d/.test(value)) return false;
    return !isContaminatedReference(value);
  };
  const numberHit = (flatNumberHit && !isContaminatedReference(flatNumberHit.raw))
    ? flatNumberHit
    : (looksLikeInvoiceNo(spatialNumberHit?.raw) ? spatialNumberHit
      : (cellNumberHit && looksLikeInvoiceNo(cellNumberHit.raw) ? cellNumberHit
        : (spatialNumberHit || cellNumberHit || flatNumberHit)));
  let invoiceNumber = missing('Invoice number could not be read');
  if (numberHit) {
    const raw = collapseSpaces(numberHit.raw)
      // Stop before the next label printed on the same line.
      .split(/\s{2,}|\s+(?:dated|date|dated\s*on|ref|buyer|order|gstin|po)\b/i)[0]
      .replace(/[:;,]+$/, '')
      .trim();
    // Reject values that look like an address fragment: contain letters+comma
    // but no invoice-number pattern (slash or hyphen followed by a digit).
    const looksLikeAddress = /[A-Za-z]{4,}.*,/.test(raw) && !/[\/\-]\d/.test(raw);
    const value = looksLikeAddress ? '' : raw.replace(/^[:#\-\u2013\u2014\s]+/, '');
    if (value) {
      const long = value.length > 40;
      invoiceNumber = field(
        value,
        Math.min(0.98, (numberHit.labelConfidence || 0.8) * (long ? 0.6 : 1)),
        `invoice-label:${numberHit.source}`
      );
      if (long) invoiceNumber.warnings = ['The invoice number could not be read clearly'];
    }
  }

  const flatDateHit = findLabeledValue(lines, INVOICE_DATE_LABELS, { limit: headerLimit });
  const cellDateHit = findLabeledValueInCells(lines, INVOICE_DATE_LABELS, bands, { limit: headerLimit, otherLabels: allHeadings });
  // A date is short and is never an address, so the same contamination test
  // applies: prefer the cell the label's own column points at.
  const spatialDateHit = cellUnderLabel(flatDateHit, INVOICE_DATE_LABELS);
  // "Dated" has its value printed underneath it in the same column, and a date is
  // recognisable as one before any parsing: it carries a day and a month.
  const looksLikeDate = (raw) => /\d{1,2}[\s\-/.][A-Za-z]{3,9}|\d{1,2}[\s\-/.]\d{1,2}/.test(collapseSpaces(raw || ''));
  const dateHit = (flatDateHit && !isContaminatedReference(flatDateHit.raw))
    ? flatDateHit
    : (spatialDateHit && looksLikeDate(spatialDateHit.raw) ? spatialDateHit
      : (cellDateHit && looksLikeDate(cellDateHit.raw) ? cellDateHit
        : (spatialDateHit || cellDateHit || flatDateHit)));
  let invoiceDate = missing('Invoice date could not be read');
  let invoiceDateDisplay = null;
  if (dateHit) {
    const normalized = normalizeDate(dateHit.raw);
    if (normalized) {
      const penalty = normalized.ambiguous ? 0.1 : 0;
      invoiceDate = field(
        normalized.iso,
        Math.min(0.98, (dateHit.labelConfidence || 0.8) - penalty),
        `date-label:${dateHit.source}`,
        normalized.ambiguous ? ['Day and month order could not be confirmed — please verify'] : []
      );
      invoiceDateDisplay = normalized.display;
    }
  }

  // ── Items
  let items = parseAllItems(lines, tables);
  if (!items.length) items = parseItemRowsLoose(lines);
  items.forEach((item, index) => { item.lineNo = index + 1; });

  // ── Totals, tax summary, payment
  const totalsStart = table ? findTotalsStart(lines, table) : 0;
  const totals = extractTotals(lines, totalsStart);
  reconcileGrandTotal(totals, lines);
  const payment = extractPayment(lines);
  if (table && items.length === 0) {
    warnings.push({
      code: 'no-items',
      message: 'No line items could be read from this invoice. Please add them by hand.',
    });
  }

  // ── Overall confidence: the mean of the fields that matter most.
  const scored = [
    supplier?.name?.confidence || 0,
    invoiceNumber.confidence,
    invoiceDate.confidence,
    ...items.flatMap((i) => [i.itemName.confidence, i.quantity.confidence, i.unitRate?.confidence || 0]),
  ].filter((c) => typeof c === 'number');
  const confidence = scored.length ? scored.reduce((s, c) => s + c, 0) / scored.length : 0;

  return {
    lines,
    pages: allPages,
    supplier,
    buyer: buyerBlocks[0] || null,
    consignee: buyerBlocks[1] || null,
    issuer: issuer ? { name: issuer.name, gstin: issuer.gstin?.value || null } : null,
    documentRole: roles.documentRole,
    // Everything the review screen needs to explain the direction decision.
    classification: roles.classification,
    ourRole: roles.ourRole,
    identityMatch: roles.identityMatch,
    invoice: { number: invoiceNumber, date: invoiceDate, dateDisplay: invoiceDateDisplay },
    items,
    totals,
    payment,
    tableDetected: Boolean(table),
    tableCount: tables.length,
    // The column geometry actually used, kept so a wrong field can be traced to
    // the cell range that produced it rather than guessed at.
    tableDebug: table ? { columns: table.columns, bbox: table.bbox || null, headerIndex: table.headerIndex } : null,
    warnings,
    confidence: Number(confidence.toFixed(3)),
  };
}

function findTotalsStart(lines, table) {
  for (let i = table.headerIndex + 1; i < lines.length; i += 1) {
    const text = cleanLine(lines[i].text);
    if (!text) continue;
    if (TOTALS_LINE.test(text)) return Math.max(0, i - 1);
  }
  return table.headerIndex + 1;
}

module.exports = {
  parseInvoice,
  // Exported for the pipeline's own tests and for reuse by other documents.
  findItemTable,
  findItemTables,
  parseAllItems,
  extractTotals,
  extractPayment,
  resolveRoles,
  isDocumentTitle,
  headlineFor,
  gstinIn,
  extractPartyFromBlock,
  readHeaderIssuer,
  parseItemRowsLoose,
  splitSerials,
  classifyHeaderWord,
  INVOICE_NUMBER_LABELS,
  INVOICE_DATE_LABELS,
  TOTALS_LINE,
  PAYMENT_SECTION,
  CONFIDENCE,
};