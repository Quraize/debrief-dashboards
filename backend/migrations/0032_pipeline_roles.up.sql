-- The Sold-Job Pipeline is management's view: admin, sales manager, project
-- manager. The production role keeps the schedule board and the jobs board
-- (jp_job, jp_schedule stay readable to it) but not the pipeline's notes,
-- suggestions or the AI instructions. The API refuses that role at the route;
-- this closes the same door at the table, so no other path can open it.

CREATE OR REPLACE FUNCTION allied_is_pipeline_manager() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT allied_current_role() IN ('admin','sales_manager','project_manager')
$$;

DROP POLICY IF EXISTS job_pipeline_note_select ON job_pipeline_note;
DROP POLICY IF EXISTS job_pipeline_note_insert ON job_pipeline_note;
DROP POLICY IF EXISTS job_pipeline_note_update ON job_pipeline_note;
DROP POLICY IF EXISTS job_pipeline_note_delete ON job_pipeline_note;
CREATE POLICY job_pipeline_note_select ON job_pipeline_note FOR SELECT USING (allied_is_pipeline_manager());
CREATE POLICY job_pipeline_note_insert ON job_pipeline_note FOR INSERT WITH CHECK (allied_is_pipeline_manager());
CREATE POLICY job_pipeline_note_update ON job_pipeline_note FOR UPDATE
  USING (allied_is_pipeline_manager()) WITH CHECK (allied_is_pipeline_manager());
CREATE POLICY job_pipeline_note_delete ON job_pipeline_note FOR DELETE USING (allied_is_pipeline_manager());

DROP POLICY IF EXISTS job_next_action_suggestion_select ON job_next_action_suggestion;
DROP POLICY IF EXISTS job_next_action_suggestion_update ON job_next_action_suggestion;
CREATE POLICY job_next_action_suggestion_select ON job_next_action_suggestion FOR SELECT USING (allied_is_pipeline_manager());
CREATE POLICY job_next_action_suggestion_update ON job_next_action_suggestion FOR UPDATE
  USING (allied_is_pipeline_manager()) WITH CHECK (allied_is_pipeline_manager());

DROP POLICY IF EXISTS ai_instruction_select ON ai_instruction;
DROP POLICY IF EXISTS ai_instruction_insert ON ai_instruction;
DROP POLICY IF EXISTS ai_instruction_update ON ai_instruction;
CREATE POLICY ai_instruction_select ON ai_instruction FOR SELECT USING (allied_is_pipeline_manager());
CREATE POLICY ai_instruction_insert ON ai_instruction FOR INSERT WITH CHECK (allied_is_pipeline_manager());
CREATE POLICY ai_instruction_update ON ai_instruction FOR UPDATE
  USING (allied_is_pipeline_manager()) WITH CHECK (allied_is_pipeline_manager());
