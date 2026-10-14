/**
 * WhatsApp outbox tests.
 *
 * Runs against an isolated test database only, refuses any other DB name, and
 * NEVER contacts Meta - every send is driven through an injected fake sender.
 *
 *   $env:INVOICE_PORTAL_TEST_DB='bluechipcs_invoiceportal_test'
 *   node src/tests/whatsappOutbox.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const EXPECTED = 'bluechipcs_invoiceportal_test';
const TEST_DB = process.env.INVOICE_PORTAL_TEST_DB;
if (!TEST_DB) { console.error('REFUSING: set INVOICE_PORTAL_TEST_DB'); process.exit(2); }
if (TEST_DB !== EXPECTED) { console.error(`REFUSING: DB is "${TEST_DB}"`); process.exit(2); }

const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
process.env.DB_NAME = TEST_DB;
process.env.WHATSAPP_ENABLED = 'false'; // belt and braces: no send path exists here

const { query, pool } = require('../config/database');
const outbox = require('../services/whatsappOutboxService');
const worker = require('../services/whatsappOutboxWorker');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
const K = (n) => `test:${n}:${crypto4()}`;
function crypto4() { return Math.random().toString(36).slice(2, 10); }
const AMB_KEY = K('amb');

async function clean() { await query(`DELETE FROM whatsapp_outbox WHERE event_key LIKE 'test:%'`); }

(async () => {
  const has = await query("select to_regclass('public.whatsapp_outbox')::text t");
  if (!has.rows[0].t) { console.error('whatsapp_outbox missing - run run_045_whatsapp_outbox.js'); process.exit(2); }

  console.log(`\nWhatsApp outbox tests  [db=${TEST_DB}, no Meta calls]\n`);
  await clean();

  // ------------------------------------------------------- idempotency ----
  await t('enqueue creates a row', async () => {
    const r = await outbox.enqueue({ eventKey: K('a'), messageType: 'order_created', recipient: '9990001111', payload: ['A'] });
    assert.strictEqual(r.enqueued, true);
    assert.ok(r.id > 0);
  });

  await t('duplicate event_key does NOT create a second row', async () => {
    const k = K('dup');
    const a = await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    const b = await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    const c = await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    assert.strictEqual(a.enqueued, true);
    assert.strictEqual(b.enqueued, false); assert.strictEqual(b.duplicate, true);
    assert.strictEqual(c.enqueued, false); assert.strictEqual(c.duplicate, true);
    const rows = await query('SELECT count(*)::int n FROM whatsapp_outbox WHERE event_key=$1', [k]);
    assert.strictEqual(rows.rows[0].n, 1, 'exactly one row must exist');
  });

  await t('re-enqueue does not resurrect or reset a sent row', async () => {
    const k = K('sent');
    const r = await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    await outbox.markSent(r.id, 'wamid.test.1');
    const again = await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    assert.strictEqual(again.enqueued, false);
    const row = await outbox.getByEventKey(k);
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.provider_message_id, 'wamid.test.1');
  });

  // ------------------------------------------------------ recipients -----
  await t('invalid recipients are rejected without persisting', async () => {
    for (const bad of [null, '', 'abc', '123', '++++']) {
      const r = await outbox.enqueue({ eventKey: K('bad'), messageType: 'order_created', recipient: bad });
      assert.strictEqual(r.enqueued, false);
      assert.strictEqual(r.reason, 'invalid_recipient');
    }
    const n = await query(`SELECT count(*)::int n FROM whatsapp_outbox WHERE event_key LIKE 'test:%bad%'`);
    assert.strictEqual(n.rows[0].n, 0, 'nothing persisted for bad recipients');
  });

  await t('10-digit Indian numbers are normalised to +91 form', async () => {
    const k = K('norm');
    const r = await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9876543210' });
    const row = await outbox.getByEventKey(k);
    assert.strictEqual(row.recipient_phone, '919876543210');
    assert.ok(r.enqueued);
  });

  // -------------------------------------------------------- scheduling ----
  await t('future rows are not claimed until due', async () => {
    const k = K('future');
    await outbox.enqueue({ eventKey: k, messageType: 'portal_link', recipient: '9990001111', runAfter: new Date(Date.now() + 3600_000) });
    const { rows } = await outbox.claimDue({ workerId: 'w-test', limit: 50 });
    assert.ok(!rows.find(r => r.event_key === k), 'future row must not be claimed');
  });

  await t('due rows are claimed with attempts incremented', async () => {
    const k = K('due');
    const r = await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    const { rows } = await outbox.claimDue({ workerId: 'w-test', limit: 50 });
    const mine = rows.find(x => x.id === r.id);
    assert.ok(mine, 'row should be claimed');
    assert.strictEqual(mine.attempts, 1);
    assert.strictEqual(mine.status, 'claimed');
  });

  // ------------------------------------------------- concurrency safety ---
  await t('concurrent workers never claim the same row', async () => {
    await clean();
    for (let i = 0; i < 12; i++) await outbox.enqueue({ eventKey: K('c' + i), messageType: 'order_created', recipient: '9990001111' });
    const [a, b] = await Promise.all([
      outbox.claimDue({ workerId: 'w-A', limit: 12 }),
      outbox.claimDue({ workerId: 'w-B', limit: 12 }),
    ]);
    const ids = [...a.rows.map(r => r.id), ...b.rows.map(r => r.id)];
    assert.strictEqual(new Set(ids).size, ids.length, 'row claimed by both workers');
    assert.strictEqual(ids.length, 12, `expected 12 claimed, got ${ids.length}`);
  });

  await t('stale claim is reclaimed after timeout (worker died)', async () => {
    await clean();
    const k = K('stale');
    await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    await outbox.claimDue({ workerId: 'dead-worker', limit: 5, claimTimeoutMs: 1 });
    await new Promise(r => setTimeout(r, 1200));
    const { rows } = await outbox.claimDue({ workerId: 'w-new', limit: 5, claimTimeoutMs: 1000 });
    const mine = rows.find(r => r.event_key === k);
    assert.ok(mine, 'stale row should be reclaimed');
    assert.strictEqual(mine.claimed_by, 'w-new');
  });

  // ------------------------------------------------------------ worker ----
  await t('worker sends a claimed row and records the wamid', async () => {
    await clean();
    const k = K('send');
    await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    const c = await worker.runOnce(async () => 'wamid.abc.123', { workerId: 'w-t1', batchSize: 5 });
    assert.strictEqual(c.sent, 1, JSON.stringify(c));
    const row = await outbox.getByEventKey(k);
    assert.strictEqual(row.status, 'sent');
    assert.strictEqual(row.provider_message_id, 'wamid.abc.123');
  });

  await t('transient provider failure is retried, not lost', async () => {
    await clean();
    const k = K('retry');
    await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    const c = await worker.runOnce(async () => { const e = new Error('upstream 500'); e.status = 503; throw e; }, { workerId: 'w-t2', batchSize: 5 });
    assert.strictEqual(c.retried, 1, JSON.stringify(c));
    const row = await outbox.getByEventKey(k);
    assert.strictEqual(row.status, 'pending');
    assert.ok(new Date(row.run_after) > new Date(), 'run_after pushed into the future');
  });

  await t('deterministic 4xx failure is terminal (no infinite retry)', async () => {
    await clean();
    const k = K('4xx');
    await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    const c = await worker.runOnce(async () => { const e = new Error('bad template'); e.status = 400; throw e; }, { workerId: 'w-t3', batchSize: 5 });
    assert.strictEqual(c.failed, 1, JSON.stringify(c));
    assert.strictEqual((await outbox.getByEventKey(k)).status, 'failed');
  });

  // --------------------------------------------- AMBIGUOUS semantics ----
  await t('timeout after possible accept is AMBIGUOUS and NOT retried', async () => {
    await clean();
    const k = AMB_KEY;
    await outbox.enqueue({ eventKey: k, messageType: 'portal_link', recipient: '9990001111' });
    const c = await worker.runOnce(async () => { const e = new Error('socket timeout'); e.code = 'ETIMEDOUT'; throw e; }, { workerId: 'w-t4', batchSize: 5 });
    assert.strictEqual(c.ambiguous, 1, JSON.stringify(c));
    assert.strictEqual(c.retried, 0, 'ambiguous must NOT be retried');
    const row = await outbox.getByEventKey(k);
    assert.strictEqual(row.status, 'ambiguous');
  });

  await t('ambiguous row stays parked and is never auto-resent', async () => {
    const k = AMB_KEY;
    await new Promise(r => setTimeout(r, 50));
    const c = await worker.runOnce(async () => { throw new Error('should not run'); }, { workerId: 'w-t5', batchSize: 5 });
    assert.strictEqual(c.claimed, 0, 'ambiguous rows must not be claimable');
    const row = await outbox.getByEventKey(k);
    assert.ok(row, 'row should still exist');
    assert.strictEqual(row.status, 'ambiguous');
  });

  await t('explicit err.ambiguous flag is honoured', async () => {
    await clean();
    const k = K('ambflag');
    await outbox.enqueue({ eventKey: k, messageType: 'portal_link', recipient: '9990001111' });
    const c = await worker.runOnce(async () => { const e = new Error('unknown state'); e.ambiguous = true; throw e; }, { workerId: 'w-t6', batchSize: 5 });
    assert.strictEqual(c.ambiguous, 1);
    assert.strictEqual((await outbox.getByEventKey(k)).status, 'ambiguous');
  });

  await t('retries stop at max_attempts and record final failure', async () => {
    await clean();
    const k = K('exhaust');
    await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111', maxAttempts: 1 });
    const c = await worker.runOnce(async () => { const e = new Error('still 500'); e.status = 500; throw e; }, { workerId: 'w-t7', batchSize: 5 });
    assert.strictEqual(c.failed, 1, JSON.stringify(c));
    assert.strictEqual((await outbox.getByEventKey(k)).status, 'failed');
  });

  // --------------------------------------------------------- security ----
  await t('error summaries redact tokens and phone numbers', () => {
    const { msg } = outbox.summarise(new Error('failed for EAAabcdef0123456789ABCDEF and 919876543210'));
    assert.ok(!/EAAabcdef0123456789/.test(msg), 'token leaked into error text');
    assert.ok(!/919876543210/.test(msg), 'phone leaked into error text');
  });

  await t('no credential columns exist on the outbox', async () => {
    const cols = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='whatsapp_outbox'`);
    const names = cols.rows.map(r => r.column_name);
    for (const bad of ['access_token', 'token', 'password', 'secret']) {
      assert.ok(!names.includes(bad), `unexpected column ${bad}`);
    }
    assert.ok(names.includes('payload') && names.includes('recipient_phone'));
  });

  await t('worker restart mid-flight does not duplicate (row already sent)', async () => {
    await clean();
    const k = K('restart');
    const r = await outbox.enqueue({ eventKey: k, messageType: 'order_created', recipient: '9990001111' });
    await outbox.claimDue({ workerId: 'w-crash', limit: 5, claimTimeoutMs: 50 });
    await outbox.markSent(r.id, 'wamid.restart.1');
    await new Promise(res => setTimeout(res, 200));
    const c = await worker.runOnce(async () => { throw new Error('must not run'); }, { workerId: 'w-after', batchSize: 5, claimTimeoutMs: 100000 });
    assert.strictEqual(c.claimed, 0);
    assert.strictEqual((await outbox.getByEventKey(k)).status, 'sent');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await clean();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async e => { console.error('HARNESS ERROR:', e.message); await pool.end().catch(() => {}); process.exit(1); });