CREATE TABLE IF NOT EXISTS ranked_ratings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league text NOT NULL CHECK (league IN ('standard','open')),
  rating integer NOT NULL DEFAULT 1000 CHECK (rating >= 0),
  wins integer NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses integer NOT NULL DEFAULT 0 CHECK (losses >= 0),
  last_queued_at timestamptz,
  PRIMARY KEY (user_id, league)
);

CREATE TABLE IF NOT EXISTS ranked_queue (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  league text NOT NULL CHECK (league IN ('standard','open')),
  username text NOT NULL,
  team jsonb NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ranked_queue_matchmaking ON ranked_queue(league, joined_at);

CREATE TABLE IF NOT EXISTS ranked_matches (
  id uuid PRIMARY KEY,
  league text NOT NULL CHECK (league IN ('standard','open')),
  player1_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player2_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state jsonb NOT NULL,
  actions jsonb NOT NULL DEFAULT '{}'::jsonb,
  turn integer NOT NULL DEFAULT 1 CHECK (turn >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  winner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  result_reason text,
  rating_changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  deadline_at timestamptz NOT NULL DEFAULT now() + interval '90 seconds',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (player1_id <> player2_id)
);
CREATE INDEX IF NOT EXISTS ranked_matches_player1 ON ranked_matches(player1_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ranked_matches_player2 ON ranked_matches(player2_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ranked_matches_deadline ON ranked_matches(deadline_at) WHERE status='active';
