DELETE FROM sync_run WHERE kind = 'next_actions';
ALTER TABLE sync_run DROP CONSTRAINT sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules','customers','job_stages','sheet_push','unite_calls'));
DROP TABLE IF EXISTS ai_instruction;
DROP TABLE IF EXISTS job_next_action_suggestion;
