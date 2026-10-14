/**
 * Standalone outbox worker process.
 *
 * Run as its own PM2 app so the API stays responsive and a worker crash cannot
 * lose queued messages (rows are durable in Postgres, not in this process).
 *
 *   pm2 start ecosystem.config.cjs --only crs-outbox-worker
 *
 * Safe to run multiple instances: claiming is a conditional UPDATE, so two
 * workers can never hold the same row.
 *
 * This file NEVER enqueues anything - it only drains. Enqueueing stays on the
 * request path.
 */

require('../config/database'); // initialises the pool
const worker = require('../services/whatsappOutboxWorker');
const dispatcher = require('../services/whatsappOutboxDispatcher');
const outbox = require('../services/whatsappOutboxService');

const pollMs = Number(process.env.OUTBOX_POLL_MS || 5000);
const claimTimeoutMs = Number(process.env.OUTBOX_CLAIM_TIMEOUT_MS || 120_000);
const batchSize = Number(process.env.OUTBOX_BATCH_SIZE || 10);
const workerId = process.env.OUTBOX_WORKER_ID || `pm2-${process.pid}`;

let stopping = false;
let workerHandle = null;

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[outbox ${workerId}] ${signal} - finishing current batch then exiting`);
  if (workerHandle && typeof workerHandle.stop === 'function') workerHandle.stop();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function reportStats() {
  try {
    const rows = await outbox.stats();
    const line = rows.map((r) => `${r.status}=${r.n}`).join(' ');
    console.log(`[outbox ${workerId}] queue ${line || 'empty'}`);
  } catch (e) {
    console.error(`[outbox ${workerId}] stats failed:`, outbox.summarise(e).msg);
  }
}

async function main() {
  // Never boot into a send loop with WhatsApp disabled - that would drain
  // nothing forever and look healthy while silently doing nothing.
  const wa = require('../services/whatsappService');
  if (!wa.isEnabled()) {
    console.error(
      `[outbox ${workerId}] REFUSING TO START: WhatsApp is disabled (WHATSAPP_ENABLED=false or missing token). ` +
      'Queued messages would never be delivered.'
    );
    process.exit(3);
  }

  console.log(`[outbox ${workerId}] starting  poll=${pollMs}ms batch=${batchSize} claimTimeout=${claimTimeoutMs}ms`);

  const sender = async (ctx) => {
    const outcome = await dispatcher.dispatch(ctx);
    if (outcome && outcome.fallback) {
      console.log(`[outbox ${workerId}] row ${ctx.row.id} delivered via text fallback`);
    }
    return outcome;
  };

  // Prime the pool and confirm the table exists before looping, so a missing
  // migration fails loudly at boot instead of once per cycle.
  const probe = await outbox.stats().catch((e) => {
    console.error(`[outbox ${workerId}] cannot read whatsapp_outbox: ${outbox.summarise(e).msg}`);
    console.error('[outbox ${workerId}] apply migration 045 before starting this worker.');
    process.exit(4);
  });
  if (!Array.isArray(probe)) process.exit(4);

  const handle = await worker.start(sender, {
    workerId,
    pollMs,
    batchSize,
    claimTimeoutMs,
  });
  workerHandle = handle;

  console.log(`[outbox ${workerId}] stopped after ${handle.iterations} cycles`);
  await reportStats();
  process.exit(0);
}

main().catch((e) => {
  console.error(`[outbox ${workerId}] fatal:`, e && e.message);
  process.exit(1);
});