ALTER TABLE neural_states ADD COLUMN IF NOT EXISTS episode_id text NOT NULL DEFAULT 'interactive';
