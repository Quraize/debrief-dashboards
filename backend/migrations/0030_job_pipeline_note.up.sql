-- Sold-Job Pipeline: the three columns JobProgress does not have.
--
-- Blocker, Owner and Next Action are production's own notes against a sold
-- job that has not yet been built. One row per job, overwritten in place,
-- stamped with who wrote it and when, so the Monday meeting knows whose
-- word it is reading. The blocker is DERIVED from the stage until someone
-- types their own (shared/src/soldPipeline.js); a blank blocker here means
-- "use the derived one".

CREATE TABLE job_pipeline_note (
  jp_job_id    text PRIMARY KEY,
  blocker      text,
  owner        text,
  next_action  text,
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Written by the production side under their own identity (RLS), never by the sync.
GRANT SELECT, INSERT, UPDATE, DELETE ON job_pipeline_note TO allied_app;
GRANT SELECT ON job_pipeline_note TO allied_jobs;
ALTER TABLE job_pipeline_note ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_pipeline_note_select ON job_pipeline_note FOR SELECT USING (allied_is_production());
CREATE POLICY job_pipeline_note_insert ON job_pipeline_note FOR INSERT WITH CHECK (allied_is_production());
CREATE POLICY job_pipeline_note_update ON job_pipeline_note FOR UPDATE
  USING (allied_is_production()) WITH CHECK (allied_is_production());
CREATE POLICY job_pipeline_note_delete ON job_pipeline_note FOR DELETE USING (allied_is_production());
