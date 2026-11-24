-- Soft delete: an archived workspace keeps its history and connections but is
-- hidden from lists and stops resolving, routing and syncing.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;
