CREATE TABLE IF NOT EXISTS twilio_call_legs (
  call_sid text PRIMARY KEY,
  parent_call_sid text NOT NULL,
  status text NOT NULL,
  status_rank integer NOT NULL,
  answered boolean NOT NULL DEFAULT false,
  duration integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS twilio_call_legs_parent_idx ON twilio_call_legs (parent_call_sid);
CREATE TABLE IF NOT EXISTS twilio_sync_checkpoints (
  stream text PRIMARY KEY CHECK (stream IN ('calls', 'messages')),
  synced_through timestamptz NOT NULL
);
INSERT INTO twilio_sync_checkpoints (stream, synced_through)
VALUES ('calls', now() - interval '1 day'), ('messages', now() - interval '1 day')
ON CONFLICT DO NOTHING;
