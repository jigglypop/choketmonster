CREATE TABLE IF NOT EXISTS save_requests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot text NOT NULL,
  request_id text NOT NULL,
  payload_hash text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot, request_id)
);
CREATE INDEX IF NOT EXISTS save_requests_age ON save_requests(created_at);
