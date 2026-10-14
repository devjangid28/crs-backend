/**
 * Regression tests for Phase 2.1 findings.
 *
 * Finding 1: retry backoff was hardcoded to backoffMs(3) -> a flat 60s for
 *            every retry. Now follows the intended bounded exponential
 *            schedule, driven by the real attempt count.
 * Finding 2: PM2 kill_timeout / batch size must allow a full sequential batch
 *            to finish within the grace period.
 *
 * Read-only with respect to production; runs against the isolated test DB.
 * whatsappService is never required, so no code path to Meta is reachable.
 *
 *   $env:INVOICE_PORTAL_TEST_DB='bluechipcs_invoiceportal_test'
 *   node src/tests/outboxBackoff.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const EXPECTED = 'bluechipcs_invoiceportal_test';
const TEST_DB = process.env.INVOICE_PORTAL_TEST_DB;
if (!TEST_DB) { console.error('REFUSING: set INVOICE_PORTAL_TEST_DB'); process.exit(2); }
if (TEST_DB !== EXPECTED) { console.error(`REFUSING: DB is "${TEST_DB}"`); process.exit(2); }

const envPath = path.join(__dirname, '..', '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}
process.env.DB_NAME = TEST_DB;
process.env.WHATSAPP_ENABLED = 'false';

const { query, pool } = require('../config/database');
const outbox = require('../services/whatsappOutboxService');
const worker = require('../services/whatsappOutboxWorker');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
const K = (n) => `testbo:${n}:${Math.random().toString(36).slice(2, 10)}`;
async function clean() { await query(`DELETE FROM whatsapp_outbox WHERE event_key LIKE 'testbo:%'`); }

const keyOf = async (prefix) => (await query(
  `SELECT event_key FROM whatsapp_outbox WHERE event_key LIKE $1`, [`testbo:${prefix}%`]
)).rows[0].event_key;

const TOLERANCE_MS = 5000; // clock/transport slack
const delayOf = async (prefix) => {
  const r = await outbox.getByEventKey(await keyOf(prefix));
  return Math.round((new Date(r.run_after).getTime() - Date.now()) / 1000) * 1000;
};

/**
 * Fast-forward the scheduler so the row becomes due again.
 * The DELAY VALUE IS ALREADY CAPTURED by delayOf() before we do this - we are
 * simulating the passage of time, not rewriting the backoff we are asserting.
 */
async function makeDue(prefix) {
  await query(
    "UPDATE whatsapp_outbox SET run_after = NOW() - INTERVAL '1 second' WHERE event_key LIKE $1",
    [`testbo:${prefix}%`]
  );
}

(async () => {
  const has = await query("SELECT to_regclass('public.whatsapp_outbox')::text t");
  if (!has.rows[0].t) { console.error('whatsapp_outbox missing'); process.exit(2); }

  console.log(`\nPhase 2.1 regression tests  [db=${TEST_DB}]\n`);
  await clean();

  // ---------------------------------------------- Finding 1: unit --------
  await t('backoffMs schedule is 15s,30s,60s,120s,240s then capped at 300s', () => {
    assert.strictEqual(outbox.backoffMs(1), 15000);
    assert.strictEqual(outbox.backoffMs(2), 30000);
    assert.strictEqual(outbox.backoffMs(3), 60000);
    assert.strictEqual(outbox.backoffMs(4), 120000);
    assert.strictEqual(outbox.backoffMs(5), 240000);
    assert.strictEqual(outbox.backoffMs(6), 300000, 'cap applies from attempt 6');
    assert.strictEqual(outbox.backoffMs(20), 300000, 'never exceeds cap');
  });

  await t('backoffMs is defensive about bad input', () => {
    for (const bad of [0, -1, undefined, null, NaN, 'x', Infinity]) {
      const v = outbox.backoffMs(bad);
      assert.ok(Number.isFinite(v) && v >= 15000 && v <= 300000, `bad input ${bad} -> ${v}`);
    }
  });

  // ------------------------------------ Finding 1: end-to-end delays ----
  await t('1st failure schedules ~15s (was a flat 60s before the fix)', async () => {
    await clean();
    await outbox.enqueue({ eventKey: K('f1'), messageType: 'order_created', recipient: '9990001111' });
    const c = await worker.runOnce(async () => { const e = new Error('upstream 500'); e.status = 503; throw e; },
      { workerId: 'bo-1', batchSize: 5 });
    assert.strictEqual(c.retried, 1, JSON.stringify(c));
    const d = await delayOf('f1');
    assert.ok(Math.abs(d - 15000) < TOLERANCE_MS, `expected ~15000ms, got ${d}ms`);
  });

  await t('2nd failure schedules ~30s', async () => {
    const k = await keyOf('f1');
    await makeDue('f1');
    const c = await worker.runOnce(async () => { const e = new Error('upstream 500'); e.status = 503; throw e; },
      { workerId: 'bo-2', batchSize: 5 });
    assert.strictEqual(c.retried, 1, JSON.stringify(c));
    const d = await delayOf('f1');
    assert.ok(Math.abs(d - 30000) < TOLERANCE_MS, `expected ~30000ms, got ${d}ms`);
    assert.strictEqual((await outbox.getByEventKey(k)).attempts, 2, 'attempt counter must advance');
  });

  await t('3rd failure schedules ~60s', async () => {
    await makeDue('f1');
    await worker.runOnce(async () => { const e = new Error('upstream 500'); e.status = 503; throw e; },
      { workerId: 'bo-3', batchSize: 5 });
    const d = await delayOf('f1');
    assert.ok(Math.abs(d - 60000) < TOLERANCE_MS, `expected ~60000ms, got ${d}ms`);
  });

  await t('4th failure schedules ~120s', async () => {
    await makeDue('f1');
    await worker.runOnce(async () => { const e = new Error('upstream 500'); e.status = 503; throw e; },
      { workerId: 'bo-4', batchSize: 5 });
    const d = await delayOf('f1');
    assert.ok(Math.abs(d - 120000) < TOLERANCE_MS, `expected ~120000ms, got ${d}ms`);
  });

  await t('delays INCREASE monotonically across consecutive attempts', async () => {
    // Own row so this test cannot exhaust the row other tests are still using.
    await outbox.enqueue({ eventKey: K('mono'), messageType: 'order_created', recipient: '9990004444', maxAttempts: 9 });
    const seq = [];
    for (const w of ['m1', 'm2', 'm3', 'm4']) {
      await makeDue('mono');
      const c = await worker.runOnce(async () => { const e = new Error('boom'); e.status = 500; throw e; },
        { workerId: `bo-m-${w}`, batchSize: 5 });
      assert.strictEqual(c.retried, 1, JSON.stringify(c));
      seq.push(await delayOf('mono'));
    }
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] > seq[i - 1], `not increasing: ${seq.join(' -> ')}`);
    }
  });

  await t('retries stop at max_attempts -> terminal, no further reschedule', async () => {
    await clean();
    await outbox.enqueue({ eventKey: K('exh'), messageType: 'order_created', recipient: '9990005555', maxAttempts: 3 });
    for (let i = 0; i < 2; i++) {
      await makeDue('exh');
      const c = await worker.runOnce(async () => { const e = new Error('boom'); e.status = 500; throw e; },
        { workerId: `bo-ex-${i}`, batchSize: 5 });
      assert.strictEqual(c.retried, 1, `attempt ${i + 1} should retry`);
    }
    await makeDue('exh');
    const c = await worker.runOnce(async () => { const e = new Error('boom'); e.status = 500; throw e; },
      { workerId: 'bo-ex-final', batchSize: 5 });
    assert.strictEqual(c.failed, 1, JSON.stringify(c));
    assert.strictEqual(c.retried, 0, 'must not retry past max_attempts');
    const row = await outbox.getByEventKey(await keyOf('exh'));
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.attempts, 3, 'exactly max_attempts attempts were made');
    const after = await worker.runOnce(async () => { throw new Error('must not run'); },
      { workerId: 'bo-ex-after', batchSize: 5 });
    assert.strictEqual(after.claimed, 0, 'a failed row must never be claimed again');
  });

  await t('cap enforced: a high max_attempts row still waits <= 300s', async () => {
    await clean();
    await outbox.enqueue({
      eventKey: K('cap'), messageType: 'order_created', recipient: '9990001111', maxAttempts: 12,
    });
    // Push the attempt counter up without waiting for real backoffs.
    await query("UPDATE whatsapp_outbox SET attempts=8 WHERE event_key LIKE 'testbo:cap%'");
    const c = await worker.runOnce(async () => { const e = new Error('boom'); e.status = 500; throw e; },
      { workerId: 'bo-cap', batchSize: 5 });
    assert.strictEqual(c.retried, 1, JSON.stringify(c));
    const d = await delayOf('cap');
    assert.ok(d <= 300000 + TOLERANCE_MS, `delay ${d}ms exceeded the 300s cap`);
    assert.ok(d >= 240000 - TOLERANCE_MS, `expected >=240s for attempt 9, got ${d}ms`);
  });

  // ------------------------- unchanged behaviours must stay unchanged ----
  await t('AMBIGUOUS outcomes are still never retried', async () => {
    await clean();
    await outbox.enqueue({ eventKey: K('amb'), messageType: 'portal_link', recipient: '9990001111' });
    const c = await worker.runOnce(async () => { const e = new Error('socket timeout'); e.code = 'ETIMEDOUT'; throw e; },
      { workerId: 'bo-amb', batchSize: 5 });
    assert.strictEqual(c.ambiguous, 1, JSON.stringify(c));
    assert.strictEqual(c.retried, 0, 'ambiguous must not be rescheduled');
    const again = await worker.runOnce(async () => { throw new Error('must not run'); },
      { workerId: 'bo-amb2', batchSize: 5 });
    assert.strictEqual(again.claimed, 0, 'ambiguous row must never be claimable again');
  });

  await t('idempotency unchanged: duplicate event_key still yields one row', async () => {
    await clean();
    const k = K('idem');
    await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    const n = await query('SELECT count(*)::int n FROM whatsapp_outbox WHERE event_key=$1', [k]);
    assert.strictEqual(n.rows[0].n, 1);
  });

  // ------------------------------------------ Finding 2: PM2 sizing -----
  await t('PM2 kill_timeout covers a full sequential batch', () => {
    const cfg = require(path.join(__dirname, '..', '..', '..', 'ecosystem.outbox.cjs'));
    const app = cfg.apps[0];
    const batch = Number(app.env.OUTBOX_BATCH_SIZE);
    const kill = app.kill_timeout;
    const poll = Number(app.env.OUTBOX_POLL_MS);

    // Worst case per row: template call + 2-call fallback chain, 30s each.
    const PER_ROW_MS = 90_000;
    const drain = batch * PER_ROW_MS + poll;

    assert.ok(kill > drain, `kill_timeout ${kill}ms does not cover worst-case drain ${drain}ms`);
    assert.ok(kill >= drain * 2, `kill_timeout ${kill}ms leaves <2x headroom over ${drain}ms`);
    console.log(`        batch=${batch} drain_worst=${drain}ms kill_timeout=${kill}ms margin=${(kill / drain).toFixed(1)}x`);
  });

  await t('claim timeout exceeds the worst-case per-row send time', () => {
    const cfg = require(path.join(__dirname, '..', '..', '..', 'ecosystem.outbox.cjs'));
    const claim = Number(cfg.apps[0].env.OUTBOX_CLAIM_TIMEOUT_MS);
    assert.ok(claim > 90_000, `claim timeout ${claim}ms must exceed the 90s worst-case row`);
  });

  await t('main PM2 config still untouched (3 apps, disjoint)', () => {
    const main = require(path.join(__dirname, '..', '..', '..', 'ecosystem.config.cjs'));
    const out = require(path.join(__dirname, '..', '..', '..', 'ecosystem.outbox.cjs'));
    assert.deepStrictEqual(main.apps.map((a) => a.name).sort(),
      ['crs-backend', 'crs-frontend', 'crs-tunnel']);
    assert.strictEqual(out.apps.filter((a) => main.apps.some((m) => m.name === a.name)).length, 0);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await clean();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('HARNESS ERROR:', e.message); await pool.end().catch(() => {}); process.exit(1); });