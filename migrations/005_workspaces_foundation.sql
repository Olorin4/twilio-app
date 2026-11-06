-- Additive foundation only. This migration does not by itself enable workspace
-- routing or make the existing single-user app multi-tenant.
BEGIN;
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspaces (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'Iron Wing')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS provider_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  provider text NOT NULL CHECK (provider = 'twilio'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  account_sid text NOT NULL CHECK (account_sid ~ '^AC[0-9A-Fa-f]{32}$'),
  twiml_app_sid text NOT NULL CHECK (twiml_app_sid ~ '^AP[0-9A-Fa-f]{32}$'),
  encrypted_credentials jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, account_sid),
  UNIQUE (account_sid, twiml_app_sid)
);
CREATE TABLE IF NOT EXISTS connection_numbers (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  provider_number_sid text NOT NULL,
  phone_number text NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{1,14}$'),
  voice_enabled boolean NOT NULL DEFAULT false,
  sms_enabled boolean NOT NULL DEFAULT false,
  UNIQUE (connection_id, provider_number_sid),
  UNIQUE (connection_id, phone_number),
  UNIQUE (phone_number)
);
CREATE TABLE IF NOT EXISTS workspace_active_numbers (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  connection_number_id uuid NOT NULL REFERENCES connection_numbers(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS connection_sync_checkpoints (
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  stream text NOT NULL CHECK (stream IN ('calls', 'messages')),
  synced_through timestamptz NOT NULL,
  PRIMARY KEY (connection_id, stream)
);

-- Defaults preserve existing writers in the shared Iron Wing backend. Future
-- workspace-aware writes must set workspace_id explicitly.
ALTER TABLE phone_contacts ADD COLUMN IF NOT EXISTS workspace_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES workspaces(id);
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS workspace_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES workspaces(id);
ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS workspace_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES workspaces(id);
-- Existing rows remain unassigned to a connection until the current Twilio
-- credentials and historical numbers have been imported and reconciled.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS provider_connection_id uuid REFERENCES provider_connections(id);
ALTER TABLE message_logs ADD COLUMN IF NOT EXISTS provider_connection_id uuid REFERENCES provider_connections(id);
ALTER TABLE message_delivery ADD COLUMN IF NOT EXISTS workspace_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES workspaces(id);
ALTER TABLE message_delivery ADD COLUMN IF NOT EXISTS provider_connection_id uuid REFERENCES provider_connections(id);
ALTER TABLE twilio_call_legs ADD COLUMN IF NOT EXISTS workspace_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES workspaces(id);
ALTER TABLE twilio_call_legs ADD COLUMN IF NOT EXISTS provider_connection_id uuid REFERENCES provider_connections(id);
CREATE INDEX IF NOT EXISTS phone_contacts_workspace_idx ON phone_contacts (workspace_id);
CREATE INDEX IF NOT EXISTS call_logs_workspace_idx ON call_logs (workspace_id);
CREATE INDEX IF NOT EXISTS message_logs_workspace_idx ON message_logs (workspace_id);
COMMIT;
