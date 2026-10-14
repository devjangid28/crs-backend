/**
 * Outbox worker.
 *
 * Claims due rows and hands each to a sender. Safe to run in-process alongside
 * the API or as a standalone process - two workers can never take the same row,
 * because claiming is a conditional UPDATE guarded by status.
 *
 * DELIVERY SEMANTICS
 * ------------------
 * At-least-once, with ambiguous outcomes parked rather than blindly retried.
 * See whatsappOutboxService for the full explanation. In short: a timeout after
 * WhatsApp may have accepted the message is recorded as 'ambiguous' and is NOT
 * auto-retried, because retrying can double-message a real customer.
 *
 * The sender is injected so this file never imports WhatsApp directly and so
 * tests can drive every branch without touching the network.
 */

const crypto = require('crypto');
const outbox = require('./whatsappOutboxService');

const DEFAULT_POLL_MS = 5000;

function defaultOptions(opts = {}) {
  return {
    workerId: opts.workerId || `worker-${crypto.randomBytes(4).toString('hex')}`,
    pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
    batchSize: opts.batchSize ?? 10,
    claimTimeoutMs: opts.claimTimeoutMs ?? 120_000,
    // Hard stop for a long-running loop.
    maxIterations: opts.maxIterations ?? Infinity,
  };
}

/**
 * Process one batch of due rows.
 *
 * @param {function} sender  async ({ row, workerId }) => void
 *                          Should throw on failure. To report ambiguity
 *                          explicitly, attach `err.ambiguous = true`.
 * @returns {object} counters for this batch
 */
async function runOnce(sender, opts = {}) {
  const o = defaultOptions(opts);
  const counters = { claimed: 0, sent: 0, retried: 0, ambiguous: 0, failed: 0, skipped: 0 };

  const { rows } = await outbox.claimDue({
    workerId: o.workerId,
    limit: o.batchSize,
    claimTimeoutMs: o.claimTimeoutMs,
  });
  counters.claimed = rows.length;

  for (const row of rows) {
    // Re-evaluate the retry budget at send time, not at claim time.
    if (row.attempts > row.max_attempts) {
      await outbox.markFailed(row.id, Object.assign(new Error('attempts exhausted'), {}));
      counters.failed += 1;
      continue;
    }

    try {
      const outcome = await sender({ row, workerId: o.workerId });
      const messageId = outcome && typeof outcome === 'object'
        ? outcome.messageId
        : outcome;
      await outbox.markSent(row.id, messageId || null);
      counters.sent += 1;
    } catch (err) {
      // An explicit outcome class from the sender wins over heuristic
      // classification - it knows things about the provider response that
      // generic error-code matching cannot see.
      const kind = err && err.dispatchKind
        ? { kind: err.dispatchKind, why: 'sender verdict' }
        : outbox.classifyError(err);

      if (kind.kind === 'ambiguous' || err.ambiguous === true) {
        // We do not know if the customer received it. Park it for a human.
        await outbox.markAmbiguous(row.id, err);
        counters.ambiguous += 1;
        continue;
      }

      if (kind.kind === 'failed') {
        await outbox.markFailed(row.id, err);
        counters.failed += 1;
        continue;
      }

      const exhausted = row.attempts >= row.max_attempts;
      if (exhausted) {
        // Last transient failure - record it, but do NOT claim we know whether
        // the customer saw anything earlier in this row's history.
        await outbox.markFailed(row.id, err);
        counters.failed += 1;
      } else {
        // row.attempts was already incremented by claimDue, so it is the
        // number of the attempt that just failed: 1 -> 15s, 2 -> 30s, ...
        await outbox.markRetry(row.id, err, {
          exhausted: false,
          workerId: o.workerId,
          attempts: row.attempts,
        });
        counters.retried += 1;
      }
    }
  }

  return counters;
}

/**
 * Long-running loop. Resolves when maxIterations is reached (used by tests).
 */
async function start(sender, opts = {}) {
  const o = defaultOptions(opts);
  let iterations = 0;
  let running = true;

  const stop = () => { running = false; };

  while (running && iterations < o.maxIterations) {
    iterations += 1;
    try {
      await runOnce(sender, { ...o, maxIterations: 1 });
    } catch (err) {
      // The loop itself must never die.
      console.error(`[outbox ${o.workerId}] cycle error:`, outbox.summarise(err).msg);
    }
    if (o.maxIterations !== Infinity && iterations >= o.maxIterations) break;
    await new Promise((r) => setTimeout(r, o.pollMs));
  }

  return { stop, iterations };
}

module.exports = { runOnce, start, DEFAULT_POLL_MS };