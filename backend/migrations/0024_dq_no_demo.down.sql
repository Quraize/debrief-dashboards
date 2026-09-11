DELETE FROM list_option WHERE category = 'appointment_outcome' AND value = 'No Demo — DQ / Do Not Reset' AND created_by = 'migration:0024';
ALTER TABLE debrief DROP COLUMN IF EXISTS dq_reason;
