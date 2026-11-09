CREATE TABLE IF NOT EXISTS call_announcements (
  call_sid text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  provider_connection_id uuid,
  kind text NOT NULL CHECK (kind IN ('missed', 'closed')),
  initiated_at timestamptz,
  completed_at timestamptz
);
