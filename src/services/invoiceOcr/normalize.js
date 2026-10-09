// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — normalisation helpers
//
//  Everything the OCR reads arrives as free text ("Rs. 1,28,389.83", "05-Oct-26",
//  "24aabcu9603r1zm"). Before a single value is allowed anywhere near the
//  purchase form it is pushed through the helpers below, so the rest of the
//  pipeline only ever sees clean, typed values.
//
//  Two rules govern this file:
//    1. Normalise, never invent. A value that cannot be read is returned as
//       null — it is never guessed, defaulted or back-filled.
//    2. Where a value can be read several ways (05/10/2026), the ambiguity is
//       reported instead of being silently resolved.
// ─────────────────────────────────────────────────────────────────────────────

// Confidence bands used across the whole pipeline. The UI turns these into
// "✓ looks right" / "⚠ please verify" markers.
const CONFIDENCE = Object.freeze({
  TRUSTED: 0.95,
  REVIEW: 0.85,
});

/** Wraps a value together with how sure the pipeline is about it. */
function field(value, confidence = 0, source = '', warnings = []) {
  return {
    value: value === undefined || value === null ? null : value,
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    source,
    warnings: (warnings || []).filter(Boolean),
  };
}

/** A field that was deliberately left blank — no value was ever found for it. */
function missing(reason = '') {
  return { value: null, confidence: 0, source: 'not-found', warnings: reason ? [reason] : [] };
}

const confidenceBand = (confidence) => {
  const c = Number(confidence) || 0;
  if (c >= CONFIDENCE.TRUSTED) return 'trusted';
  if (c >= CONFIDENCE.REVIEW) return 'review';
  return 'verify';
};

const text = (value) => (value === undefined || value === null ? '' : String(value));

function collapseSpaces(value) {
  return text(value).replace(/\s+/g, ' ').trim();
}

/** Cleans a single OCR line without destroying the characters it contains. */
function cleanLine(value) {
  return text(value)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*([:;|])\s*/g, '$1 ')
    .trim();
}

// ── Numbers ──────────────────────────────────────────────────────────────────

/**
 * Reads an amount out of OCR text.
 * Handles "₹ 1,28,389.83", "INR 128389.83", "1,28,389.83", "Rs. 151500/-",
 * "(1,200.00)" for negatives and the "-" placeholder some invoices print in an
 * empty amount cell. Returns null when there is no number at all, so a caller
 * can never mistake "not read" for "zero".
 */
function parseAmount(value) {
  let s = collapseSpaces(value);
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^\s*-/.test(s) || /\s-\s*$/.test(s);
  s = s.replace(/[()]/g, '').replace(/[−–—]/g, '-');
  // Keep digits, separators and a leading minus only.
  s = s.replace(/[^\d.,-]/g, '');
  s = s.replace(/-/g, '');
  if (!s) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal point.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    const tail = s.length - lastComma - 1;
    // "1,28,389" (Indian grouping) vs "128,389.83" vs a lone "1234,56".
    if (tail === 2 && /^\d{1,3}(,\d{3})+,\d{2}$/.test(s)) s = s.replace(/,/g, '');
    else if (tail === 2 && /,\d{2}$/.test(s) && !/^\d{1,3}(,\d{3})+,\d{2}$/.test(s)) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
  }
  s = s.replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const num = Number.parseFloat(s);
  if (!Number.isFinite(num)) return null;
  return negative ? -Math.abs(num) : num;
}

/** Quantity — same reader as an amount, but blank/zero/one never invented. */
function parseQty(value) {
  const num = parseAmount(value);
  if (num === null) return null;
  return num;
}

// A table cell that should hold a number: an optional currency prefix, digits
// with Indian or plain grouping, an optional decimal and an optional "%".
// An amount is very often printed with thousands separators - "1,200.00",
// "2,350.00". Those were rejected here, because only the currency-prefixed branch
// allowed commas, so every such amount came back as "no value" and the rate,
// amount and totals columns read empty even though OCR had read them correctly.
// Comma grouping is therefore accepted on the bare-number branch too. It stays
// strict - groups of exactly three digits, only where thousands separators go -
// so a serial such as "T1N0CV01Z128019" is still not a number.
const NUMERIC_CELL_RE = /^(?:rs\.?|inr|₹)\s*\(?-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\)?%?$|^\(?-?(?:rs\.?|inr|₹)?\s*-?\d+(?:,\d{3})*(?:\.\d{1,2})?\)?%?$/i;
// Some invoices print a bare dash or a bullet in an amount column they did not
// fill in. That is an empty cell, not a zero and not a number.
const EMPTY_CELL_RE = /^[-–—.,*\s]*$/;

function isNumericCell(value) {
  const s = collapseSpaces(value);
  if (!s) return false;
  return NUMERIC_CELL_RE.test(s);
}

/**
 * Reads a table cell that is supposed to contain a number.
 *
 * This is stricter than parseAmount on purpose. A description like
 * "Serial No: T1N0CV01Z128019" contains digits, and reading it as "100128019"
 * would turn one product into a second, phantom purchase line. A cell only
 * counts as a number when the whole cell is one.
 */
function cellNumber(value) {
  const s = collapseSpaces(value);
  if (!s || EMPTY_CELL_RE.test(s)) return null;
  if (!isNumericCell(s)) return null;
  return parseAmount(s);
}

/** "9%", "9 %", "CGST 9%" → 9. */
function parsePercent(value) {
  const s = collapseSpaces(value);
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) return Number.parseFloat(m[1]);
  // A bare number is only a percentage when the surrounding label says so.
  const bare = s.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) return Number.parseFloat(bare[1]);
  return null;
}

/** Rounds to paise so repeated maths never drifts past the invoice. */
const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round((Number(n) + Number.EPSILON) * 100) / 100 : 0);

/** Absolute difference, used by every "does it match?" comparison. */
const diff = (a, b) => Math.abs(round2(a) - round2(b));

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Normalises any readable date to the two shapes the purchase form needs:
 *   iso      → "YYYY-MM-DD" for <input type="date"> and the DATE column
 *   display  → "DD-MM-YYYY" for showing to the user
 * Returns null when nothing date-like is present. Ambiguous day/month order is
 * reported through `ambiguous` rather than resolved silently.
 */
function normalizeDate(value) {
  const s = collapseSpaces(value);
  if (!s) return null;

  let year = null, month = null, day = null, ambiguous = false;
  const yearFirst = s.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  const dayFirst = s.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  const named = s.match(/\b(\d{1,2})[\s-]*([A-Za-z]{3,9})[\s-]*(\d{2,4})\b/);
  const monthFirst = s.match(/\b([A-Za-z]{3,9})[\s-]*(\d{1,2}),?[\s-]*(\d{2,4})\b/);

  if (yearFirst) {
    year = Number(yearFirst[1]);
    month = Number(yearFirst[2]);
    day = Number(yearFirst[3]);
  } else if (named) {
    const mon = MONTHS[String(named[2]).toLowerCase()];
    if (mon) {
      day = Number(named[1]);
      month = mon;
      year = Number(named[3]);
    }
  } else if (monthFirst) {
    const mon = MONTHS[String(monthFirst[1]).toLowerCase()];
    if (mon) {
      month = mon;
      day = Number(monthFirst[2]);
      year = Number(monthFirst[3]);
    }
  } else if (dayFirst) {
    const a = Number(dayFirst[1]);
    const b = Number(dayFirst[2]);
    year = Number(dayFirst[3]);
    // Indian invoices are written day-first; a first part above 12 proves it.
    if (a > 12) { day = a; month = b; }
    else if (b > 12) { day = b; month = a; }
    else { day = a; month = b; ambiguous = true; }
  }

  // OCR sometimes fuses a stray mark onto the day, so a date can arrive as
  // "56-Oct-26" where the day is plainly 5. A day above 31 is never a real day,
  // and reading its leading digits is the only reading that stays inside the
  // month. It is marked ambiguous so the reviewer still sees the original.
  if (day > 31) {
    const digits = String(day);
    const leading = Number(digits[0]);
    if (leading >= 1 && leading <= 9) { day = leading; ambiguous = true; }
  }

  if (!year || !month || !day) return null;
  if (year < 100) year += year > 70 ? 1900 : 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (asDate.getUTCMonth() !== month - 1 || asDate.getUTCDate() !== day) return null;

  return {
    iso: `${asDate.getUTCFullYear()}-${pad2(asDate.getUTCMonth() + 1)}-${pad2(asDate.getUTCDate())}`,
    display: `${pad2(asDate.getUTCDate())}-${pad2(asDate.getUTCMonth() + 1)}-${asDate.getUTCFullYear()}`,
    ambiguous,
  };
}

// ── GSTIN ────────────────────────────────────────────────────────────────────

const GSTIN_STRUCTURE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GST_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// GST state codes → state names, used to fill State from a GSTIN when the
// invoice prints no explicit "State" line. Only ever used when a valid GSTIN
// was actually read, never invented from a bare number.
const GST_STATE_CODES = Object.freeze({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
});

// Characters OCR routinely swaps inside a GSTIN. Grouped by resemblance, so a
// candidate is repaired by trying the members of the group a character belongs
// to. A repair is only ever accepted when the result passes the real checksum,
// so this can improve a damaged number but cannot invent one.
const GSTIN_LOOKALIKES = [
  '0OQD', '1IL', '2Z', '5S', '6GEB', '8B', '7T', '4AD', '9P', 'UE', 'VY', 'MC', 'KN', 'X',
];

/** The characters a position could have been misread as, excluding itself. */
function gstinAlternatives(ch) {
  const up = ch.toUpperCase();
  const out = new Set();
  for (const group of GSTIN_LOOKALIKES) {
    const g = group.toUpperCase();
    if (g.includes(up)) for (const m of g.split('')) if (m !== up) out.add(m);
  }
  return [...out].slice(0, 3);
}

/**
 * Repairs a GSTIN that OCR mangled, but only by way of the checksum.
 *
 * Returns `{ value, repaired }`: `value` is a checksum-valid GSTIN, and
 * `repaired` says whether the characters were changed to get there. When more
 * than one repair passes, nothing is changed - a genuine ambiguity is reported
 * rather than guessed at.
 */
function repairGstin(value) {
  const original = normalizeGstin(value);
  if (!original || original.length !== 15) return { value: original || null, repaired: false };
  if (validateGstin(original).checksumOk) return { value: original, repaired: false };

  const options = [];
  for (let i = 0; i < 15; i += 1) {
    const ch = original[i];
    const alternatives = gstinAlternatives(ch);
    options.push(alternatives.length ? [ch, ...alternatives] : [ch]);
  }

  // At most three characters may be reinterpreted. A GSTIN whose checksum can
  // also be satisfied by four or five other spellings carries no information
  // about which one was printed, so the search is deliberately bounded: a repair
  // is only reported when it is the single reading the arithmetic allows.
  const MAX_EDITS = 3;
  const found = [];
  const walk = (index, acc, edits) => {
    if (found.length > 1) return;
    if (index === 15) {
      const candidate = acc.join('');
      if (GSTIN_STRUCTURE.test(candidate) && gstinChecksumDigit(candidate.slice(0, 14)) === candidate[14]) {
        found.push(candidate);
      }
      return;
    }
    for (const ch of options[index]) {
      const nextEdits = edits + (ch === original[index] ? 0 : 1);
      if (nextEdits > MAX_EDITS) continue;
      acc.push(ch);
      walk(index + 1, acc, nextEdits);
      acc.pop();
    }
  };
  walk(0, [], 0);
  if (found.length !== 1) return { value: original, repaired: false };
  return { value: found[0], repaired: true };
}

/**
 * Resolves a printed state name to its canonical spelling.
 *
 * The printed word is matched against the state table by resemblance, so a single
 * misread letter ("Gujaral" for Gujarat) resolves correctly while a genuinely
 * different state never does - the match has to be within a couple of edits of
 * one real state and nothing else. An unrecognised name is returned uppercased
 * and unchanged rather than guessed at.
 */
function normalizeState(value) {
  const raw = collapseSpaces(value || '').toUpperCase().replace(/\b(STATE|STATE\s*NAME)\s*[:\-]?\s*/g, '').trim();
  if (!raw) return { value: null, matched: false };
  const names = [...new Set(Object.values(GST_STATE_CODES))];
  const exact = names.find((n) => n.toUpperCase() === raw);
  if (exact) return { value: exact.toUpperCase(), matched: true };
  const short = raw.split(/\s+/)[0];
  const exactShort = names.find((n) => n.toUpperCase() === short);
  if (exactShort) return { value: exactShort.toUpperCase(), matched: true };
  let best = null;
  for (const name of names) {
    const d = editDistance(raw, name.toUpperCase());
    if (!best || d < best.d) best = { name, d };
  }
  const threshold = Math.max(1, Math.floor(raw.length / 4));
  if (best && best.d <= threshold) return { value: best.name.toUpperCase(), matched: true };
  return { value: raw, matched: false };
}

/** Levenshtein distance, used only to recognise a near-miss state name. */
function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  const prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= t.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= t.length; j += 1) prev[j] = row[j];
  }
  return prev[t.length];
}

/** Uppercases and strips the spaces OCR likes to insert inside a GSTIN. */
function normalizeGstin(value) {
  const s = collapseSpaces(value).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.startsWith('GSTIN')) return s.slice(5);
  return s;
}

/**
 * The GSTIN check digit (position 15). Returns null when the shape is wrong,
 * so it is never confused with "failed checksum".
 */
function gstinChecksumDigit(first14) {
  if (!/^[0-9A-Z]{14}$/.test(first14)) return null;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = GST_CHARSET.indexOf(first14[i]);
    if (value < 0) return null;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GST_CHARSET[(36 - (sum % 36)) % 36];
}

/**
 * Grades a GSTIN candidate: does it merely look like one, or is it a real one?
 * `shapeOk` is structural, `checksumOk` is the arithmetic check digit. OCR
 * frequently mangles a perfectly valid GSTIN, so a failed checksum lowers the
 * confidence but never silently "corrects" the number.
 */
function validateGstin(value) {
  const candidate = normalizeGstin(value);
  const shapeOk = GSTIN_STRUCTURE.test(candidate);
  const checksumOk = shapeOk ? gstinChecksumDigit(candidate.slice(0, 14)) === candidate[14] : false;
  return {
    value: candidate || null,
    lengthOk: candidate.length === 15,
    shapeOk,
    checksumOk,
    stateCode: shapeOk ? candidate.slice(0, 2) : null,
    state: shapeOk ? GST_STATE_CODES[candidate.slice(0, 2)] || null : null,
    valid: shapeOk && checksumOk,
  };
}

/**
 * The handful of character swaps OCR actually makes inside a GSTIN
 * (0↔O, 1↔I, 5↔S, 8↔B, 2↔Z). Returns a repaired candidate only when the
 * repair produces a structurally valid GSTIN — offered to the user as a
 * suggestion, never applied behind their back.
 */
function suggestGstinRepairs(value) {
  const base = normalizeGstin(value);
  if (!base || base.length !== 15) return [];
  const swaps = { 0: 'O', O: '0', 1: 'I', I: '1', 5: 'S', S: '5', 8: 'B', B: '8', 2: 'Z', Z: '2' };
  const seen = new Set();
  const out = [];
  for (let i = 0; i < base.length; i += 1) {
    const swap = swaps[base[i]];
    if (!swap) continue;
    const candidate = base.slice(0, i) + swap + base.slice(i + 1);
    if (candidate === base || seen.has(candidate)) continue;
    seen.add(candidate);
    const graded = validateGstin(candidate);
    if (graded.shapeOk) out.push(candidate);
    if (out.length >= 3) break;
  }
  return out;
}

// ── Contact details ──────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function findEmail(value) {
  const m = collapseSpaces(value).match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

/** Indian phone numbers, kept as digits with a country code when we can see one. */
function normalizePhone(value) {
  let s = collapseSpaces(value);
  if (!s) return null;
  // Strip the label ("Ph:", "Mobile:", "+91") from the front.
  s = s.replace(/^(ph|phone|mob|mobile|contact|tel|telephone|contact\s*no|phone\s*no)\b\.?\s*:?\s*/i, '');
  const plus91 = /\+\s*91[\s-]*/.test(s) || /\b91[\s-]\d{10}\b/.test(s);
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  if (s.length === 12 && s.startsWith('91')) { s = s.slice(2); }
  else if (s.length === 13 && s.startsWith('0091')) { s = s.slice(4); }
  else if (s.length === 10 && plus91 === false) {
    // An Indian mobile/local number without a country code — kept as typed.
    return s;
  }
  if (s.length === 10) return s;
  if (s.length === 12 && s.startsWith('91')) return s.slice(2);
  if (s.length >= 11 && s.length <= 15) return s;
  return s.length <= 15 ? s : null;
}

function looksLikePhone(value) {
  const s = collapseSpaces(value).replace(/[^\d]/g, '');
  return s.length >= 10 && s.length <= 13;
}

/** A standalone 6-digit pincode. "Vadodara-07" is a district code, not one. */
function findPincode(value) {
  const m = collapseSpaces(value).match(/(?:^|[^0-9-])(\d{6})(?![\d-])/);
  return m ? m[1] : null;
}

const PIN_RE = /\b[1-9]\d{5}\b/;

// ── Text comparison (party roles) ────────────────────────────────────────────

/** Words that carry no identity ("pvt", "ltd", "the", "&", ...). */
const COMPANY_NOISE = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company', 'the', 'and',
  'llp.', 'pvt.', 'ltd.', 'store', 'stores', 'shop', 'dealer', 'dealers', 'agency',
  'enterprises', 'traders', 'systems', 'system', 'solution', 'solutions', 'technologies',
]);

const companyTokens = (value) => collapseSpaces(value)
  .toLowerCase()
  .replace(/[^\w\s&]/g, ' ')
  .split(/\s+/)
  .filter((t) => t && !COMPANY_NOISE.has(t));

/**
 * How alike two company names are (0–1). Used to decide whether the company at
 * the top of the invoice is this application's own company — which flips the
 * meaning of the whole document from "a purchase" to "one of our own sales".
 */
function companySimilarity(a, b) {
  const ta = companyTokens(a);
  const tb = companyTokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t)).length;
  if (!shared) return 0;
  const ratio = shared / Math.max(ta.length, tb.length);
  const setA = new Set(ta);
  const coverage = shared / Math.min(ta.length, tb.length);
  return Math.min(1, 0.5 * ratio + 0.5 * coverage);
}

// ── OCR-tolerant label matching ──────────────────────────────────────────────

/**
 * Levenshtein distance, abandoned early once it passes `cap`.
 *
 * OCR reliably mangles *labels* — "Bill To" comes back as "Bl to", "Invoice No"
 * as "Involce No", "GSTIN/UIN" as "GSTIN/VIN". A label is short, fixed text
 * printed in the same typeface on every invoice, so it is the easiest thing on
 * the page to read exactly and the most damaging to get wrong: miss the label
 * and the whole block under it is never opened.
 */
function levenshtein(a, b, cap = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      if (current[j] < rowBest) rowBest = current[j];
    }
    if (rowBest > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length];
}

const labelTokens = (text) => collapseSpaces(text)
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter(Boolean);

/**
 * The same words as `labelTokens`, but each with where it sits in the original
 * string.
 *
 * The character offsets matter: the caller slices the line to take "everything
 * beside the label" as the value, and slicing by token number instead cut the
 * value out of the wrong place entirely.
 */
function labelTokensWithPositions(text) {
  const out = [];
  const re = /[a-z0-9]+/gi;
  let m = re.exec(String(text || ''));
  while (m) {
    out.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
    m = re.exec(String(text || ''));
  }
  return out;
}

/**
 * Finds a label phrase written as a run of words, tolerating an OCR slip in any
 * one of them. `phrases` is a list of word-arrays: `[['bill','to'], ['buyer']]`.
 *
 * Returns `{ index, length }` as **character** offsets into `text` — the same
 * shape a regular-expression match gives the caller, so the label's own value
 * extraction (everything beside it) works identically either way.
 */
function findPhrase(text, phrases, { tolerance = 1, maxWords = 0 } = {}) {
  const tokens = labelTokensWithPositions(text);
  if (!tokens.length || !phrases || !phrases.length) return null;
  const limit = maxWords > 0 ? Math.min(maxWords, tokens.length) : tokens.length;

  for (const phrase of phrases) {
    if (!phrase.length || phrase.length > limit) continue;
    for (let i = 0; i + phrase.length <= limit; i += 1) {
      let ok = true;
      for (let j = 0; j < phrase.length; j += 1) {
        const seen = tokens[i + j].word;
        const want = phrase[j];
        if (seen === want) continue;
        // A digit read as a letter ("t0" for "to") is the commonest slip of all.
        const numeric = (s) => s.replace(/0/g, 'o').replace(/1/g, 'l');
        if (numeric(seen) === numeric(want)) continue;
        if (Math.abs(seen.length - want.length) > tolerance) { ok = false; break; }
        if (levenshtein(seen, want, tolerance) > tolerance) { ok = false; break; }
      }
      if (ok) {
        const start = tokens[i].start;
        const end = tokens[i + phrase.length - 1].end;
        return { index: start, length: end - start };
      }
    }
  }
  return null;
}

module.exports = {
  CONFIDENCE,
  field,
  missing,
  confidenceBand,
  text,
  collapseSpaces,
  cleanLine,
  parseAmount,
  parseQty,
  parsePercent,
  cellNumber,
  isNumericCell,
  round2,
  diff,
  normalizeDate,
  normalizeGstin,
  validateGstin,
  repairGstin,
  normalizeState,
  suggestGstinRepairs,
  gstinChecksumDigit,
  GST_STATE_CODES,
  findEmail,
  normalizePhone,
  looksLikePhone,
  findPincode,
  PIN_RE,
  companySimilarity,
  companyTokens,
  COMPANY_NOISE,
  levenshtein,
  findPhrase,
};