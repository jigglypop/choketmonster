ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS creator_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS joiner_items jsonb NOT NULL DEFAULT '[]'::jsonb;
