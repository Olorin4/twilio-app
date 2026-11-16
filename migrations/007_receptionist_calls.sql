CREATE TABLE IF NOT EXISTS receptionist_calls (
  call_sid text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  provider_connection_id uuid,
  from_number text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  outcome text CHECK (outcome IN ('lead', 'not_a_lead', 'spam', 'abandoned', 'failed')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'called', 'dismissed')),
  caller_name text,
  company text,
  mc_number text,
  usdot text,
  mc_verified boolean NOT NULL DEFAULT false,
  callback_number text,
  callback_promise text,
  carrier jsonb,
  details jsonb,
  summary text,
  script jsonb,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  handled_at timestamptz
);
CREATE INDEX IF NOT EXISTS receptionist_calls_workspace_idx
  ON receptionist_calls (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS receptionist_calls_from_idx
  ON receptionist_calls (from_number, started_at);
