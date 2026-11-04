CREATE TABLE IF NOT EXISTS message_delivery (
  message_sid text PRIMARY KEY,
  status text NOT NULL,
  status_rank integer NOT NULL,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
