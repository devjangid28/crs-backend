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
  normalizeDate, validateGstin, suggestGstinRepairs,
  findEmail, normalizePhone, looksLikePhone, findPincode, companySimilarity, GST_STATE_CODES,
} = require('./normalize');
const {
  flattenLines, lineCenterY, lineHeight,
  findLabeledValue, assignToColumns, rowHasNumbers,
} = require('./layout');

// ── Label dictionaries ───────────────────────────────────────────────────────

const INVOICE_NUMBER_LABELS = [
  {
    key: 'invoice_number',
    priority: 5,
    match: /\b(?:tax\s*invoice|invoice|inv|bill)\s*(?:no\.?|number|#)|invoice\s*#/i,
    exclude: /\b(?:order|purchase\s*order|po|ref|reference|voucher|challan|job|delivery|gate|grn|dc)\b/i,
  },
  // A bare "Invoice" heading with the number printed underneath it.
  { key: 'invoice_number', priority: 2, match: /^invoice\s*[:\-]?\s*$/i },
];

const INVOICE_DATE_LABELS = [
  { key: 'invoice_date', priority: 5, match: /\b(?:tax\s*invoice\s*date|invoice\s*date|inv\.?\s*date|bill\s*date)\b/i, exclude: /\b(due|payment|order|delivery|dispatch|expiry|period)\b/i },
  { key: 'invoice_date', priority: 4, match: /\bdated\b/i, exclude: /\b(due|payment|order|delivery|dispatch|expiry)\b/i },
  { key: 'invoice_date', priority: 1, match: /\b(?:date)\b/i, exclude: /\b(due|payment|order|delivery|dispatch|expiry|period|from|to|cheque|chq|utr|neft|rtgs)\b/i },
];

const SELLER_LABELS = [
  { key: 'seller', match: /\b(?:sold\s*by|seller|supplier|vendor|bill\s*from|supplied\s*by|from)\b\s*:?\s*/i },
];
const BUYER_LABELS = [
  { key: 'buyer', match: /\b(?:bill\s*to|ship\s*to|consignee|buyer|customer|purchaser|sold\s*to|delivered\s*to)\b\s*:?\s*/i },
];

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

// ── Description sub-labels (a product's own details, not extra products) ─────

const DESCRIPTION_ATTRIBUTES = [
  { key: 'serial', match: /^\s*(?:serial\s*(?:no\.?|number)?|s\/n|sn|sr\s*no\.?|imei|device\s*serial)\b\s*[:\-]?\s*(.+)$/i },
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

// ── Totals / section detection ───────────────────────────────────────────────

const TOTALS_LINE = /^\s*(?:sub\s*[-_]?\s*total|total\s+taxable|total\s*(?:cgst|sgst|igst|tax|gst|amount|invoice)|round\s*off|grand\s*total|invoice\s*total|total\s*amount|net\s*amount|amount\s*payable|total\s*invoice\s*value|tax\s*total|total\s*tax|total)\b/i;
const PAYMENT_SECTION = /\b(?:payment\s*(?:details?|info(?:rmation)?|mode)|paid\s*via|mode\s*of\s*payment|payment\s*status|advance\s*paid|balance\s*due|amount\s*paid)\b/i;

// ── Column detection ─────────────────────────────────────────────────────────

const NUMERIC_KEYS = ['qty', 'rate', 'taxable', 'discount', 'total', 'cgstAmt', 'sgstAmt', 'igstAmt'];

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

  if (/^(?:sl|s\.?\s?l\.?|sr|s\.?\s?no\.?|sno|srno|serial\s*no\.?|#|no)\b/.test(w)) return { key: 'sl' };
  if (/^(?:description|particulars|commodity|product|items?|nature|nomenclature|goods)/.test(w)) return { key: 'desc' };
  if (/^(?:hsn|sac|hsn\/sac|hsn\s*code|hsncode)/.test(w)) return { key: 'hsn' };
  if (/^(?:qty|qnty|quantity)/.test(w)) return { key: 'qty' };
  if (/^(?:rate|unit\s*price|unit\s*rate|basic\s*rate|price|basic)/.test(w)
    || (/rate/.test(w) && /(excl|pre|basic|without)/.test(w))) return { key: 'rate' };
  if (/^(?:taxable|tax\s*value|assessable|value)/.test(w)) return { key: 'taxable' };
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

function detectItemTableAt(lines, i) {
  const line = lines[i];
  const words = (line.words || []).map((w) => w.text);
  if (!words.length) return null;

  const columns = [];
  let cursor = 0;
  while (cursor < words.length) {
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

  return {
    headerIndex: i,
    headerLine: line,
    pageNumber: line.pageNumber,
    columns,
    keys: [...keys],
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

  for (let i = labelHit.lineIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (table && i === table.headerIndex) break;
    if (i > labelHit.lineIndex && SELLER_LABELS.some((l) => l.match.test(line.text))
      && BUYER_LABELS.some((l) => l.match.test(line.text))) break;
    if (i > labelHit.lineIndex
      && (SELLER_LABELS.some((l) => l.match.test(cleanLine(line.text).slice(0, 24)))
        || BUYER_LABELS.some((l) => l.match.test(cleanLine(line.text).slice(0, 24))))) break;
    if (i > labelHit.lineIndex && BLOCK_STOP_WORDS.test(line.text) && lineCenterY(line) - previousY > median * 0.6) break;
    if (lineCenterY(line) - previousY > median * 3.2) break;

    block.push(line);
    previousY = lineCenterY(line);
  }
  return block;
}

const GSTIN_ON_LINE = /\bGST\s*(?:IN)?\b\s*[:\-.]?\s*([0-9A-Za-z]{15})\b/i;

// The words that name a *role* rather than a party. A block headed
// "Buyer (Bill To)" would otherwise be read as a company called "Buyer".
const ROLE_WORD_RE = /^(?:buyer|seller|supplier|vendor|consignee|ship\s*to|bill\s*to|party|customer|purchaser|dear\s*(?:sir|madam)|for)\b/i;

/** Removes any leading role words and the brackets they leave behind. */
function stripRoleWords(value) {
  let text = String(value || '');
  for (let i = 0; i < 4; i += 1) {
    const next = text
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
    const m2 = loose.match(/GSTIN([0-9A-Z]{15})/i);
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
  const lines = block.map((l) => ({ ...l, clean: cleanLine(l.text) }));

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
    if (SELLER_LABELS.some((l) => l.match.test(text)) || BUYER_LABELS.some((l) => l.match.test(text))) {
      const stripped = stripRoleWords(text
        .replace(SELLER_LABELS[0].match, '')
        .replace(BUYER_LABELS[0].match, ''));
      if (stripped.length >= 3) { nameCandidates.push({ line, text: stripped, fromLabel: true }); }
      continue;
    }
    // A line that is nothing but role words is a heading, not a company.
    const withoutRole = stripRoleWords(text);
    if (withoutRole.length < 3) continue;
    if (BLOCK_STOP_WORDS.test(text)) continue;
    nameCandidates.push({ line, text: withoutRole, fromLabel: false });
  }

  const nameHit = nameCandidates[0];
  if (nameHit) {
    const ocrConfidence = ((nameHit.line.confidence || 0) / 100) || 0.9;
    const cleanliness = /[A-Za-z]{3}/.test(nameHit.text) ? 1 : 0.5;
    result.name = field(
      collapseSpaces(nameHit.text).replace(/[,;]$/, ''),
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
    // These lines are not part of the postal address — each has its own field.
    if (GSTIN_ON_LINE.test(text) || /\bGST\s*IN\b/i.test(text)) continue;
    if (/^(?:www\.?|https?:\/\/|website|web\s*site|url)\b/i.test(text)) continue;
    if (/^(?:fax|pan|vat|bank)\b/i.test(text)) continue;

    if (!result.phone.value) {
      const hit = findLabeledValue([line], PHONE_LABELS, { limit: 1 });
      if (hit) {
        const value = normalizePhone(hit.raw);
        if (value) {
          result.phone = field(value, Math.min(0.97, (line.confidence || 0) / 100 + 0.05), 'phone-label');
          continue;
        }
      }
      if (!result.phone.value && /^\s*(?:ph|phone|mob|mobile|tel)\b/i.test(text)) {
        const value = normalizePhone(text);
        if (value) { result.phone = field(value, 0.8, 'phone-label'); continue; }
      }
    }
    if (!result.email.value) {
      const email = findEmail(text);
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
    if (!result.state.value && /^(?:state|state\s*code)\b/i.test(text)) {
      const value = collapseSpaces(text.replace(/^(?:state|state\s*code)\b\s*[:\-.]?\s*/i, ''));
      const codeMatch = value.match(/^(\d{2})\b/);
      const name = codeMatch ? GST_STATE_CODES[codeMatch[1]] : value;
      if (name && name.length <= 40) { result.state = field(name, 0.9, 'state-label'); continue; }
    }
    if (!result.city.value && /^(?:city|town|district)\b/i.test(text)) {
      const value = collapseSpaces(text.replace(/^(?:city|town|district)\b\s*[:\-.]?\s*/i, ''));
      if (value && value.length <= 40) { result.city = field(value, 0.9, 'city-label'); continue; }
    }
    addressLines.push(line);
  }

  if (addressLines.length) {
    const addressText = addressLines
      .map((l) => l.clean)
      // A GSTIN printed on the same line as something else still has to go.
      .map((t) => t.replace(/\bGST\s*IN\b\s*[:\-.]?\s*[0-9A-Za-z]{15}\b/ig, '').replace(/\bState\s*Code\b\s*[:\-.]?\s*\d{2}\b/ig, ''))
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
  const isTitleLine = (text) => /^(?:tax\s*)?(?:sales\s*)?(?:invoice|tax\s*invoice|bill|cash\s*memo|delivery\s*challan|challan|quotation|estimate|sales\s*invoice|original\s*invoice|duplicate)(?:\s*(?:no\.?|number|date))?\s*$/i.test(text);
  const isDetailLine = (text) => (
    GSTIN_ON_LINE.test(text)
    || /^(?:gstin|gst|phone|ph\b|mob|mobile|tel|email|e-?mail|web|website|fax|pan|vat|state|city|pin|pincode|post\s*code)\b/i.test(text)
    || findEmail(text)
    || (looksLikePhone(text) && text.replace(/\D/g, '').length >= 10)
    || TOTALS_LINE.test(text)
    || PAYMENT_SECTION.test(text)
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
    const words = text.split(/[\s,]+/).filter((w) => /[A-Za-z]/.test(w)).length;
    candidates.push({ line, text, height: lineHeight(line), top: lineCenterY(line), nameScore: isTitleLine(text) ? 0 : words });
  }

  const usable = candidates.filter((c) => !isTitleLine(c.text));
  const pool = usable.length ? usable : candidates;
  if (!pool.length) return null;

  const top = Math.min(...pool.map((c) => c.top));
  const sameRow = pool.filter((c) => c.top <= top + lineHeight(pool[0].line) * 0.8);
  const chosen = sameRow.reduce((best, c) => (c.nameScore > best.nameScore || (c.nameScore === best.nameScore && c.height > best.height) ? c : best), sameRow[0]);

  const gstin = gstinIn(headerLines);
  // Everything under the name that still belongs to the letterhead. The window is
  // bounded both by height and by the first sign of a different section — an
  // invoice reference or another party — so a long supplier block with its
  // address, phone, email and GSTIN is never cut short.
  const issuerLines = [];
  const nameBottom = lineCenterY(chosen.line);
  for (let i = 0; i < limit; i += 1) {
    const line = headerLines[i];
    const text = cleanLine(line.text);
    if (i > 0) {
      if (lineCenterY(line) > nameBottom + medianLineHeight(headerLines) * 12) break;
      if (INVOICE_NUMBER_LABELS.some((l) => l.match.test(text))
        || INVOICE_DATE_LABELS.some((l) => l.match.test(text))
        || SELLER_LABELS.some((l) => l.match.test(text))
        || BUYER_LABELS.some((l) => l.match.test(text))) break;
      if (TOTALS_LINE.test(text) || PAYMENT_SECTION.test(text)) break;
    }
    issuerLines.push(line);
  }
  if (!issuerLines.length) issuerLines.push(chosen.line);

  return {
    name: collapseSpaces(chosen.text).replace(/[,;]$/, ''),
    nameLine: chosen.line,
    nameHeight: chosen.height,
    gstin: gstin ? validateGstin(gstin.raw) : null,
    party: extractPartyFromBlock(issuerLines, { roleLabel: 'issuer' }),
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
    if (TOTALS_LINE.test(text) || PAYMENT_SECTION.test(text)) { end = i; break; }
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

    const buckets = assignToColumns(line, columns);
    const hasNumbers = rowHasNumbers(buckets, numericKeys);

    if (hasNumbers) {
      current = {
        rawRowText: text,
        confidence: (line.confidence || 0) / 100,
        // Whether these cells came out of a PDF text layer or out of OCR matters
        // for serials: see the serial confidence cap below.
        ocr: line.source ? line.source !== 'pdf-text' : false,
        descLines: [],
        attributes: {},
        cells: buckets,
        lineIndexes: [i],
      };
      items.push(current);
    } else if (current) {
      // A description (or one of its details) continuing onto the next line.
      const descText = buckets.desc?.text
        || line.text.replace(/^\s*\d{1,3}\s*[.)-]?\s*/, '');
      current.descLines.push({ text: descText, line });
      current.lineIndexes.push(i);
    }
  }

  return items.map((raw) => finalizeItem(raw, columns));
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
function finalizeItem(raw, columns) {
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
      const value = collapseSpaces(m[1]).replace(/[,;]$/, '');
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

  // The product name is the first description line; the rest is context that
  // belongs with the item but not in its name.
  const itemName = collapseSpaces(descriptions[0] || '')
    .replace(/[.,;:]\s*$/, '');
  for (const extra of descriptions.slice(1)) {
    if (extra && extra.length > 1) notes.push(extra);
  }
  if (attributes.model) notes.push(`Model No: ${attributes.model}`);
  if (attributes.partNo) notes.push(`Part No: ${attributes.partNo}`);
  if (attributes.warranty) notes.push(`Warranty: ${attributes.warranty}`);
  if (attributes.checkNo) notes.push(`Check No: ${attributes.checkNo}`);

  const warnings = [];
  let confidence = raw.confidence || 0.8;

  const qtyRaw = has('qty') ? cell('qty') : null;
  let quantity = qtyRaw ? cellNumber(qtyRaw) : null;
  let quantityConfidence = cellConfidence('qty');

  const rateRaw = has('rate') ? cell('rate') : null;
  let unitRate = rateRaw ? cellNumber(rateRaw) : null;
  let rateConfidence = cellConfidence('rate');

  const taxableRaw = has('taxable') ? cell('taxable') : null;
  const taxableValue = taxableRaw ? cellNumber(taxableRaw) : null;

  const totalRaw = has('total') ? cell('total') : null;
  const lineTotal = totalRaw ? cellNumber(totalRaw) : null;

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
  { key: 'grandTotal', match: /\b(?:grand\s*total|invoice\s*total|total\s*(?:invoice\s*value|amount|payable|value)|net\s*amount|amount\s*payable)\b/i },
{ key: 'cgstAmount', match: /\btotal\s*cgst\b/i },
  { key: 'sgstAmount', match: /\btotal\s*sgst\b/i },
  { key: 'igstAmount', match: /\btotal\s*igst\b/i },
  // "Total CGST" / "Total SGST" are the two halves of the tax, not the total —
  // so this deliberately matches only a real tax total.
  { key: 'totalTax', match: /\b(?:total\s*tax|tax\s*total|total\s*gst|total\s+tax\s*amount)\b/i },
  { key: 'roundOff', match: /\bround\s*off\b/i },
];

function extractTotals(lines, fromIndex) {
  const totals = {};
  const start = fromIndex || 0;
  for (let i = start; i < lines.length; i += 1) {
    const text = cleanLine(lines[i].text);
    if (!text) continue;
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
          const nextValue = parseAmount(cleanLine(next.text).replace(/^[\d.,\s₹]*$/, (s) => s));
          if (nextValue !== null) { value = nextValue; confidence = (next.confidence || 0) / 100; }
        }
      }
      if (value === null) {
        const amountMatch = rest.match(/[\d][\d,]*\.?\d*/);
        if (amountMatch) value = parseAmount(amountMatch[0]);
      }
      if (value === null) continue;
      totals[key] = field(round2(value), Math.min(0.97, confidence + 0.05), 'totals-block');
    }
  }
  return totals;
}

const PAYMENT_MODE_RE = /\b(?:upi|cash|card|credit\s*card|debit\s*card|net\s*banking|bank\s*transfer|rtgs|neft|imps|cheque|check|cheq|demand\s*draft|dd|online|payment\s*gateway|finance|emi)\b/i;

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

// ── Role resolution ──────────────────────────────────────────────────────────

const sameGstin = (a, b) => Boolean(a && b && normalizeForCompare(a) === normalizeForCompare(b));
const normalizeForCompare = (value) => collapseSpaces(value).toUpperCase().replace(/[^0-9A-Z]/g, '');

function matchesOwnCompany(party, own) {
  if (!party || !own) return 0;
  if (party.gstin?.value && own.gstin && sameGstin(party.gstin.value, own.gstin)) return 1;
  return companySimilarity(party.name?.value || '', own.name || '');
}

/**
 * Decides who the supplier is.
 *
 * The company at the top of the page is the *issuer*. That is the supplier on a
 * purchase invoice and it is us on one of our own sales invoices — so the issuer
 * is compared with this application's own company first, and the labelled blocks
 * are only trusted when they do not contradict it.
 */
function resolveRoles({ issuer, sellerBlock, buyerBlocks, ownCompany }) {
  const warnings = [];
  const candidates = [];

  const issuerScore = issuer ? Math.max(0.55, (issuer.nameLine?.confidence || 0) / 100) : 0;
  if (issuer) {
    candidates.push({
      role: 'issuer',
      party: issuer.party,
      score: issuerScore + 0.1,
      note: 'Company named at the top of the document',
    });
  }
  if (sellerBlock) {
    candidates.push({
      role: 'seller-label',
      party: sellerBlock,
      score: 0.9,
      note: 'Party printed under a seller / supplier label',
    });
  }

  const ownMatchIssuer = matchesOwnCompany(issuer?.party, ownCompany);
  const ownMatchSeller = matchesOwnCompany(sellerBlock, ownCompany);
  const ownMatchBuyer = (buyerBlocks || []).reduce((best, b) => Math.max(best, matchesOwnCompany(b, ownCompany)), 0);

  let documentRole = 'purchase';
  let supplierCandidate = null;

  if (ownMatchIssuer >= 0.6) {
    // This document is one of our own sales invoices. The party buying from us
    // is the supplier for the matching purchase, but the user must confirm.
    documentRole = 'sales';
    warnings.push({
      code: 'document-is-sales-invoice',
      message: 'This invoice is issued by '
        + `${ownCompany?.name || 'this company'} (the buyer is listed as a customer). `
        + 'Please confirm the supplier manually.',
    });
    const buyer = (buyerBlocks || [])[0];
    supplierCandidate = buyer
      ? { party: buyer, score: 0.55, note: 'Party that bought the goods from the issuer', needsReview: true }
      : null;
  } else {
    const seller = candidates.find((c) => c.role === 'seller-label');
    const top = candidates.slice().sort((a, b) => b.score - a.score)[0];
    supplierCandidate = seller || top || null;
    if (ownMatchSeller >= 0.6) {
      warnings.push({
        code: 'supplier-looks-like-us',
        message: 'The party marked as supplier looks like this company. Please verify the supplier.',
      });
      supplierCandidate = { ...(supplierCandidate || {}), needsReview: true };
    }
  }

  // A buyer block that matches us is strong evidence the document really is an
  // incoming invoice.
  const confidenceBoost = ownMatchBuyer >= 0.6 ? 0.05 : 0;
  if (ownMatchBuyer >= 0.6 && documentRole === 'purchase') {
    warnings.push({
      code: 'buyer-is-us',
      message: 'The invoice names this company as the buyer, which is consistent with a purchase.',
    });
  }

  return { documentRole, supplierCandidate, warnings, ownMatchBuyer, confidenceBoost };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Reads a positioned invoice and returns everything that could be understood,
 * with a confidence value for each field. `ownCompany` ({ name, gstin }) is what
 * lets the parser tell a purchase invoice from one of our own sales invoices.
 */
function parseInvoice({ pages, ownCompany = {} } = {}) {
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
      warnings: [{ code: 'no-text', message: 'No readable text was found on this document.' }],
      confidence: 0,
    };
  }

  const tables = findItemTables(lines);
  const table = tables.length
    ? tables.slice().sort((a, b) => b.score - a.score)[0]
    : null;
  const headerLimit = table ? table.headerIndex : lines.length;

  // ── Party blocks
  const sellerHit = findLabeledValue(lines, SELLER_LABELS, { limit: headerLimit });
  const buyerHit = findLabeledValue(lines, BUYER_LABELS, { limit: headerLimit });

  const sellerBlock = sellerHit ? extractPartyFromBlock(readPartyBlock(lines, sellerHit, table), { roleLabel: 'seller' }) : null;
  const buyerBlocks = [];
  if (buyerHit) {
    // Consignee and Buyer are separate blocks; both are useful evidence.
    const seen = new Set();
    for (let i = 0; i < headerLimit; i += 1) {
      const text = cleanLine(lines[i].text);
      if (!BUYER_LABELS.some((l) => l.match.test(text))) continue;
      if (seen.has(i)) continue;
      const block = readPartyBlock(lines, { lineIndex: i }, table);
      const party = extractPartyFromBlock(block, { roleLabel: 'buyer' });
      if (party.name.value) {
        seen.add(i);
        buyerBlocks.push(party);
      }
    }
  }
  if (!buyerBlocks.length && buyerHit) {
    const party = extractPartyFromBlock(readPartyBlock(lines, buyerHit, table), { roleLabel: 'buyer' });
    if (party.name.value) buyerBlocks.push(party);
  }

  const issuer = readHeaderIssuer(lines, table);
  const roles = resolveRoles({ issuer, sellerBlock, buyerBlocks, ownCompany });
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

  // ── Invoice reference
  const numberHit = findLabeledValue(lines, INVOICE_NUMBER_LABELS, { limit: headerLimit });
  let invoiceNumber = missing('Invoice number could not be read');
  if (numberHit) {
    const raw = collapseSpaces(numberHit.raw)
      // Stop before the next label printed on the same line.
      .split(/\s{2,}|\s+(?:dated|date|dated\s*on|ref|buyer|order|gstin|po)\b/i)[0]
      .replace(/[:;,]+$/, '')
      .trim();
    const value = raw.replace(/^[:#\-–—\s]+/, '');
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

  const dateHit = findLabeledValue(lines, INVOICE_DATE_LABELS, { limit: headerLimit });
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
    invoice: { number: invoiceNumber, date: invoiceDate, dateDisplay: invoiceDateDisplay },
    items,
    totals,
    payment,
    tableDetected: Boolean(table),
    tableCount: tables.length,
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