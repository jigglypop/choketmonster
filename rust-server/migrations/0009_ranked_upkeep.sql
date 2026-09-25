-- Status polls refresh last_seen; queue rows unseen for 30 seconds count as gone.
ALTER TABLE ranked_queue ADD COLUMN IF NOT EXISTS last_seen timestamptz NOT NULL DEFAULT now();

-- Leaderboard order within a league.
CREATE INDEX IF NOT EXISTS ranked_ratings_leaderboard ON ranked_ratings(league, rating DESC, wins DESC, losses);

-- Pruning completed matches older than 30 days.
CREATE INDEX IF NOT EXISTS ranked_matches_completed ON ranked_matches(completed_at) WHERE status='completed';
