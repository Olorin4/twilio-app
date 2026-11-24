BEGIN;
-- Fail fast instead of queueing behind live traffic; rerun if it times out.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx
  ON workspace_members (user_id);

CREATE TABLE IF NOT EXISTS number_assignees (
  number_id uuid NOT NULL REFERENCES connection_numbers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, user_id)
);
CREATE INDEX IF NOT EXISTS number_assignees_user_idx
  ON number_assignees (user_id);

ALTER TABLE connection_numbers
  ADD COLUMN IF NOT EXISTS personal boolean NOT NULL DEFAULT false;

COMMIT;
