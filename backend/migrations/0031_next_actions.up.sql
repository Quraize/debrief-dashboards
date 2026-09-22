-- Next Action suggestions for the Sold-Job Pipeline.
--
-- One suggestion per job, produced by the nightly run (or "Suggest now"):
-- either the stage rule alone or the model's one sentence, phrased inside the
-- managers' standing instructions. `facts_hash` is what the job looked like
-- when the suggestion was made; the run skips a job whose facts have not
-- changed, so the model is only asked again when something moved.
--
-- A suggestion is never the note. Accepting copies it into
-- job_pipeline_note.next_action and stamps who accepted it here.

CREATE TABLE job_next_action_suggestion (
  jp_job_id      text PRIMARY KEY,
  facts_hash     text NOT NULL,
  rule_key       text,
  suggestion     text,
  confidence     text CHECK (confidence IS NULL OR confidence IN ('high','medium','low')),
  -- 'rule' when the stage rule was enough, the model id when the model answered,
  -- 'rule-fallback' when the model failed or refused and the rule stood in.
  model          text NOT NULL,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  accepted_at    timestamptz,
  accepted_by    text
);

-- Written by the run (jobs role, bypasses RLS); read by production, who may
-- also mark one accepted.
GRANT SELECT, UPDATE ON job_next_action_suggestion TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON job_next_action_suggestion TO allied_jobs;
ALTER TABLE job_next_action_suggestion ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_next_action_suggestion_select ON job_next_action_suggestion FOR SELECT USING (allied_is_production());
CREATE POLICY job_next_action_suggestion_update ON job_next_action_suggestion FOR UPDATE
  USING (allied_is_production()) WITH CHECK (allied_is_production());

-- The managers' standing instructions the model follows, one row per use.
-- Editable on the pipeline page by managers; the run reads it as the service.
CREATE TABLE ai_instruction (
  key         text PRIMARY KEY,
  body        text NOT NULL,
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON ai_instruction TO allied_app;
GRANT SELECT ON ai_instruction TO allied_jobs;
ALTER TABLE ai_instruction ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_instruction_select ON ai_instruction FOR SELECT USING (allied_is_production());
CREATE POLICY ai_instruction_insert ON ai_instruction FOR INSERT WITH CHECK (allied_is_production());
CREATE POLICY ai_instruction_update ON ai_instruction FOR UPDATE
  USING (allied_is_production()) WITH CHECK (allied_is_production());

-- The run is logged like every other background job.
ALTER TABLE sync_run DROP CONSTRAINT sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules','customers','job_stages','sheet_push','unite_calls','next_actions'));
