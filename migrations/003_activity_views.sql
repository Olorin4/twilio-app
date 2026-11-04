CREATE TABLE IF NOT EXISTS activity_view_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  tracking_started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO activity_view_settings (id) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS activity_views (
  kind text NOT NULL CHECK (kind IN ('call', 'message')),
  item_id bigint NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, item_id)
);
