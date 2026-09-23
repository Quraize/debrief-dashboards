DROP POLICY IF EXISTS ai_instruction_select ON ai_instruction;
DROP POLICY IF EXISTS ai_instruction_insert ON ai_instruction;
DROP POLICY IF EXISTS ai_instruction_update ON ai_instruction;
CREATE POLICY ai_instruction_select ON ai_instruction FOR SELECT USING (allied_is_production());
CREATE POLICY ai_instruction_insert ON ai_instruction FOR INSERT WITH CHECK (allied_is_production());
CREATE POLICY ai_instruction_update ON ai_instruction FOR UPDATE
  USING (allied_is_production()) WITH CHECK (allied_is_production());

DROP POLICY IF EXISTS job_next_action_suggestion_select ON job_next_action_suggestion;
DROP POLICY IF EXISTS job_next_action_suggestion_update ON job_next_action_suggestion;
CREATE POLICY job_next_action_suggestion_select ON job_next_action_suggestion FOR SELECT USING (allied_is_production());
CREATE POLICY job_next_action_suggestion_update ON job_next_action_suggestion FOR UPDATE
  USING (allied_is_production()) WITH CHECK (allied_is_production());

DROP POLICY IF EXISTS job_pipeline_note_select ON job_pipeline_note;
DROP POLICY IF EXISTS job_pipeline_note_insert ON job_pipeline_note;
DROP POLICY IF EXISTS job_pipeline_note_update ON job_pipeline_note;
DROP POLICY IF EXISTS job_pipeline_note_delete ON job_pipeline_note;
CREATE POLICY job_pipeline_note_select ON job_pipeline_note FOR SELECT USING (allied_is_production());
CREATE POLICY job_pipeline_note_insert ON job_pipeline_note FOR INSERT WITH CHECK (allied_is_production());
CREATE POLICY job_pipeline_note_update ON job_pipeline_note FOR UPDATE
  USING (allied_is_production()) WITH CHECK (allied_is_production());
CREATE POLICY job_pipeline_note_delete ON job_pipeline_note FOR DELETE USING (allied_is_production());

DROP FUNCTION IF EXISTS allied_is_pipeline_manager();
