// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — supplier field ownership
//
//  The supplier block is the clearest proof that an OCR line is not a field. This
//  invoice prints, inside ONE header area:
//
//      JBR SOLUTIONS
//      ™M-35, PANORAMA COMPLEX, … ALKAPURI, VADODARA-390007
//      Mo 9601740014,8487961404
//      GSTIN/VIN: 2dFOZPPSBESL1ZP
//      Stale Name: Gujaral, Code: 24
//      E-Mail pravinrajpurohit808@gmail.com
//
//  Reading that line by line and appending each line to the address is what put a
//  phone number, a GSTIN and a state name into a party's postal address. It also
//  left GSTIN, phone, city, state and pincode empty, because they were never
//  treated as fields of their own.
//
//  So the unit here is the OCR word. Anchors claim the words that follow them,
//  and whatever is left over is the address. Nothing is removed from a finished
//  string — each word is claimed once, and the address is assembled from the words
//  nobody else took.
//
//  Nothing in this file knows this particular invoice. The anchors are ordinary
//  invoice labels, matched leniently because OCR renders "Mobile" as "Mo" and
//  "State Name" as "Stale Name".
// ─────────────────────────────────────────────────────────────────────────────

const { orderByLine, buildVisualRows } = require('./words');
const { normalizePhone, findEmail } = require('./normalize');

// ── Anchors ──────────────────────────────────────────────────────────────────
//
// Each anchor is matched on a normalised form (letters and digits only) with a
// small edit tolerance, so OCR dropping or swapping a letter does not lose a
// field. `words` is how many consecutive OCR words the label is allowed to span.

const PHONE_ANCHORS = [
  { forms: ['mobile', 'mob', 'mobileno', 'mo', 'm0', 'ph', 'phoneno', 'phone', 'tel', 'telephone'], span: 1 },
];

const GSTIN_ANCHORS = [
  // span 1: the label is one word ("GSTIN/VIN:"). A span of 2 swallowed the value
  // that follows it — "2dFOZPPSBESL1ZP" was being claimed as part of the label
  // and the GSTIN field came back empty.
  { forms: ['gstin', 'gstinuin', 'gstinvin', 'gstn', 'gst', 'gstno', 'gstnumber', 'gstinuid'], span: 1 },
];

const STATE_ANCHORS = [
  // "State Name" mis-read as "Stale Name" is the commonest failure here.
  { forms: ['state', 'stale', 'statename', 'stalename', 'statecode'], span: 2 },
];

const EMAIL_ANCHORS = [
  // Deliberately no bare "e": a one-letter label matches almost any short token
  // within one substitution, which is how "C", "Mo", "24" and "to)" all ended up
  // claimed as an email label. A label must be a real word.
  { forms: ['email', 'emailid', 'mail', 'emailaddress', 'e-mail'], span: 1 },
];

// A GSTIN is 15 characters; OCR routinely reads a neighbouring token as part of
// it, so the value is gathered up to and including a token that reaches 15.
const GSTIN_TARGET_LENGTH = 15;

const isPhoneDigits = (text) => /\d/.test(text) && text.replace(/\D/g, '').length >= 10;

function normalized(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** How many leading characters of `value` differ from `form` (capped). */
function leadingDistance(value, form) {
  const a = normalized(value);
  const b = normalized(form);
  if (!a || !b) return 99;
  const n = Math.min(a.length, b.length, 4);
  let d = 0;
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
}

/**
 * True when a word could plausibly BE a printed label.
 *
 * Labels are words. "™M-35" differs from "Mo" by one character and was being
 * read as a phone label; "24" differs from "e" by one character and was being
 * read as an email label. A token carrying digits is a value, never a label.
 */
function couldBeLabel(word) {
  const text = String(word || '').trim();
  if (!text) return false;
  // A label may carry its own colon or full stop ("GSTIN/VIN:", "E-Mail."), so
  // punctuation at either end is stripped before the decision rather than
  // disqualifying it — that is why the GSTIN label fell out of ownership.
  const bare = text.replace(/^[^\w]+|[^\w]+$/g, '');
  if (!bare) return false;
  if (/\d/.test(bare)) return false;
  return /^[A-Za-z][A-Za-z\s.\-/&']{0,24}$/.test(bare);
}

/**
 * Finds an anchor starting at a word, returning how many words it spans.
 * `state` and `state name` are two words, so those anchors allow a span of 2.
 */
function matchAnchor(words, index, anchors) {
  const first = words[index];
  if (!first || !couldBeLabel(first.text)) return null;
  for (const anchor of anchors) {
    const span = anchor.span || 1;
    for (let n = span; n >= 1; n -= 1) {
      const candidate = words.slice(index, index + n).map((w) => w.text).join('');
      for (const form of anchor.forms) {
        if (normalized(candidate) === form) return { form, span: n };
        // One slipped character is normal OCR, not a different label — but only
        // when the word is long enough for a single substitution to mean
        // something. "C" is one substitution from "Mo" and from "e"; that is not
        // evidence of anything.
        if (normalized(candidate).length >= 3
          && leadingDistance(candidate, form) === 1
          && Math.abs(normalized(candidate).length - form.length) <= 1) {
          return { form, span: n, fuzzy: true };
        }
      }
    }
  }
  return null;
}

/** "9601740014,8487961404" → ["9601740014", "8487961404"] */
function splitPhoneRun(value) {
  const parts = String(value || '').split(/[,;/|&\s]+/).map((s) => s.trim()).filter(Boolean);
  return parts.filter((p) => p.replace(/\D/g, '').length >= 6);
}

/** A token may hide a city and a pincode: "ALKAPURI,VADODARA-390007". */
function derivePlaceParts(text) {
  const value = String(text || '');
  const pincodeMatch = value.match(/\b(\d{6})\b/);
  if (!pincodeMatch) return null;
  const pincode = pincodeMatch[1];
  const beforePin = value.slice(0, pincodeMatch.index).replace(/[-\s]+$/, '');
  const commaAt = beforePin.lastIndexOf(',');
  const city = commaAt >= 0 ? beforePin.slice(commaAt + 1).trim() : '';
  return {
    pincode,
    city: city.replace(/[^A-Za-z .'-]/g, '').trim(),
    locality: commaAt >= 0 ? beforePin.slice(0, commaAt).trim() : beforePin,
  };
}

/**
 * A state name is recognised by being a plausible name near a "State"/"Stale"
 * label — not by being spelled exactly. "Gujaral" and "Gujarat" are the same
 * state as far as the reader is concerned; the raw text is kept either way.
 */
function tidyStateName(raw) {
  const value = String(raw || '').replace(/[,;.]+$/, '').trim();
  if (!value) return { value: null, confidence: 0 };
  const letters = value.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return { value, confidence: 0.3 };
  return { value: value.toUpperCase(), confidence: 0.82, rawValue: value };
}

/**
 * Claims every word of a supplier block to exactly one field.
 *
 * Returns the field values plus the claim map, so every value can be traced back
 * to the words and the box it was printed in.
 */
function claimSupplierFields(words) {
  const ordered = orderByLine(words || []);
  const claims = new Map();          // index → field name
  const evidence = {};               // field → { sourceWordIndexes, rawValue, bbox }
  const note = (field, index, word) => {
    claims.set(index, field);
    const entry = evidence[field] || (evidence[field] = {
      sourceWordIndexes: [], rawValue: '', bbox: null, region: 'supplier', method: 'word-anchor',
    });
    entry.sourceWordIndexes.push(index);
    entry.rawValue = entry.rawValue ? `${entry.rawValue} ${word.text}` : word.text;
    if (!entry.bbox) entry.bbox = { x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1 };
    else {
      entry.bbox.x0 = Math.min(entry.bbox.x0, word.x0);
      entry.bbox.y0 = Math.min(entry.bbox.y0, word.y0);
      entry.bbox.x1 = Math.max(entry.bbox.x1, word.x1);
      entry.bbox.y1 = Math.max(entry.bbox.y1, word.y1);
    }
  };

  // ── Party name: the topmost row of the block, up to the first word that
  // starts another field. A company name is several words ("JBR SOLUTIONS") and
  // is ONE field, so every word of that run is claimed. An earlier version
  // reverted the claim when it counted a single word, which lost the name
  // entirely and dropped it into the address.
  const rows = buildVisualRows(ordered);
    let nameClaimed = 0;
    if (rows.length) {
      const maxRight = ordered.reduce((m, w) => Math.max(m, w.x1 || 0), 0);
      // A company name never starts with a digit, and a row that is nothing but a
      // printed label is a heading, not a name. OCR fragments the top of the page
      // ("© 23 AANEB308 M126", "or2094", "CIRIENT)") regularly land in the first
      // visual rows — fragments of the invoice-metadata column printed beside the
      // letterhead, all starting well right of the page's middle. Skipping down to
      // the first real left-hand name row keeps the letterhead's actual name
      // instead of a fragment of the column beside it.
      const rowIsAnchorRow = (row) => row.words.every((w) => (
        matchAnchor(ordered, ordered.indexOf(w), PHONE_ANCHORS)
        || matchAnchor(ordered, ordered.indexOf(w), GSTIN_ANCHORS)
        || matchAnchor(ordered, ordered.indexOf(w), STATE_ANCHORS)
        || matchAnchor(ordered, ordered.indexOf(w), EMAIL_ANCHORS)));
    let nameRowIndex = 0;
      while (nameRowIndex < rows.length) {
        const row = rows[nameRowIndex];
        const firstWord = row.words[0];
        const digitLeading = Boolean(firstWord && /\d/.test(firstWord.text));
        const rightColumn = Boolean(firstWord && maxRight > 100 && (firstWord.x0 || 0) > maxRight * 0.5);
        if (!rowIsAnchorRow(row) && !digitLeading && !rightColumn) break;
        nameRowIndex += 1;
      }
      if (nameRowIndex >= rows.length) nameRowIndex = 0;
      const firstRow = rows[nameRowIndex];
      const rowIsAnchor = rowIsAnchorRow(firstRow);
    if (!rowIsAnchor) {
      for (const w of firstRow.words) {
        const index = ordered.indexOf(w);
        if (index < 0 || claims.has(index)) continue;
        note('partyName', index, w);
        nameClaimed += 1;
      }
    }
    // A row that is nothing but a label is a heading, not a company.
    if (nameClaimed === 0 || firstRow.words.every((w) => /^[^\w]+$/.test(w.text))) {
      for (const key of [...claims.keys()]) if (claims.get(key) === 'partyName') claims.delete(key);
      delete evidence.partyName;
    }
  }

  // ── Anchors claim the words that follow them.
  for (let i = 0; i < ordered.length; i += 1) {
    if (claims.has(i)) continue;
    const word = ordered[i];

    const email = matchAnchor(ordered, i, EMAIL_ANCHORS);
    if (email) {
      note('emailLabel', i, word);
      for (let n = 1; n <= 2 && i + n < ordered.length; n += 1) {
        const candidate = ordered[i + n];
        if (claims.has(i + n)) break;
        const found = findEmail(candidate.text);
        if (found) {
          note('email', i + n, candidate);
          (evidence.email || (evidence.email = {})).normalizedValue = found;
          (evidence.email || (evidence.email = {})).confidence = Math.max(0.6, candidate.confidence);
          break;
        }
        // An anchor may swallow the colon into its own word.
        if (/^[:.\-]+$/.test(candidate.text)) note('emailLabel', i + n, candidate);
      }
      continue;
    }

    const gstin = matchAnchor(ordered, i, GSTIN_ANCHORS);
    if (gstin) {
      for (let n = 0; n < gstin.span; n += 1) if (!claims.has(i + n)) note('gstinLabel', i + n, ordered[i + n]);
      let accumulated = '';
      const start = i + gstin.span;
      for (let n = start; n < Math.min(ordered.length, start + 3); n += 1) {
        const candidate = ordered[n];
        if (claims.has(n)) break;
        const bare = candidate.text.replace(/[^0-9A-Za-z]/g, '');
        // A GSTIN mixes letters and digits. A run of ten or more digits is a
        // phone number that happens to sit beside the label, and must not be
        // swallowed as the tax number.
        if (!bare) break;
        if (/^\d+$/.test(bare) && bare.length >= 10) break;
        if (!/\d/.test(bare)) break;
        accumulated += bare;
        note('gstin', n, candidate);
        if (accumulated.length >= GSTIN_TARGET_LENGTH) break;
      }
      continue;
    }

    // The state anchor owns the whole printed state metadata — "State Name: Gujarat,
      // Code: 24". The code is not part of the state's name and is not part of the
      // address either; leaving it unclaimed is what put "Code : 24" into the
      // supplier's postal address.
      const state = matchAnchor(ordered, i, STATE_ANCHORS);
    if (state) {
      for (let n = 0; n < state.span; n += 1) if (!claims.has(i + n)) note('stateLabel', i + n, ordered[i + n]);
      let sawValue = false;
      for (let n = i + state.span; n < Math.min(ordered.length, i + state.span + 5); n += 1) {
        const candidate = ordered[n];
        if (claims.has(n)) break;
        if (/^(?:code|state|code:)?[.:]*$/i.test(candidate.text)) { note('stateLabel', n, candidate); continue; }
        if (!/[A-Za-z]{3,}/.test(candidate.text)) { note('stateLabel', n, candidate); continue; }
        if (!sawValue) {
          const tidied = tidyStateName(candidate.text);
          if (tidied.value) {
            sawValue = true;
            note('state', n, candidate);
            (evidence.state || (evidence.state = {})).normalizedValue = tidied.value;
            (evidence.state || (evidence.state = {})).confidence = tidied.confidence;
            (evidence.state || (evidence.state = {})).rawValue = tidied.rawValue || candidate.text;
            continue;
          }
        }
        break;
      }
      // "Code: 24" belongs to the same printed metadata group.
      for (let n = i + state.span; n < Math.min(ordered.length, i + state.span + 5); n += 1) {
        const candidate = ordered[n];
        if (claims.has(n)) break;
        if (/^(?:code)[.:]*$/i.test(candidate.text)) { note('stateCode', n, candidate); continue; }
        if (/^[:.,-]+$/.test(candidate.text) && claims.get(n - 1) === 'stateCode') { note('stateCode', n, candidate); continue; }
        if (/^\d{1,2}$/.test(candidate.text) && claims.get(n - 1) === 'stateCode') {
          note('stateCode', n, candidate);
          const e = evidence.state || (evidence.state = {});
          e.code = candidate.text;
          break;
        }
        break;
      }
      continue;
    }

    const phone = matchAnchor(ordered, i, PHONE_ANCHORS);
    if (phone) {
      note('phoneLabel', i, word);
      // Spatial, not sequential: the label and its number are printed side by
      // side, and reading in document order walks through the GSTIN label in
      // between them. So the value is the nearest phone-shaped word on the label's
      // own row — or the nearest one to its row if the print wrapped.
      let best = null;
      for (let n = 0; n < ordered.length; n += 1) {
        const candidate = ordered[n];
        if (n === i || claims.has(n)) continue;
        if (!isPhoneDigits(candidate.text)) continue;
        const dy = Math.abs(candidate.centerY - word.centerY);
        const rightOf = candidate.centerX >= word.centerX ? 0 : 1;
        const rank = dy + rightOf * 1000;
        if (!best || rank < best.rank) best = { n, candidate, rank };
      }
      if (best) {
        note('phone', best.n, best.candidate);
        const numbers = splitPhoneRun(best.candidate.text).map((p) => normalizePhone(p)).filter(Boolean);
        if (numbers.length) {
          const e = evidence.phone || (evidence.phone = {});
          e.normalizedValue = numbers.join(', ');
          e.confidence = Math.max(0.6, best.candidate.confidence);
        }
      }
    }
  }

  // ── Noise: a printed mark that belongs to no field.
  //
  // Only bare, unclaimed tokens are treated as noise, and only when they cannot be
  // part of an address, a number, a description or an identifier. A global symbol
  // strip would corrupt real values; this classifies instead of deleting.
  const NOISE_RE = /^[©®™§#*+~^=~°]+$/;
  for (let i = 0; i < ordered.length; i += 1) {
    if (claims.has(i)) continue;
    if (!NOISE_RE.test(ordered[i].text.trim())) continue;
    claims.set(i, 'noise');
    (evidence.noise || (evidence.noise = {
      sourceWordIndexes: [], rawValue: '', bbox: null, region: 'supplier', method: 'noise-symbol',
    })).sourceWordIndexes.push(i);
  }

  // ── Address: whatever nobody claimed, in reading order.
  const addressWords = ordered.filter((w, i) => !claims.has(i));

  // A place can hide inside one address word: "ALKAPURI,VADODARA-390007".
  let city = null;
  let pincode = null;
  const addressTokens = [];
  for (const w of addressWords) {
    const parts = derivePlaceParts(w.text);
    if (parts && parts.pincode) {
      addressTokens.push(w.text);
      if (!pincode) {
        pincode = parts.pincode;
        claims.set(ordered.indexOf(w), 'pincode');
        (evidence.pincode = {
          sourceWordIndexes: [ordered.indexOf(w)], rawValue: w.text, derivedPart: parts.pincode,
          bbox: { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }, region: 'supplier', method: 'token-split',
        });
      }
      if (!city && parts.city) {
        city = parts.city;
        claims.set(ordered.indexOf(w), 'city');
        (evidence.city = {
          sourceWordIndexes: [ordered.indexOf(w)], rawValue: w.text, derivedPart: parts.city,
          bbox: { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }, region: 'supplier', method: 'token-split',
        });
      }
      continue;
    }
    addressTokens.push(w.text);
  }

  const address = buildVisualRows(addressWords)
    .map((row) => row.text)
    .join(', ')
    .replace(/,\s*,+/g, ', ')
    .replace(/^,|,$/g, '')
    .trim();

  const claimMap = ordered.map((w, i) => ({ text: w.text, centerX: Math.round(w.centerX), centerY: Math.round(w.centerY), owner: claims.get(i) || 'ADDRESS' }));

  return {
    partyName: (evidence.partyName ? evidence.partyName.rawValue : '') || null,
    address,
    city,
    state: evidence.state ? evidence.state.normalizedValue : null,
    stateRaw: evidence.state ? (evidence.state.rawValue || evidence.state.rawValue) : null,
    pincode,
    phone: evidence.phone ? evidence.phone.normalizedValue : null,
    phoneRaw: evidence.phone ? evidence.phone.rawValue : null,
    gstin: evidence.gstin ? evidence.gstin.rawValue : null,
    email: evidence.email ? (evidence.email.normalizedValue || evidence.email.rawValue) : null,
    emailRaw: evidence.email ? evidence.email.rawValue : null,
    evidence,
    claimMap,
    addressWords: addressTokens,
  };
}

module.exports = {
  claimSupplierFields,
  splitPhoneRun,
  derivePlaceParts,
  matchAnchor,
  normalized,
};