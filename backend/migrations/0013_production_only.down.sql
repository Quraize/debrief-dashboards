CREATE OR REPLACE FUNCTION allied_is_authenticated() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT allied_current_role() IN
    ('admin','sales_manager','project_manager','production','appointment_setter',
     'inside_sales_rep','outside_sales_rep','view_only','user')
$$;
