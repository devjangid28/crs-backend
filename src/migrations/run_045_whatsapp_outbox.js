/**
 * Runner for migration 045 (durable WhatsApp outbox).
 *
 * TARGET GUARD - read before running
 * -----------------------------------
 * This script previously connected to whatever `.env` pointed at and applied
 * the migration with no confirmation, so an ordinary invocation would silently
 * modify PRODUCTION. That is now impossible:
 *
 *   * The target is resolved from the live connection, NOT from DB_NAME alone.
 *     config.db.database can disagree with the database actually reached when
 *     DATABASE_URL is set - database.js prefers DATABASE_URL and ignores
 *     DB_NAME entirely - so the authoritative answer is `current_database()`.
 *   * The resolved name must be echoed back with --allow-db=<name>.
 *   * No DDL and no transaction start until the guard passes.
 *
 * Usage:
 *   node run_045_whatsapp_outbox.js --allow-db=<database_name>
 *
 * Examples:
 *   node run_045_whatsapp_outbox.js --allow-db=crs_restorecheck_045
 *   node run_045_whatsapp_outbox.js --allow-db=bluechipcs
 *
 * Exit codes:
 *   0  migration applied
 *   1  migration failed (transaction rolled back)
 *   2  invalid command line (unknown, duplicated or malformed argument)
 *   3  no --allow-db flag supplied
 *   4  --allow-db does not match the resolved database
 *   5  could not resolve the target database
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

const SQL_FILE = '045_whatsapp_outbox.sql';
const ALLOW_FLAG = '--allow-db=';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_BAD_ARGS = 2;
const EXIT_NO_FLAG = 3;
const EXIT_MISMATCH = 4;
const EXIT_NO_TARGET = 5;

/**
 * Strict argument parsing.
 * Rejects unknown arguments, duplicates and malformed values.
 *
 * @returns {{ok:true, allowDb:string|null}|{ok:false, reason:string}}
 */
function parseArgs(argv) {
  let allowDb = null;

  for (const arg of argv) {
    if (!arg.startsWith('--allow-db=')) {
      return { ok: false, reason: `unexpected argument "${arg}". Only ${ALLOW_FLAG}<database_name> is accepted.` };
    }
    if (allowDb !== null) {
      return { ok: false, reason: `--allow-db was supplied more than once.` };
    }
    const value = arg.slice(ALLOW_FLAG.length);
    if (!value) {
      return { ok: false, reason: `${ALLOW_FLAG} requires a database name, e.g. ${ALLOW_FLAG}bluechipcs` };
    }
    if (/\s/.test(value) || !/^[A-Za-z0-9_$-]+$/.test(value)) {
      return { ok: false, reason: `"${value}" is not a valid database name.` };
    }
    allowDb = value;
  }

  return { ok: true, allowDb };
}

/**
 * Resolve the database this script will ACTUALLY talk to, using the same pool
 * the migration itself runs on. Read-only queries only.
 */
async function resolveTarget(client) {
  const db = await client.query('SELECT current_database() AS name');
  const host = await client.query('SELECT current_user AS usr, inet_server_addr()::text AS addr');
  return {
    database: db.rows[0].name,
    user: host.rows[0].usr,
    addr: host.rows[0].addr,
  };
}

async function runMigration() {
  // ---- 1. Strict argument validation, BEFORE any connection or DDL -------
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`REFUSED: ${args.reason}`);
    console.error('No connection was opened and no transaction was started.');
    process.exit(EXIT_BAD_ARGS);
  }

  const sqlPath = path.join(__dirname, SQL_FILE);
  const sql = fs.readFileSync(sqlPath, 'utf-8');

  const client = await pool.connect();
  let inTransaction = false;

  try {
    // ---- 2. Resolve the REAL target from the connection -----------------
    const target = await resolveTarget(client);

    // Intentionally prints host/user but NEVER the password.
    console.log('Target resolution (read-only):');
    console.log(`  database : ${target.database}`);
    console.log(`  host     : ${target.addr ? `${target.addr}:5432` : 'local socket'}`);
    console.log(`  role     : ${target.user}`);

    // ---- 3. Guard: explicit opt-in, matched against the resolved target -
    if (args.allowDb === null) {
      console.error('');
      console.error(`REFUSED: missing ${ALLOW_FLAG}<database_name>`);
      console.error(`  This migration would modify database "${target.database}".`);
      console.error(`  Re-run with:  node ${path.basename(__filename)} ${ALLOW_FLAG}${target.database}`);
      console.error('No transaction was started.');
      process.exit(EXIT_NO_FLAG);
    }

    if (args.allowDb !== target.database) {
      console.error('');
      console.error(`REFUSED: ${ALLOW_FLAG}${args.allowDb} does not match the connected database "${target.database}".`);
      console.error(`  Re-run with:  node ${path.basename(__filename)} ${ALLOW_FLAG}${target.database}`);
      console.error('No transaction was started.');
      process.exit(EXIT_MISMATCH);
    }

    console.log(`  guard    : ${ALLOW_FLAG}${args.allowDb} matched - proceeding`);
    console.log(`\nRunning migration: ${SQL_FILE} on "${target.database}" ...`);

    // ---- 4. Only now is it safe to touch the database -------------------
    await client.query('BEGIN');
    inTransaction = true;
    await client.query(sql);
    await client.query('COMMIT');
    inTransaction = false;

    const v = await client.query(`
      SELECT
        to_regclass('public.whatsapp_outbox')::text AS tbl,
        (SELECT count(*) FROM whatsapp_outbox)::int AS rows
    `);
    console.log('Migration 045 completed successfully.');
    console.log('  database               :', target.database);
    console.log('  whatsapp_outbox table  :', v.rows[0].tbl);
    console.log('  existing rows          :', v.rows[0].rows);
    process.exit(EXIT_OK);
  } catch (err) {
    if (inTransaction) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    }
    console.error(`Migration ${SQL_FILE} failed on the connected database:`, err.message);
    process.exit(EXIT_FAILED);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

module.exports = { parseArgs, resolveTarget };

if (require.main === module) {
  runMigration().catch((e) => {
    console.error('Fatal:', e && e.message);
    process.exit(EXIT_NO_TARGET);
  });
}