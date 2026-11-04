CREATE TABLE IF NOT EXISTS phone_contacts (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL CHECK (length(trim(name)) > 0),
  phone VARCHAR(16) NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  company VARCHAR(120) NOT NULL DEFAULT '',
  email VARCHAR(254) NOT NULL DEFAULT '',
  notes VARCHAR(2000) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
