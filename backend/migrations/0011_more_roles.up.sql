-- Three more account roles: project_manager, production, inside_sales_rep.
--
-- Roles are enumerated in two places the database enforces: the CHECK on
-- app_user.role, and allied_is_authenticated() — the RLS helper every read
-- policy depends on. A role missing from the latter is not merely unknown, it
-- is denied every table. Both move together here, mirroring
-- shared/src/constants.js ROLE_LABELS.
--
-- The new roles carry rep-level access (read all, write own): none of them is
-- a manager, so allied_is_manager() is unchanged.

ALTER TABLE app_user DROP CONSTRAINT app_user_role_valid;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_valid CHECK (role IN
  ('admin','sales_manager','project_manager','production','appointment_setter',
   'inside_sales_rep','outside_sales_rep','view_only','user'));

CREATE OR REPLACE FUNCTION allied_is_authenticated() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT allied_current_role() IN
    ('admin','sales_manager','project_manager','production','appointment_setter',
     'inside_sales_rep','outside_sales_rep','view_only','user')
$$;
