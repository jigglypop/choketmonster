CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS saves (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot text NOT NULL,
  revision bigint NOT NULL,
  request_id text NOT NULL,
  payload bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot)
);
CREATE TABLE IF NOT EXISTS neural_states (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creature_id text NOT NULL,
  graph_id text NOT NULL,
  state bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, creature_id)
);
CREATE TABLE IF NOT EXISTS neural_requests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creature_id text NOT NULL,
  request_id text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, creature_id, request_id)
);
CREATE INDEX IF NOT EXISTS neural_requests_age ON neural_requests(created_at);
