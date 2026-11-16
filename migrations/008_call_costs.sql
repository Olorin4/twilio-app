-- What each call cost. Twilio's own charge is stored per call leg; for calls
-- the AI receptionist answered, the Claude usage and the ConversationRelay
-- minutes are stored with the call. Additive and safe to rerun.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS price numeric(12, 5);
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS price_unit text;
ALTER TABLE receptionist_calls ADD COLUMN IF NOT EXISTS usage jsonb;
ALTER TABLE receptionist_calls ADD COLUMN IF NOT EXISTS claude_cost numeric(12, 5);
ALTER TABLE receptionist_calls ADD COLUMN IF NOT EXISTS relay_cost numeric(12, 5);
