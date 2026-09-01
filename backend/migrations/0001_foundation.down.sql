DROP FUNCTION IF EXISTS allied_set_updated_at();
DROP FUNCTION IF EXISTS allied_norm(text);
DROP FUNCTION IF EXISTS allied_date_key(date);
-- Extensions are intentionally left in place: other databases or objects in
-- this cluster may depend on them, and dropping them is not our call.
