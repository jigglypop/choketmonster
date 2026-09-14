ALTER TABLE saves ADD COLUMN IF NOT EXISTS trade_epoch bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS trades (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joiner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','completed','cancelled','expired')),
  version bigint NOT NULL DEFAULT 0,
  creator_revision bigint,
  joiner_revision bigint,
  creator_monster_id text,
  joiner_monster_id text,
  creator_monster jsonb,
  joiner_monster jsonb,
  creator_money bigint NOT NULL DEFAULT 0 CHECK (creator_money >= 0),
  joiner_money bigint NOT NULL DEFAULT 0 CHECK (joiner_money >= 0),
  creator_neural jsonb,
  joiner_neural jsonb,
  creator_confirmed boolean NOT NULL DEFAULT false,
  joiner_confirmed boolean NOT NULL DEFAULT false,
  creator_result_revision bigint,
  joiner_result_revision bigint,
  creator_received_monster_id text,
  joiner_received_monster_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS trades_creator_recent ON trades(creator_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS trades_joiner_recent ON trades(joiner_id, updated_at DESC) WHERE joiner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trades_expiry ON trades(expires_at) WHERE status IN ('waiting','active');
