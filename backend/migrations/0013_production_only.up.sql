-- The `production` role becomes production-ONLY.
--
-- Production staff get the schedule board (allied_is_production(), 0012) and
-- nothing else: every sales-side read policy is built on
-- allied_is_authenticated(), so removing the role here closes every one of
-- those tables at the database, independently of what the API or the UI
-- decide. project_manager keeps both worlds. Mirrors shared STAFF_ROLES.

CREATE OR REPLACE FUNCTION allied_is_authenticated() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT allied_current_role() IN
    ('admin','sales_manager','project_manager','appointment_setter',
     'inside_sales_rep','outside_sales_rep','view_only','user')
$$;
