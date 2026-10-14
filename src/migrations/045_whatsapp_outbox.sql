-- 045: Durable WhatsApp outbox
--
-- Purpose
-- -------
-- Order and ticket notifications are currently fired from a `setImmediate`
-- inside the request handler. If the process restarts, or the request is
-- retried by the client, the notification is silently lost or sent twice.
-- There is no retry and no idempotency anywhere on those paths.
--
-- This table turns those sends into rows that can be claimed, retried and
-- audited. It stores NO credentials and deliberately keeps customer data to a
-- minimum: the recipient phone is held in a dedicated column (needed to send)
-- and the free-text payload holds template variable values only.
--
-- Delivery semantics (read before trusting this table)
-- ----------------------------------------------------
-- This is AT-LEAST-ONCE with an explicit AMBIGUOUS state. It is NOT
-- exactly-once and cannot be made so:
--
--   * A network timeout / 5xx AFTER WhatsApp already accepted the message is
--     an AMBIGUOUS outcome. We cannot know whether the customer got it.
--   * Retrying an AMBIGUOUS row blindly can double-message a real customer.
--     Those rows are therefore parked in status 'ambiguous' and are NOT
--     retried automatically. They require human reconciliation using the
--     WhatsApp Business "Message IDs" lookup (wamid) or the customer-facing
--     conversation thread.
--   * `event_key` makes ENQUEUE idempotent: replaying the same business event
--     never produces a second row. That is the guarantee we can actually give.
--
-- Re-running this migration is safe (all statements are IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id              SERIAL PRIMARY KEY,

  -- Idempotency. Built from the business event, e.g.
  --   order_created:1234:confirmation
  --   order_created:1234:portal_link
  -- Re-enqueuing the same key is a no-op, which is what protects us from the
  -- duplicated-send problem on repeated requests.
  event_key       VARCHAR(180) NOT NULL,

  -- Logical message kind, e.g. 'order_created' | 'ticket_created' | 'portal_link'.
  message_type    VARCHAR(60)  NOT NULL,

  -- Meta template name actually sent. Kept separate from message_type so the
  -- template can be renamed in code without rewriting history.
  template_name   VARCHAR(120),

  -- Recipient in normalised international form, e.g. 919876543210.
  recipient_phone VARCHAR(20)  NOT NULL,

  -- Template variable values, ordered, matching the approved template body.
  -- Never contains tokens, credentials or full customer records.
  payload         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Human-readable origin for auditing, e.g. order:1234. Not a FK so the row
  -- survives deletion of the parent record.
  source_type     VARCHAR(30),
  source_id       INTEGER,

  store_id        INTEGER REFERENCES stores(id) ON DELETE SET NULL,

  -- Scheduling. A row is only picked up once run_after <= now().
  run_after       TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMP,

  -- pending | claimed | sent | failed | ambiguous | cancelled
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',

  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,

  -- Concurrency control. A worker claims rows by writing claimed_by +
  -- claimed_at under a conditional UPDATE, so two workers can never take the
  -- same row. Stale claims are reclaimable after claim_timeout.
  claimed_by      VARCHAR(80),
  claimed_at      TIMESTAMP,

  -- WhatsApp's message id (wamid) when the send is accepted. Used for
  -- reconciliation of ambiguous rows.
  provider_message_id VARCHAR(120),

  -- Only short, non-sensitive failure summaries. Never a stack trace, never a
  -- request body, never a token.
  last_error      VARCHAR(500),
  error_code      VARCHAR(30),

  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT whatsapp_outbox_status_chk
    CHECK (status IN ('pending','claimed','sent','failed','ambiguous','cancelled'))
);

-- Idempotency: the guarantee we can actually give.
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_outbox_event_key
  ON whatsapp_outbox (event_key);

-- Worker claim path: only rows that are due and not owned.
CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_due
  ON whatsapp_outbox (status, run_after)
  WHERE status = 'pending';

-- Reclaiming rows whose worker died mid-claim.
CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_claimed
  ON whatsapp_outbox (status, claimed_at)
  WHERE status = 'claimed';

-- Audit / per-entity lookups.
CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_source
  ON whatsapp_outbox (source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_type
  ON whatsapp_outbox (message_type, created_at DESC);

-- Keep updated_at honest without a trigger (the project avoids triggers on hot
-- tables; server.js already does runtime DDL but a function is cheaper here).
CREATE OR REPLACE FUNCTION touch_whatsapp_outbox_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_whatsapp_outbox_updated_at'
  ) THEN
    CREATE TRIGGER trg_whatsapp_outbox_updated_at
      BEFORE UPDATE ON whatsapp_outbox
      FOR EACH ROW EXECUTE FUNCTION touch_whatsapp_outbox_updated_at();
  END IF;
END $$;

-- Operational readouts.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  IF to_regclass('public.whatsapp_outbox') IS NULL THEN
    RAISE EXCEPTION 'whatsapp_outbox was not created';
  END IF;
  SELECT count(*) INTO tbl FROM whatsapp_outbox;
  RAISE NOTICE 'whatsapp_outbox ready, existing rows: %', tbl;
END $$;