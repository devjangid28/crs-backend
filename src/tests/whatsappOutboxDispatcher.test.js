/**
 * Outbox dispatcher + worker-entrypoint tests.
 *
 * WhatsApp is NEVER contacted. `whatsappService` is required lazily by the
 * dispatcher, so this suite installs its own stub into require.cache first.
 *
 *   $env:INVOICE_PORTAL_TEST_DB='bluechipcs_invoiceportal_test'
 *   node src/tests/whatsappOutboxDispatcher.test.js
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
process.env.WHATSAPP_ENABLED = 'false';

const { query, pool } = require('../config/database');

// ---------------------------------------------------------------- stub ----
let calls = [];
function stubResult(r) { calls.push(r); return r; }
const stub = {
  calls,
  orderResult: null,
  ticketResult: null,
  reset() { calls = []; stub.calls = calls; this.orderResult = null; this.ticketResult = null; },
  isEnabled: () => true,
  notifyOrderCreated: async (order, store) => {
    stub.lastOrder = { order, store };
    return stub.orderResult || { template: { success: true, messageId: 'wamid.stub.order' } };
  },
  notifyTicketCreated: async (ticket, store) => {
    stub.lastTicket = { ticket, store };
    return stub.ticketResult || { template: { success: true, messageId: 'wamid.stub.ticket' } };
  },
};

const waPath = require.resolve('../services/whatsappService');
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: stub };

const dispatcher = require('../services/whatsappOutboxDispatcher');
const outbox = require('../services/whatsappOutboxService');
const worker = require('../services/whatsappOutboxWorker');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
const K = (n) => `testdisp:${n}:${Math.random().toString(36).slice(2, 10)}`;

// Unique per run so a crashed previous run cannot collide on the unique
// order_number / ticket_id constraints.
const UID = Math.random().toString(36).slice(2, 8).toUpperCase();
const ON = (n) => `TESTDISP${n}-${UID}`;   // order_number
const TN = (n) => `T-DISP${n}-${UID}`;    // ticket_id

async function clean() { await query(`DELETE FROM whatsapp_outbox WHERE event_key LIKE 'testdisp:%'`); }
async function cleanFixtures() {
  await query(`DELETE FROM orders WHERE order_number LIKE 'TESTDISP%'`);
  await query(`DELETE FROM tickets WHERE ticket_id LIKE 'T-DISP%'`);
}

(async () => {
  const has = await query("SELECT to_regclass('public.whatsapp_outbox')::text t");
  if (!has.rows[0].t) { console.error('whatsapp_outbox missing'); process.exit(2); }

  // Remove fixtures left behind by a crashed earlier run.
  await cleanFixtures();

  console.log(`\nOutbox dispatcher tests  [db=${TEST_DB}, no Meta calls]\n`);

  // ---------------------------------------------------- reload contract --
  await t('dispatcher RELOADS the order row instead of trusting the outbox', async () => {
    await clean();
    stub.reset();
    const ins = await query(
      `INSERT INTO orders (order_number, customer_name, mobile_number, address, device_type, total_amount, store_id)
       VALUES ('${ON(1)}','Test Customer','9990001111','Test St','Laptop',1234.50,1) RETURNING id`
    );
    const orderId = ins.rows[0].id;

    const row = {
      id: 1, event_key: K('r1'), message_type: 'order_created',
      source_type: 'order', source_id: orderId, recipient_phone: '919990001111',
      payload: ['FROZEN NAME', 'FROZEN ORDER NO', 'FROZEN DEVICE', 'FROZEN PRICE'],
      store_id: null,
    };
    const out = await dispatcher.dispatch({ row });

    assert.ok(stub.lastOrder, 'notifyOrderCreated was not called');
    assert.strictEqual(stub.lastOrder.order.id, orderId);
    assert.strictEqual(stub.lastOrder.order.customer_name, 'Test Customer',
      'order must be re-read from DB, not from outbox payload');
    assert.strictEqual(stub.lastOrder.store.store_name, 'BLUECHIP COMPUTER SYSTEM',
      'store must be resolved from store_id');
    assert.strictEqual(out.messageId, 'wamid.stub.order');

    // The frozen payload must not have leaked into the reloaded row.
    assert.notStrictEqual(stub.lastOrder.order.customer_name, 'FROZEN NAME');
    await query('DELETE FROM orders WHERE id = $1', [orderId]);
  });

  await t('corrections after enqueue ARE reflected (the point of reloading)', async () => {
    await clean();
    stub.reset();
    const ins = await query(
      `INSERT INTO orders (order_number, customer_name, mobile_number, address, device_type, total_amount, store_id)
       VALUES ('${ON(2)}','Before Fix','9990002222','Test St','Laptop',100,1) RETURNING id`
    );
    const id = ins.rows[0].id;
    // Customer name corrected after the message was queued.
    await query(`UPDATE orders SET customer_name = 'After Fix' WHERE id = $1`, [id]);

    const out = await dispatcher.dispatch({
      row: {
        id: 1, event_key: K('r2'), message_type: 'order_created',
        source_type: 'order', source_id: id, recipient_phone: '919990002222', payload: [],
      },
    });
    assert.strictEqual(stub.lastOrder.order.customer_name, 'After Fix');
    assert.strictEqual(out.messageId, 'wamid.stub.order');
    await query('DELETE FROM orders WHERE id = $1', [id]);
  });

  await t('outbox does NOT persist customer PII for reload-based messages', async () => {
    await clean();
    const ins = await query(
      `INSERT INTO tickets (ticket_id, customer_name, customer_phone, device_type, brand, model, issue_category, problem_description, store_id)
       VALUES ('${TN(1)}','Secret Person','9990003333','Laptop','ASUS','X1','Hardware','Broken',1) RETURNING id`
    );
    const tid = ins.rows[0].id;
    // Enqueue with identifiers only - the shape the routes will use.
    await outbox.enqueue({
      eventKey: K('pii'), messageType: 'ticket_created',
      recipient: '9990003333', sourceType: 'ticket', sourceId: tid, payload: [],
    });
    const row = await outbox.getByEventKey((await query(
      `SELECT event_key FROM whatsapp_outbox WHERE event_key LIKE 'testdisp:pii%'`)).rows[0].event_key);
    assert.ok(row, 'row should exist');
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes('Secret Person'), 'customer name was persisted into the outbox');
    await query('DELETE FROM tickets WHERE id = $1', [tid]);
  });

  // --------------------------------------------------- terminal failures --
  await t('deleted source row becomes a TERMINAL failure, not a silent drop', async () => {
    await clean();
    await outbox.enqueue({
      eventKey: K('gone'), messageType: 'order_created', recipient: '9990001111',
      sourceType: 'order', sourceId: 999999999, payload: [],
    });
    const c = await worker.runOnce((ctx) => dispatcher.dispatch(ctx), { workerId: 'w-gone', batchSize: 5 });
    assert.strictEqual(c.failed, 1, JSON.stringify(c));
    const row = await outbox.getByEventKey((await query(
      `SELECT event_key FROM whatsapp_outbox WHERE event_key LIKE 'testdisp:gone%'`)).rows[0].event_key);
    assert.strictEqual(row.status, 'failed');
    assert.ok(/no longer exists/.test(row.last_error), row.last_error);
  });

  await t('re-engagement rejection is terminal (not retried forever)', async () => {
    await clean();
    stub.reset();
    const ins = await query(
      `INSERT INTO orders (order_number, customer_name, mobile_number, address, device_type, total_amount, store_id)
       VALUES ('${ON(3)}','Reeng','9990004444','Test St','Laptop',50,1) RETURNING id`
    );
    const id = ins.rows[0].id;
    await outbox.enqueue({
      eventKey: K('re'), messageType: 'order_created', recipient: '9990004444',
      sourceType: 'order', sourceId: id, payload: [],
    });
    stub.orderResult = { template: { success: false, error: 're-engagement message', code: 131026 } };
    const c = await worker.runOnce((ctx) => dispatcher.dispatch(ctx), { workerId: 'w-re', batchSize: 5 });
    assert.strictEqual(c.failed, 1, JSON.stringify(c));
    assert.strictEqual(c.retried, 0, '131026 must not be retried');
    stub.reset();
    await query('DELETE FROM orders WHERE id = $1', [id]);
  });

  await t('template failure + text fallback is NOT re-sent', async () => {
    await clean();
    stub.reset();
    const ins = await query(
      `INSERT INTO orders (order_number, customer_name, mobile_number, address, device_type, total_amount, store_id)
       VALUES ('${ON(4)}','Fallback','9990005555','Test St','Laptop',50,1) RETURNING id`
    );
    const id = ins.rows[0].id;
    await outbox.enqueue({
      eventKey: K('fb'), messageType: 'order_created', recipient: '9990005555',
      sourceType: 'order', sourceId: id, payload: [],
    });
    // notifyOrderCreated fell back to text - customer WAS reached.
    stub.orderResult = { templateFallback: true, template: null };
    const c = await worker.runOnce((ctx) => dispatcher.dispatch(ctx), { workerId: 'w-fb', batchSize: 5 });
    assert.strictEqual(c.sent, 1, JSON.stringify(c));
    assert.strictEqual(c.retried, 0, 'fallback already delivered; must not retry');
    stub.reset();
    await query('DELETE FROM orders WHERE id = $1', [id]);
  });

  await t('ticket row reloads and resolves its store', async () => {
    await clean();
    stub.reset();
    const ins = await query(
      `INSERT INTO tickets (ticket_id, customer_name, customer_phone, device_type, brand, model, issue_category, problem_description, store_id, estimated_price)
       VALUES ('${TN(2)}','Tick','9990006666','Laptop','ASUS','X1','Hardware','Broken',2,999) RETURNING id`
    );
    const id = ins.rows[0].id;
    const out = await dispatcher.dispatch({
      row: {
        id: 1, event_key: K('tk'), message_type: 'ticket_created',
        source_type: 'ticket', source_id: id, recipient_phone: '919990006666', payload: [],
      },
    });
    assert.strictEqual(stub.lastTicket.ticket.id, id);
    assert.strictEqual(stub.lastTicket.store.store_name, 'ASUS EXCLUSIVE STORE');
    assert.strictEqual(out.messageId, 'wamid.stub.ticket');
    stub.reset();
    await query('DELETE FROM tickets WHERE id = $1', [id]);
  });

  await t('unknown message_type fails loudly instead of guessing', async () => {
    await clean();
    await assert.rejects(
      () => dispatcher.dispatch({ row: { message_type: 'portal_link', source_id: 1 } }),
      (e) => e.dispatchKind === 'failed'
    );
  });

  // ------------------------------------------------ entrypoint safety ----
  await t('worker entrypoint refuses to boot when WhatsApp is disabled', async () => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'workers', 'outboxWorker.js')], {
      env: { ...process.env, WHATSAPP_ENABLED: 'false' },
      encoding: 'utf8', timeout: 30000,
    });
    assert.strictEqual(r.status, 3, `expected exit 3, got ${r.status}: ${r.stderr || r.stdout}`);
    assert.ok(/REFUSING TO START/.test(r.stdout + r.stderr), 'expected a refusal message');
  });

  await t('worker entrypoint is syntactically valid', async () => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', 'workers', 'outboxWorker.js')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  });

  await t('outbox pm2 config declares exactly one worker app', () => {
    const cfg = require(path.join(__dirname, '..', '..', '..', 'ecosystem.outbox.cjs'));
    assert.strictEqual(cfg.apps.length, 1);
    assert.strictEqual(cfg.apps[0].name, 'crs-outbox-worker');
    assert.strictEqual(cfg.apps[0].script, 'src/workers/outboxWorker.js');
    assert.strictEqual(cfg.apps[0].instances, 1);
  });

  await t('main pm2 config still has exactly the original 3 services', () => {
    const cfg = require(path.join(__dirname, '..', '..', '..', 'ecosystem.config.cjs'));
    const names = cfg.apps.map((a) => a.name).sort();
    assert.deepStrictEqual(names, ['crs-backend', 'crs-frontend', 'crs-tunnel']);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await clean();
  await cleanFixtures();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('HARNESS ERROR:', e.message); await pool.end().catch(() => {}); process.exit(1); });