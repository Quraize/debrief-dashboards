-- JobProgress divisions and their trades, mirrored for the debrief form.
--
-- The form's "Division" dropdown was a Base44-era product list (Roofing,
-- Siding, Gutters…) — trades, not divisions. JobProgress's divisions are
-- "ACR Roofing Division", "ACR Service/Repair Division", … each with its own
-- trade list. The sync already reads /divisions on every run; from here it
-- keeps them, so the form offers exactly what the CRM does.

CREATE TABLE jp_division (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_division_id text NOT NULL,
  name           text NOT NULL,
  trades         text[] NOT NULL DEFAULT '{}',
  work_types     text[] NOT NULL DEFAULT '{}',
  position       integer,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_division_id_uniq UNIQUE (jp_division_id)
);
CREATE TRIGGER jp_division_updated_at BEFORE UPDATE ON jp_division
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

GRANT SELECT ON jp_division TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_division TO allied_jobs;
ALTER TABLE jp_division ENABLE ROW LEVEL SECURITY;
-- Every signed-in role files debriefs, so every role reads the list.
CREATE POLICY jp_division_select ON jp_division FOR SELECT
  USING (allied_is_authenticated() OR allied_is_production());
