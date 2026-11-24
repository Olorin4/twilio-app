BEGIN;

CREATE TABLE IF NOT EXISTS agent_profiles (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL CHECK (kind IN ('receptionist', 'dispatcher', 'support')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  persona_name text NOT NULL CHECK (length(persona_name) BETWEEN 1 AND 120),
  company_name text NOT NULL CHECK (length(company_name) BETWEEN 1 AND 120),
  greeting text NOT NULL CHECK (length(greeting) <= 500),
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 20000),
  knowledge text NOT NULL DEFAULT '' CHECK (length(knowledge) <= 60000),
  voice text CHECK (length(voice) <= 64),
  alert_email text,
  daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 1 AND 1000),
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_profiles_one_default
  ON agent_profiles (workspace_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS agent_profile_revisions (
  id bigserial PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  fields jsonb NOT NULL,
  saved_by text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_profile_revisions_profile_idx
  ON agent_profile_revisions (profile_id, saved_at DESC);

ALTER TABLE connection_numbers
  ADD COLUMN IF NOT EXISTS handler text NOT NULL DEFAULT 'softphone',
  ADD COLUMN IF NOT EXISTS agent_profile_id uuid REFERENCES agent_profiles(id),
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS observe_hours boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'connection_numbers_handler_check') THEN
    ALTER TABLE connection_numbers ADD CONSTRAINT connection_numbers_handler_check
      CHECK (handler IN ('softphone', 'ai_agent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'connection_numbers_agent_check') THEN
    ALTER TABLE connection_numbers ADD CONSTRAINT connection_numbers_agent_check
      CHECK (handler <> 'ai_agent' OR agent_profile_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'connection_numbers_label_check') THEN
    ALTER TABLE connection_numbers ADD CONSTRAINT connection_numbers_label_check
      CHECK (label IS NULL OR length(label) BETWEEN 1 AND 60);
  END IF;
END $$;

ALTER TABLE receptionist_calls
  ADD COLUMN IF NOT EXISTS agent_profile_id uuid
    REFERENCES agent_profiles(id) ON DELETE SET NULL;
ALTER TABLE receptionist_calls
  DROP CONSTRAINT IF EXISTS receptionist_calls_outcome_check;
ALTER TABLE receptionist_calls
  ADD CONSTRAINT receptionist_calls_outcome_check
  CHECK (outcome IN ('lead', 'not_a_lead', 'spam', 'abandoned', 'failed',
    'message', 'urgent', 'support_request', 'not_support'));

COMMIT;
