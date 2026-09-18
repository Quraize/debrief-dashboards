-- Customer phone numbers, one row per number, keyed for matching.
--
-- The phone system will report calls by number; the lead they belong to is
-- found by the ten-digit key (shared/src/phone.js). JobProgress's customer
-- payload carries a `phones` array (label + number) the sync never stored.
-- Kept in its own table because a customer has several numbers and a lookup
-- by number has to be an index hit, not a scan of a JSON column.
CREATE TABLE jp_customer_phone (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_customer_id  text NOT NULL,
  -- Ten national digits; the only thing ever compared.
  phone_key       text NOT NULL,
  -- As JobProgress has it: label (cell, home, office…) and the typed number.
  label           text,
  raw_number      text,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_customer_phone_uniq UNIQUE (jp_customer_id, phone_key),
  CONSTRAINT jp_customer_phone_key_shape CHECK (phone_key ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$')
);
CREATE INDEX jp_customer_phone_key_idx ON jp_customer_phone (phone_key);
CREATE INDEX jp_customer_phone_customer_idx ON jp_customer_phone (jp_customer_id);

-- Read like jp_customer (staff and production); written only by the sync.
GRANT SELECT ON jp_customer_phone TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_customer_phone TO allied_jobs;
ALTER TABLE jp_customer_phone ENABLE ROW LEVEL SECURITY;
CREATE POLICY jp_customer_phone_select ON jp_customer_phone FOR SELECT
  USING (allied_is_authenticated() OR allied_is_production());
