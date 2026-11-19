CREATE TABLE IF NOT EXISTS phone_call_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  provider_connection_id uuid REFERENCES provider_connections(id),
  account_sid text NOT NULL,
  from_number text NOT NULL,
  destination text NOT NULL,
  lead_sid text,
  call_sid text UNIQUE,
  transcription_sid text UNIQUE,
  assist boolean NOT NULL DEFAULT false,
  capture_state text NOT NULL DEFAULT 'waiting',
  created_at timestamptz NOT NULL DEFAULT now(),
  capture_started_at timestamptz,
  capture_ended_at timestamptz,
  ended_at timestamptz,
  partial boolean NOT NULL DEFAULT false,
  stop_requested boolean NOT NULL DEFAULT false,
  stop_confirmed boolean NOT NULL DEFAULT false,
  next_suggestion_at timestamptz,
  last_suggestion_at timestamptz,
  suggestion jsonb,
  suggestion_count integer NOT NULL DEFAULT 0,
  suggestion_failed boolean NOT NULL DEFAULT false,
  summary_state text NOT NULL DEFAULT 'none',
  summary jsonb,
  summary_attempts integer NOT NULL DEFAULT 0,
  summary_at timestamptz,
  notes text NOT NULL DEFAULT '',
  outcome text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  capture_lease_until timestamptz,
  stop_lease_until timestamptz,
  model_lease_until timestamptz,
  model_lease_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_call_sessions_workspace_idx
  ON phone_call_sessions (workspace_id, call_sid);
CREATE INDEX IF NOT EXISTS phone_call_sessions_assist_idx
  ON phone_call_sessions (created_at) WHERE assist;

CREATE TABLE IF NOT EXISTS phone_call_utterances (
  session_id uuid NOT NULL REFERENCES phone_call_sessions(id) ON DELETE CASCADE,
  sequence_id integer NOT NULL,
  speaker text NOT NULL CHECK (speaker IN ('Caller', 'Dispatcher')),
  content text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sequence_id)
);
