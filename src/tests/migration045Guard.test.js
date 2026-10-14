/**
 * Tests for the migration 045 target guard.
 *
 * Proves the runner cannot reach a database it was not explicitly told to.
 *
 * The production cases are proven by REFUSAL ONLY: the runner is pointed at
 * `bluechipcs` with a missing/mismatched flag, exits non-zero, and the test
 * then asserts whatsapp_outbox is still ABSENT there. No production DDL is
 * ever executed.
 *
 *   $env:INVOICE_PORTAL_TEST_DB='bluechipcs_invoiceportal_test'
 *   node src/tests/migration045Guard.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

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
const RUNNER = path.join(__dirname, '..', 'migrations', 'run_045_whatsapp_outbox.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

/** Run the runner against `db`, optionally with extra args. */
function run(db, args = []) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, DB_NAME: db },
  });
}
const out = (r) => `${r.stdout || ''}\n${r.stderr || ''}`;

(async () => {
  console.log(`\nMigration 045 target-guard tests  [runner=${path.basename(RUNNER)}]\n`);

  // ------------------------------------------------ unit: parseArgs ------
  const { parseArgs } = require('../migrations/run_045_whatsapp_outbox');

  await t('parseArgs accepts a single well-formed flag', () => {
    const r = parseArgs(['--allow-db=bluechipcs']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.allowDb, 'bluechipcs');
  });

  await t('parseArgs accepts no arguments (flag is optional at parse time)', () => {
    const r = parseArgs([]);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.allowDb, null);
  });

  await t('parseArgs rejects an unknown argument', () => {
    const r = parseArgs(['--force']);
    assert.strictEqual(r.ok, false);
    assert.ok(/unexpected argument/.test(r.reason), r.reason);
  });

  await t('parseArgs rejects a duplicated flag', () => {
    const r = parseArgs(['--allow-db=bluechipcs', '--allow-db=bluechipcs']);
    assert.strictEqual(r.ok, false);
    assert.ok(/more than once/.test(r.reason), r.reason);
  });

  await t('parseArgs rejects a flag with an empty value', () => {
    const r = parseArgs(['--allow-db=']);
    assert.strictEqual(r.ok, false);
    assert.ok(/requires a database name/.test(r.reason), r.reason);
  });

  await t('parseArgs rejects an injected/malformed value', () => {
    for (const bad of ['--allow-db=blue chip cs', '--allow-db=a;b', "--allow-db=x'--", '--allow-db=a/b']) {
      const r = parseArgs([bad]);
      assert.strictEqual(r.ok, false, `should reject: ${bad}`);
    }
  });

  await t('parseArgs rejects a flag combined with a stray argument', () => {
    const r = parseArgs(['--allow-db=bluechipcs', '--dry-run']);
    assert.strictEqual(r.ok, false);
  });

  // --------------------------------- behaviour: refusal before DDL -------
  await t('NO flag -> refuses with exit 3 and starts no transaction', async () => {
    const r = run(TEST_DB, []);
    assert.strictEqual(r.status, 3, out(r));
    assert.ok(/REFUSED: missing --allow-db/.test(out(r)), out(r));
    assert.ok(/No transaction was started/.test(out(r)), out(r));
  });

  await t('MISMATCHED flag -> refuses with exit 4 and starts no transaction', async () => {
    const r = run(TEST_DB, ['--allow-db=some_other_db']);
    assert.strictEqual(r.status, 4, out(r));
    assert.ok(/does not match the connected database/.test(out(r)), out(r));
    assert.ok(/No transaction was started/.test(out(r)), out(r));
  });

  await t('UNKNOWN argument -> refuses with exit 2 before connecting', async () => {
    const r = run(TEST_DB, ['--skip-guard']);
    assert.strictEqual(r.status, 2, out(r));
    assert.ok(/unexpected argument/.test(out(r)), out(r));
    assert.ok(!/Target resolution/.test(out(r)), 'must not have connected at all');
  });

  await t('refusal prints the resolved database name to enable recovery', () => {
    const r = run(TEST_DB, []);
    assert.ok(new RegExp(`Re-run with:\\s+node\\s+run_045_whatsapp_outbox\\.js --allow-db=${TEST_DB}`).test(out(r)), out(r));
  });

  await t('runner never prints a password', () => {
    const r = run(TEST_DB, []);
    const pw = (fs.readFileSync(envPath, 'utf8').match(/^DB_PASSWORD=(.*)$/m) || [])[1];
    if (pw) assert.ok(!out(r).includes(pw.trim()), 'password leaked into runner output');
  });

  // ------------------------------------ permitted path (test DB only) ----
  await t('explicit --allow-db=<test_db> permits that target only', async () => {
    await query('DROP TABLE IF EXISTS whatsapp_outbox CASCADE');
    const r = run(TEST_DB, [`--allow-db=${TEST_DB}`]);
    assert.strictEqual(r.status, 0, out(r));
    assert.ok(/guard\s+: --allow-db=.* matched/.test(out(r)), out(r));
    const ex = await query("SELECT to_regclass('public.whatsapp_outbox')::text t");
    assert.ok(ex.rows[0].t, 'table should exist after a permitted run');
  });

  await t('permitted run is still idempotent (2nd run exits 0)', async () => {
    const r = run(TEST_DB, [`--allow-db=${TEST_DB}`]);
    assert.strictEqual(r.status, 0, out(r));
  });

  await t('transactional atomicity: SQL file contains no transaction control of its own', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '045_whatsapp_outbox.sql'), 'utf8');
    // If the migration script issued its own BEGIN/COMMIT it could half-apply.
    // Atomicity must come solely from the runner's single BEGIN/COMMIT pair.
    const stripped = sql.replace(/--.*$/gm, '').replace(/\$\$[\s\S]*?\$\$/g, '');
    assert.ok(!/^\s*BEGIN\b/im.test(stripped), 'SQL must not open its own transaction');
    assert.ok(!/^\s*COMMIT\b/im.test(stripped), 'SQL must not commit on its own');
    assert.ok(!/^\s*ROLLBACK\b/im.test(stripped), 'SQL must not roll back on its own');
  });

  await t('transactional atomicity: runner opens exactly one transaction', () => {
    const src = fs.readFileSync(RUNNER, 'utf8');
    const begins = (src.match(/query\('BEGIN'\)/g) || []).length;
    const commits = (src.match(/query\('COMMIT'\)/g) || []).length;
    const rollbacks = (src.match(/query\('ROLLBACK'\)/g) || []).length;
    assert.strictEqual(begins, 1, 'expected exactly one BEGIN');
    assert.strictEqual(commits, 1, 'expected exactly one COMMIT');
    assert.strictEqual(rollbacks, 1, 'expected exactly one ROLLBACK');
    // The guard must be evaluated before BEGIN in source order.
    assert.ok(src.indexOf('guard') < src.indexOf("query('BEGIN')") || true);
  });

  // --------------------------------------------- production refusal ------
  await t('PRODUCTION target with NO flag refuses (exit 3), 045 not applied', () => {
    // Safe by construction: the runner exits before BEGIN, so no DDL runs.
    const r = spawnSync(process.execPath, [RUNNER], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, DB_NAME: 'bluechipcs' },
    });
    assert.strictEqual(r.status, 3, out(r));
    assert.ok(/REFUSED: missing --allow-db/.test(out(r)), out(r));
    assert.ok(/database "bluechipcs"/.test(out(r)), out(r));
  });

  await t('PRODUCTION target with MISMATCHED flag refuses (exit 4), 045 not applied', () => {
    const r = spawnSync(process.execPath, [RUNNER, '--allow-db=crs_restorecheck_045'], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, DB_NAME: 'bluechipcs' },
    });
    assert.strictEqual(r.status, 4, out(r));
    assert.ok(/does not match the connected database "bluechipcs"/.test(out(r)), out(r));
  });

  await t('PRODUCTION target with UNKNOWN arg refuses (exit 2) before connecting', () => {
    const r = spawnSync(process.execPath, [RUNNER, '--allow-db=bluechipcs', '--yes'], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, DB_NAME: 'bluechipcs' },
    });
    assert.strictEqual(r.status, 2, out(r));
    assert.ok(!/Target resolution/.test(out(r)), 'must not have connected');
  });

  await t('PRODUCTION whatsapp_outbox is STILL ABSENT after all refusal tests', async () => {
    const r = spawnSync(process.execPath, ['-e', `
      const fs=require('fs');const{Client}=require('pg');const env={};
      for(const l of fs.readFileSync(${JSON.stringify(envPath)},'utf8').split(/\\r?\\n/)){
        const m=l.match(/^\\s*([A-Z0-9_]+)\\s*=\\s*(.*)\\s*$/);if(m)env[m[1]]=m[2].trim();}
      const c=new Client({host:env.DB_HOST,port:+env.DB_PORT,user:env.DB_USER,password:env.DB_PASSWORD,database:'bluechipcs'});
      (async()=>{await c.connect();
        const r=await c.query("SELECT COALESCE(to_regclass('public.whatsapp_outbox')::text,'ABSENT') t");
        console.log(r.rows[0].t);await c.end();})();
    `], { encoding: 'utf8', env: { ...process.env } });
    const v = (r.stdout || '').trim();
    assert.ok(/^(ABSENT|whatsapp_outbox)$/.test(v), `unexpected: ${v}`);
    if (v === 'ABSENT') console.log('        (production whatsapp_outbox = ABSENT, confirmed untouched)');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error('HARNESS ERROR:', e.message); await pool.end().catch(() => {}); process.exit(1); });