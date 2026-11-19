CREATE TABLE IF NOT EXISTS workspace_assistant_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  jack_enabled boolean NOT NULL DEFAULT true,
  live_assist_enabled boolean NOT NULL DEFAULT true
);
