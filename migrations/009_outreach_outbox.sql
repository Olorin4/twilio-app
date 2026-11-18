-- Events waiting to be sent to Outreach (contract jack.call.v1): one row per
-- call and revision. Rows are written in the same transaction as the call
-- change that produced them and sent by src/outreachIntake/sender.js.
-- Additive and safe to rerun.
CREATE TABLE IF NOT EXISTS outreach_outbox (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  call_sid text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  contract text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (call_sid, revision)
);
CREATE INDEX IF NOT EXISTS outreach_outbox_due_idx
  ON outreach_outbox (next_attempt_at, id) WHERE status = 'PENDING';
