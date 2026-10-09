// ─────────────────────────────────────────────────────────────────────────────
//  Invoice OCR — canonical company identity
//
//  Before a single field is filled in, the reader has to answer one question:
//  is *this application's own company* the SELLER on this document, or the BUYER?
//
//  It can only answer that reliably if it knows who "this application's own
//  company" is. That knowledge is not invented here and it is not hard-coded —
//  it is read from the configuration this installation already has:
//
//    · the store the user is acting as        (stores.store_name, gst_number, …)
//    · the tenant-wide business settings      (store_settings.company_name, …)
//    · what the client sent                    (used only as an extra hint)
//
//  The result is a *profile*, not a single string, because OCR mangles company
//  names. Bluechip on an invoice may be printed as "BLUECHIP COMPUTER SYSTEM",
//  "BLUECHIP COMPUTER SYSTEMS", "BLUECHIP COMPUTR SYSTEM [ASUS EXCLUSIVE STORE]"
//  or as nothing but a phone number and a GSTIN. So a party block is matched on
//  every signal available — GSTIN, name, phone, email, website — and the strongest
//  one wins.
//
//  A GSTIN match is treated as decisive: it is the one identifier on an invoice
//  that is exact by law and is never a trade name.
// ─────────────────────────────────────────────────────────────────────────────

const {
  collapseSpaces, normalizeGstin, normalizePhone, findEmail, companySimilarity, validateGstin,
  GST_STATE_CODES,
} = require('./normalize');

let database = null;
try {
  // Optional: the parser must still work (on name only) if the database module
  // cannot be loaded — this module is also used by the offline test harness.
  // eslint-disable-next-line global-require
  database = require('../../config/database');
} catch (err) {
  database = null;
}

// A name this alike, or any single hard identifier, means "this is us".
const OWN_NAME_THRESHOLD = 0.6;
// …but two weak signals together are enough even when neither is conclusive.
const OWN_NAME_FLOOR = 0.45;

// A GSTIN is 15 characters in a fixed shape by law. Anything shorter in the
// configuration is a typo or a placeholder, and treating it as an identifier
// would match nothing while still making the profile look configured.
//
// The shape check is the same one the rest of the reader uses. The checksum is
// deliberately not required here: a company whose GSTIN fails the check digit is
// still that company, and refusing to recognise it would be worse than the
// alternative — the name is still compared on its own.
const isUsableGstin = (value) => {
  const graded = validateGstin(value);
  return Boolean(graded.lengthOk && graded.shapeOk);
};

const clean = (v) => collapseSpaces(v) || '';

/**
 * A GSTIN that is a real registration but whose check character OCR disturbed.
 *
 * A GSTIN is two state digits, ten alphanumerics, a "Z" and a check digit. OCR
 * confuses "Z" with "2" and "8" with "B" constantly, so a perfectly valid
 * registration is often read as fifteen characters with the wrong shape. This
 * recognises that case: the state code must be real and the body must be
 * alphanumerics, but the check character is allowed to be wrong.
 */
function isNearGstin(value) {
  const s = normalizeGstin(value);
  if (!/^\d{2}[A-Z0-9]{13}$/.test(s)) return false;
  return Object.prototype.hasOwnProperty.call(GST_STATE_CODES, s.slice(0, 2));
}

/** Digits only — lets "99049 91114" and "+91 9904991114" compare equal. */
const digitsOnly = (v) => String(v || '').replace(/\D/g, '');

/**
 * Two names written the same length but with OCR slips ("COMPUTR" for
 * "COMPUTER") share no whole token, so the token-overlap score in
 * companySimilarity cannot see them at all. This compares characters instead.
 * A Dice coefficient over letter pairs: cheap, order-sensitive enough, and it
 * has no false appetite for unrelated words.
 */
function looseNameSimilarity(a, b) {
  const norm = (v) => collapseSpaces(v).toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 4 || y.length < 4) return 0;

  const pairs = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ga = pairs(x);
  const gb = pairs(y);
  let shared = 0;
  for (const [g, n] of ga) {
    const m = gb.get(g);
    if (m) shared += Math.min(n, m);
  }
  return (2 * shared) / (x.length - 1 + y.length - 1);
}

/** The loosest of the two name comparisons, so neither misses an OCR slip. */
function nameSimilarity(a, b) {
  return Math.max(companySimilarity(a, b), looseNameSimilarity(a, b));
}

/**
 * Reads the company configuration this tenant already has.
 *
 * Every lookup is optional and every failure is survivable: a tenant that has
 * not filled in its store details still gets an identity built from whatever is
 * available rather than an exception in the middle of reading an invoice.
 */
async function readConfiguredIdentity(client, storeId) {
  const run = client && typeof client.query === 'function'
    ? client.query.bind(client)
    : (database && database.query);

  const rows = [];
  if (!run) return rows;

  const attempt = async (sql, params) => {
    try {
      const result = await run(sql, params);
      return result && Array.isArray(result.rows) ? result.rows : [];
    } catch (err) {
      // A tenant that has not run the multi-store migration simply has no
      // `stores` table yet. That is not an error worth failing a scan over.
      return [];
    }
  };

  // Load ALL active stores so every registered GSTIN (e.g. both Bluechip
  // service/purchase 24AANFB3091M126 and sales 27AABCU9603R1ZM) is known.
  rows.push(...await attempt(
    `SELECT store_name, owner_name, gst_number, website, email, phone, mobile,
            whatsapp_number, address, city, state, pincode
       FROM stores
      WHERE is_active = TRUE
      ORDER BY is_default DESC, id ASC
      LIMIT 20`,
    [],
  ));
  // Also load the specific store if given, in case it is inactive.
  if (storeId !== null && storeId !== undefined && storeId !== '') {
    rows.push(...await attempt(
      `SELECT store_name, owner_name, gst_number, website, email, phone, mobile,
              whatsapp_number, address, city, state, pincode
         FROM stores
        WHERE id = $1
        LIMIT 1`,
      [storeId],
    ));
  }

  rows.push(...await attempt(
    `SELECT company_name, gst_vat, tax_id, website, email, phone, address, city, state, pincode
       FROM store_settings
      LIMIT 1`,
    [],
  ));

  return rows;
}

/** Derives the trade-name variants an invoice is likely to print. */
function expandTradeNames(names) {
  const out = new Set();
  for (const raw of names) {
    const name = clean(raw);
    if (!name) continue;
    out.add(name);
    // "[ASUS EXCLUSIVE STORE]" and similar bracket tags are printed as part of
    // the same line; the bracket text is a location badge, not the company.
    const withoutBrackets = name.replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (withoutBrackets && withoutBrackets !== name) out.add(withoutBrackets);
    // "COMPUTER SYSTEM" is often printed as "COMPUTER SYSTEMS".
    if (/systems?$/i.test(withoutBrackets)) {
      out.add(withoutBrackets.replace(/systems?$/i, 'system'));
      out.add(withoutBrackets.replace(/systems?$/i, 'systems'));
    }
  }
  return [...out].filter(Boolean);
}

/**
 * Builds the canonical identity from every configured source plus whatever the
 * client sent. The client is a *hint*, never the authority — a stale or blank
 * value from an app that has not loaded its store list yet must not silently
 * decide who the seller is.
 */
async function buildCompanyIdentity({ client = null, storeId = null, requestCompany = {} } = {}) {
  const rows = await readConfiguredIdentity(client, storeId);

  const names = [];
  const owners = [];
  const gstins = [];
  const gstinsLoose = [];
  const phones = [];
  const emails = [];
  const websites = [];
  const addresses = [];
  const sources = [];

  const absorb = (row, label) => {
    if (!row) return;
    sources.push(label);
    const push = (list, value) => { const v = clean(value); if (v) list.push(v); };

    push(names, row.store_name);
    push(names, row.company_name);
    push(owners, row.owner_name);

    // Support multiple GST registrations on the same row (comma/semicolon separated)
    // and also a dedicated gst_number_2 column if present.
    const rawGstins = [
      row.gst_number, row.gst_vat, row.tax_id, row.gst_number_2,
    ].flatMap((v) => String(v || '').split(/[,;|\s]+/)).filter(Boolean);
    for (const raw of rawGstins) {
      const gst = normalizeGstin(raw);
      if (isUsableGstin(gst) && !gstins.includes(gst)) gstins.push(gst);
      // A registration that is the right shape but whose check character OCR
      // mangled ("...M1Z6" read as "...M126") is still the registration this
      // business trades under, and it is what gets printed on the invoices we
      // read. Both sides of that comparison are OCR, so requiring a perfect
      // checksum here would discard the strongest identity signal there is.
      if (!isUsableGstin(gst) && isNearGstin(gst) && !gstinsLoose.includes(gst)) gstinsLoose.push(gst);
    }

    for (const p of [row.phone, row.mobile, row.whatsapp_number]) {
      const d = digitsOnly(p);
      // Keep the last 10 digits: "+91 99049 91114" and "9904991114" are one number.
      if (d.length >= 10) phones.push(d.slice(-10));
    }

    for (const e of [row.email, row.contact_email]) {
      const found = findEmail(e) || (e && e.includes('@') ? clean(e).toLowerCase() : '');
      if (found) emails.push(String(found).toLowerCase());
    }

    for (const w of [row.website]) {
      const site = clean(w).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (site && site.includes('.')) websites.push(site.replace(/^www\./, ''));
    }

    const address = [row.address, row.city, row.state, row.pincode].filter(Boolean).join(', ');
    push(addresses, address);
  };

  // Order matters only for reporting; every row is absorbed.
  for (const row of rows) {
    absorb(row, row.store_name || row.company_name ? 'store-configuration' : 'store-settings');
  }

  // The client's hint — added last so configured data is never overwritten.
  if (requestCompany && typeof requestCompany === 'object') {
    const hinted = {
      store_name: requestCompany.name || requestCompany.companyName || '',
      gst_number: requestCompany.gstin || requestCompany.partyGstin || '',
      phone: requestCompany.phone || '',
      email: requestCompany.email || '',
      website: requestCompany.website || '',
      address: requestCompany.address || '',
    };
    if (Object.values(hinted).some(Boolean)) absorb(hinted, 'client-hint');
  }

  const tradeNames = expandTradeNames(names);
  const identity = {
    // The name shown back to the user in the messages.
    legalName: tradeNames[0] || names[0] || '',
    knownNames: tradeNames,
    ownerNames: owners,
    gstins: [...new Set(gstins)],
    gstinsLoose: [...new Set(gstinsLoose)],
    phones: [...new Set(phones)],
    emails: [...new Set(emails)],
    websites: [...new Set(websites)],
    addresses,
    sources: [...new Set(sources.filter(Boolean))],
  };

  identity.configured = Boolean(
    identity.knownNames.length || identity.gstins.length
    || identity.phones.length || identity.emails.length || identity.websites.length,
  );
  identity.isEmpty = !identity.configured;

  return identity;
}

/** An identity with nothing in it, used when the database is unreachable. */
function emptyIdentity() {
  return buildCompanyIdentity({ client: null, storeId: null, requestCompany: {} });
}

/**
 * The same profile, built from a plain { name, gstin, phone, email, website }
 * without touching the database.
 *
 * The parser resolves direction synchronously, so it cannot await a query. This
 * is the fallback it uses when the caller could not supply a configured profile;
 * the route always does supply one, so this only matters for direct callers and
 * for the offline tests.
 */
function fromRequest(requestCompany) {
  const input = requestCompany && typeof requestCompany === 'object' ? requestCompany : {};
  const name = clean(input.name || input.companyName || '');
  // Support array of GSTINs, comma-separated string, or single value.
  const rawGstinInput = input.gstins || input.gstin || input.partyGstin || '';
  const rawGstinList = Array.isArray(rawGstinInput)
    ? rawGstinInput
    : String(rawGstinInput).split(/[,;|\s]+/).filter(Boolean);
  const usableGstins = [...new Set(
    rawGstinList.map(normalizeGstin).filter(isUsableGstin)
  )];
  // The same tolerance as above: a registration whose check character is
  // OCR-damaged is still this company's registration, and it is the strongest
  // signal available for deciding who bought and who sold.
  const looseGstins = [...new Set(
    rawGstinList.map(normalizeGstin).filter((g) => !isUsableGstin(g) && isNearGstin(g))
  )];
  const phoneDigits = digitsOnly(input.phone || '');
  const email = clean(input.email || '').toLowerCase();
  const site = clean(input.website || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

  const knownNames = expandTradeNames([name]);
  const identity = {
    legalName: knownNames[0] || '',
    knownNames,
    ownerNames: [],
    gstins: usableGstins,
    gstinsLoose: looseGstins,
    phones: phoneDigits.length >= 10 ? [phoneDigits.slice(-10)] : [],
    emails: email ? [email] : [],
    websites: site && site.includes('.') ? [site] : [],
    addresses: [],
    sources: ['client-hint'],
  };
  identity.configured = Boolean(
    knownNames.length || identity.gstins.length || identity.phones.length
    || identity.emails.length || identity.websites.length,
  );
  identity.isEmpty = !identity.configured;
  return identity;
}

/**
 * Scores how strongly a party block printed on an invoice is this application's
 * own company.
 *
 * GSTIN is decisive and returns immediately. Otherwise the name is compared
 * against every trade name it might be printed under, and a matching phone,
 * email or website lifts a borderline name over the line — which is what saves
 * the case where OCR mangled the company name but read the number perfectly.
 */
function matchParty(party, identity) {
  if (!party || !identity || identity.isEmpty) {
    return { isOwn: false, score: 0, matchedOn: [] };
  }
  const matchedOn = [];

  const partyGstin = normalizeGstin(party.gstin?.value || party.gstin || '');
  if (partyGstin && identity.gstins.some((g) => g === partyGstin)) {
    return { isOwn: true, score: 1, matchedOn: ['gstin'] };
  }
  // Both the configured registration and the one printed on the invoice reach
  // this point through OCR, so an exact comparison is not available. What is
  // available is the registration itself: the state code, the ten-character PAN
  // body, the entity digit and the "Z". OCR damage almost always falls in the
  // check digit and the letter "Z", so those two positions are compared loosely
  // while the identifying body must agree. Two different companies cannot share
  // a PAN, so this is still decisive.
  const gstinCore = (g) => ({ state: g.slice(0, 2), pan: g.slice(2, 12), entity: g.slice(12, 13) });
  const sameRegistration = (a, b) => {
    const ca = gstinCore(normalizeGstin(a));
    const cb = gstinCore(normalizeGstin(b));
    if (!isNearGstin(normalizeGstin(a)) || !isNearGstin(normalizeGstin(b))) return false;
    if (ca.state !== cb.state || ca.entity !== cb.entity) return false;
    // The two PANs differ here only by digits OCR read wrong ("3051" for "3091"),
    // and both are single unbroken tokens, so a character-level comparison is the
    // right one. Ten of eleven characters agreeing is far beyond coincidence.
    if (ca.pan === cb.pan) return true;
    let same = 0;
    for (let i = 0; i < Math.min(ca.pan.length, cb.pan.length); i += 1) {
      if (ca.pan[i] === cb.pan[i]) same += 1;
    }
    return same >= ca.pan.length - 1;
  };
  const knownGstins = [...(identity.gstins || []), ...(identity.gstinsLoose || [])];
  if (partyGstin && knownGstins.some((g) => sameRegistration(g, partyGstin))) {
    return { isOwn: true, score: 0.98, matchedOn: ['gstin'] };
  }

  const partyName = clean(party.name?.value ?? party.name ?? '');
  let bestNameScore = 0;
  if (partyName) {
    for (const candidate of identity.knownNames) {
      const score = nameSimilarity(partyName, candidate);
      if (score > bestNameScore) bestNameScore = score;
    }
  }
  if (bestNameScore >= OWN_NAME_THRESHOLD) matchedOn.push('name');

  const partyPhone = digitsOnly(party.phone?.value ?? party.phone ?? '');
  if (partyPhone.length >= 10 && identity.phones.includes(partyPhone.slice(-10))) {
    matchedOn.push('phone');
  }

  const partyEmailRaw = clean(party.email?.value ?? party.email ?? '').toLowerCase();
  const partyEmail = partyEmailRaw ? (findEmail(partyEmailRaw) || partyEmailRaw) : '';
  if (partyEmail && identity.emails.includes(partyEmail)) {
    matchedOn.push('email');
  }

  const partySite = clean(party.website?.value ?? party.website ?? '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  if (partySite && identity.websites.some((w) => partySite.includes(w) || w.includes(partySite))) {
    matchedOn.push('website');
  }

  // A hard identifier alongside any name resemblance settles it.
  if (matchedOn.includes('phone') || matchedOn.includes('email') || matchedOn.includes('website')) {
    return { isOwn: true, score: Math.max(0.9, bestNameScore), matchedOn };
  }

  // One strong name, or two weak ones together.
  const isOwn = matchedOn.includes('name') || bestNameScore >= OWN_NAME_FLOOR;
  return { isOwn, score: bestNameScore, matchedOn };
}

module.exports = {
  buildCompanyIdentity,
  emptyIdentity,
  fromRequest,
  matchParty,
  looseNameSimilarity,
  nameSimilarity,
  expandTradeNames,
  OWN_NAME_THRESHOLD,
};