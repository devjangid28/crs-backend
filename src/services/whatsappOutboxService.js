/**
 * Durable WhatsApp outbox.
 *
 * Replaces fire-and-forget `setImmediate` sends with rows that survive a process
 * restart, can be retried with backoff, and cannot be enqueued twice for the
 * same business event.
 *
 * DELIVERY SEMANTICS - read this before trusting it
 * --------------------------------------------------
 * This queue gives AT-LEAST-ONCE delivery with an explicit AMBIGUOUS state.
 * It is NOT exactly-once and cannot be made so over the network:
 *
 *   * If WhatsApp accepts a message and the connection then times out, we get
 *     no message id. Retrying blindly risks double-messaging a real customer.
 *     Those outcomes are recorded as 'ambiguous' and are NOT auto-retried.
 *   * What IS guaranteed: the same business event can never be enqueued twice
 *     (unique event_key), so a repeated request, a retried request, or a
 *     duplicated worker cannot create a second send.
 *
 * What you can rely on:
 *   - enqueue() is idempotent per event_key
 *   - at most one worker holds a given row at a time
 *   - transient failures are retried with bounded exponential backoff
 *   - ambiguous outcomes are surfaced, never silently doubled
 *
 * No credentials are stored here. `payload` holds template variable values only.
 */

const crypto = require('crypto');
const { query } = require('../config/database');

// Statuses treated as "someone already owns this" and must never be re-sent.
const TERMINAL = new Set(['sent', 'cancelled']);

// Outcomes that mean "we do not know if the customer received it".
const AMBIGUOUS_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
]);

const MAX_ERROR_LEN = 480;

const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 300_000;

/**
 * Bounded exponential backoff for the Nth failed attempt.
 *   attempt 1 -> 15s, 2 -> 30s, 3 -> 60s, 4 -> 120s, 5 -> 240s, 6+ -> 240s
 * Hard cap of 5 minutes so a stuck row can never be scheduled hours out.
 *
 * `attempts` is the number of the attempt that JUST failed (1-based). The worker
 * reads row.attempts after claiming, and claiming already incremented it, so
 * passing row.attempts straight through gives attempt 1 on the first failure -
 * no off-by-one adjustment needed.
 */
function backoffMs(attempts) {
  const n = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, n - 1), BACKOFF_MAX_MS);
}

/** Never log a raw provider error that could echo a token or a phone number. */
function summarise(err) {
  const code = (err && (err.code || err.errno)) || null;
  let msg = (err && err.message) || 'unknown error';
  msg = String(msg)
    .replace(/EAA[A-Za-z0-9]{20,}/g, '[redacted-token]')      // Meta token shape
    .replace(/\b\d{10,15}\b/g, '[redacted-phone]')            // long digit runs
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[redacted-phone]')
    .slice(0, MAX_ERROR_LEN);
  return { code: code ? String(code).slice(0, 30) : null, msg };
}

function normalisePhone(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/\D/g, '');
  if (!d) return null;
  // India default: 10-digit local -> 91XXXXXXXXXX
  if (d.length === 10) d = `91${d}`;
  if (d.length === 11 && d.startsWith('0')) d = `91${d.slice(1)}`;
  if (!/^\d{10,15}$/.test(d)) return null;
  return d;
}

// ------------------------------------------------------------------ enqueue

/**
 * Idempotent enqueue.
 * Returns { enqueued:boolean, id, duplicate:boolean }.
 * A repeated call with the same event_key never creates a second row and never
 * overwrites an in-flight one - it reports duplicate:true instead.
 */
async function enqueue({
  eventKey,
  messageType,
  templateName = null,
  recipient,
  payload = [],
  sourceType = null,
  sourceId = null,
  storeId = null,
  runAfter = null,
  maxAttempts = 5,
}) {
  if (!eventKey) throw new Error('enqueue: eventKey is required');
  if (!messageType) throw new Error('enqueue: messageType is required');

  const phone = normalisePhone(recipient);
  if (!phone) {
    // Deliberately NOT persisted: an invalid recipient is a caller bug and we
    // do not want thousands of undeliverable rows.
    return { enqueued: false, duplicate: false, reason: 'invalid_recipient' };
  }

  const when = runAfter ? new Date(runAfter) : new Date();
  const runsAt = Number.isNaN(when.getTime()) ? new Date() : when;

  const res = await query(
    `INSERT INTO whatsapp_outbox
       (event_key, message_type, template_name, recipient_phone, payload,
        source_type, source_id, store_id, run_after, status, max_attempts)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'pending',$10)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id, status, run_after`,
    [String(eventKey).slice(0, 180), String(messageType).slice(0, 60),
     templateName ? String(templateName).slice(0, 120) : null,
     phone, JSON.stringify(Array.isArray(payload) ? payload : [payload]),
     sourceType, Number.isFinite(sourceId) ? sourceId : null,
     Number.isFinite(storeId) ? storeId : null, runsAt, maxAttempts]
  );

  if (res.rows.length > 0) {
    return { enqueued: true, duplicate: false, id: res.rows[0].id };
  }

  // Conflict path: the event already exists. Report it without mutating it.
  const existing = await query(
    'SELECT id, status, run_after FROM whatsapp_outbox WHERE event_key = $1', [String(eventKey)]
  );
  return {
    enqueued: false,
    duplicate: true,
    id: existing.rows[0] ? existing.rows[0].id : null,
    status: existing.rows[0] ? existing.rows[0].status : null,
  };
}

// -------------------------------------------------------------------- claim

/**
 * Atomically claim up to `limit` due rows for this worker.
 *
 * Uses a conditional UPDATE so two workers racing on the same row cannot both
 * win: the UPDATE only matches when status is still 'pending'.
 *
 * Stale claims (worker died) are reclaimed once older than claimTimeoutMs.
 */
async function claimDue({
  workerId = `w-${crypto.randomBytes(4).toString('hex')}`,
  limit = 10,
  claimTimeoutMs = 120_000,
} = {}) {
  await query(
    `UPDATE whatsapp_outbox
        SET status = 'pending', claimed_by = NULL, claimed_at = NULL
      WHERE status = 'claimed'
        AND claimed_at IS NOT NULL
        AND claimed_at < NOW() - ($1 || ' milliseconds')::interval`,
    [String(claimTimeoutMs)]
  );

  const res = await query(
    `UPDATE whatsapp_outbox o
        SET status = 'claimed',
            claimed_by = $1,
            claimed_at = NOW(),
            attempts = o.attempts + 1
       FROM (
         SELECT id FROM whatsapp_outbox
          WHERE status = 'pending'
            AND run_after <= NOW()
          ORDER BY run_after ASC, id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       ) due
      WHERE o.id = due.id
      RETURNING o.id, o.event_key, o.message_type, o.template_name,
                o.recipient_phone, o.payload, o.source_type, o.source_id,
                o.store_id, o.attempts, o.max_attempts,
                o.claimed_by, o.status, o.run_after`,
    [workerId, limit]
  );
  return { workerId, rows: res.rows };
}

// ----------------------------------------------------------------- outcomes

/** Delivery confirmed by WhatsApp. Terminal. */
async function markSent(id, providerMessageId) {
  await query(
    `UPDATE whatsapp_outbox
        SET status = 'sent', provider_message_id = $2,
            started_at = COALESCE(started_at, NOW()),
            last_error = NULL, error_code = NULL,
            claimed_by = NULL, claimed_at = NULL
      WHERE id = $1`,
    [id, providerMessageId ? String(providerMessageId).slice(0, 120) : null]
  );
}

/**
 * Transient failure -> retry with bounded exponential backoff.
 * Once attempts are exhausted the row becomes 'failed' (terminal).
 *
 * `attempts` is the number of the attempt that just failed, so the first
 * failure waits backoffMs(1) = 15s, the second 30s, and so on. It is NOT
 * hardcoded: an earlier version passed a literal 3, which collapsed every
 * retry to a flat 60 seconds regardless of progress.
 *
 * Scoped to `workerId` so a slow worker cannot overwrite the outcome recorded
 * by whichever worker actually owns the row now.
 */
async function markRetry(id, err, { exhausted = false, workerId = null, attempts = 1 } = {}) {
  const { code, msg } = summarise(err);
  const delay = backoffMs(attempts);
  await query(
    `UPDATE whatsapp_outbox
        SET status = $2,
            run_after = NOW() + ($3 || ' milliseconds')::interval,
            last_error = $4, error_code = $5,
            claimed_by = NULL, claimed_at = NULL
      WHERE id = $1 AND ($6::text IS NULL OR claimed_by = $6)`,
    [id, exhausted ? 'failed' : 'pending', String(delay), msg, code, workerId]
  );
  return delay;
}

/**
 * Ambiguous outcome - the provider may or may not have delivered.
 * Parked, NOT retried, so we never double-message a customer.
 * Requires reconciliation via wamid or the conversation thread.
 */
async function markAmbiguous(id, err) {
  const { code, msg } = summarise(err);
  await query(
    `UPDATE whatsapp_outbox
        SET status = 'ambiguous', last_error = $2, error_code = $3,
            claimed_by = NULL, claimed_at = NULL
      WHERE id = $1`,
    [id, msg, code]
  );
}

/** Deterministic non-retryable failure (bad number, rejected template, ...). */
async function markFailed(id, err) {
  const { code, msg } = summarise(err);
  await query(
    `UPDATE whatsapp_outbox
        SET status = 'failed', last_error = $2, error_code = $3,
            claimed_by = NULL, claimed_at = NULL
      WHERE id = $1`,
    [id, msg, code]
  );
}

function classifyError(err) {
  const code = (err && (err.code || err.errno)) || '';
  const status = err && err.status;
  const text = String((err && err.message) || '').toLowerCase();

  // 4xx from Meta is deterministic - retrying will not help.
  if (typeof status === 'number' && status >= 400 && status < 500) {
    if (status === 401 || status === 403) return { kind: 'failed', why: 'auth rejected' };
    if (status === 429) return { kind: 'retry', why: 'rate limited' };
    return { kind: 'failed', why: `provider ${status}` };
  }
  // Timeout / reset after the request may have been accepted -> ambiguous.
  if (AMBIGUOUS_CODES.has(code) || text.includes('timeout') || text.includes('aborted')) {
    return { kind: 'ambiguous', why: 'timeout after possible accept' };
  }
  if (typeof status === 'number' && status >= 500) return { kind: 'retry', why: 'provider 5xx' };
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return { kind: 'retry', why: 'network' };
  return { kind: 'retry', why: 'unknown' };
}

// ------------------------------------------------------------------- status

async function stats() {
  const r = await query(
    `SELECT status, count(*)::int AS n,
            min(run_after) AS oldest_due
       FROM whatsapp_outbox GROUP BY status ORDER BY status`
  );
  return r.rows;
}

async function getByEventKey(eventKey) {
  const r = await query(
    `SELECT id, event_key, message_type, template_name, recipient_phone,
            payload, source_type, source_id, store_id, run_after, status,
            attempts, max_attempts, provider_message_id, last_error, error_code,
            created_at, updated_at
       FROM whatsapp_outbox WHERE event_key = $1`,
    [String(eventKey)]
  );
  return r.rows[0] || null;
}

module.exports = {
  enqueue,
  claimDue,
  markSent,
  markRetry,
  markAmbiguous,
  markFailed,
  classifyError,
  normalisePhone,
  backoffMs,
  summarise,
  stats,
  getByEventKey,
  TERMINAL,
};