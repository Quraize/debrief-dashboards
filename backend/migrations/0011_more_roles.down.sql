-- Accounts holding a role being removed fall back to 'user' so the original
-- constraint can be restored; reversibility is preferred over refusing.
UPDATE app_user SET role = 'user'
 WHERE role IN ('project_manager','production','inside_sales_rep');

CREATE OR REPLACE FUNCTION allied_is_authenticated() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT allied_current_role() IN
    ('admin','sales_manager','appointment_setter','outside_sales_rep','view_only','user')
$$;

ALTER TABLE app_user DROP CONSTRAINT app_user_role_valid;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_valid CHECK (role IN
  ('admin','sales_manager','appointment_setter','outside_sales_rep','view_only','user'));
