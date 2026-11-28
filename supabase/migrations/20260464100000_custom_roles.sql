-- Custom roles (docs/custom-roles-plan.md, RL1).
--
-- An owner (roles.manage) can make their own roles by choosing permissions. Row-level security already let them write non-system roles and add
-- permissions they hold themselves (app.my_grantable_permissions); this adds what was missing:
--   * one atomic save (app.save_custom_role) and one delete (app.delete_custom_role), with messages written for people;
--   * rules held by triggers so they hold for every path, not only the API: roles.manage stays out of custom roles, a role someone holds cannot be
--     deleted (the foreign key would have silently taken the assignment with it), at most 30 custom roles, names unique ignoring case.
-- Error code QM041 -> 409 role_rule.

-- A name is unique within an organisation ignoring case (the six built-in names are already distinct).
CREATE UNIQUE INDEX roles_org_name_key ON public.roles (organisation_id, lower(name)) WHERE organisation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Rules on roles
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.role_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_holders integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Deleting an organisation cascades to its roles (nested trigger depth); a direct delete of a role someone holds is refused.
    IF pg_trigger_depth() = 1 THEN
      SELECT count(DISTINCT membership_id) INTO v_holders FROM public.user_role_assignments WHERE role_id = OLD.id;
      IF v_holders > 0 THEN
        RAISE EXCEPTION '% this role. Take it off them first.', CASE WHEN v_holders = 1 THEN '1 person holds' ELSE v_holders || ' people hold' END
          USING ERRCODE = 'QM041';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.organisation_id IS NOT NULL AND NOT NEW.is_system THEN
    IF length(btrim(NEW.name)) = 0 THEN RAISE EXCEPTION 'Give the role a name' USING ERRCODE = 'QM041'; END IF;
    IF length(NEW.name) > 60 THEN RAISE EXCEPTION 'The role name is up to 60 characters' USING ERRCODE = 'QM041'; END IF;
    IF NEW.description IS NOT NULL AND length(NEW.description) > 200 THEN RAISE EXCEPTION 'The description is up to 200 characters' USING ERRCODE = 'QM041'; END IF;
    IF TG_OP = 'INSERT' AND (SELECT count(*) FROM public.roles WHERE organisation_id = NEW.organisation_id AND NOT is_system) >= 30 THEN
      RAISE EXCEPTION 'An organisation can have up to 30 custom roles' USING ERRCODE = 'QM041';
    END IF;
    IF EXISTS (SELECT 1 FROM public.roles r WHERE r.organisation_id = NEW.organisation_id AND lower(r.name) = lower(NEW.name) AND r.id <> NEW.id) THEN
      RAISE EXCEPTION 'A role called "%" already exists', btrim(NEW.name) USING ERRCODE = 'QM041';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.role_rules() FROM PUBLIC, anon;
CREATE TRIGGER roles_rules BEFORE INSERT OR UPDATE OR DELETE ON public.roles FOR EACH ROW EXECUTE FUNCTION app.role_rules();

-- Role administration stays with the Owner role: a custom role cannot carry roles.manage.
CREATE FUNCTION app.role_permission_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.permission_code = 'roles.manage'
     AND EXISTS (SELECT 1 FROM public.roles r WHERE r.id = NEW.role_id AND r.organisation_id IS NOT NULL AND NOT r.is_system) THEN
    RAISE EXCEPTION 'Managing roles stays with the Owner role, so a custom role cannot include it' USING ERRCODE = 'QM041';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.role_permission_rules() FROM PUBLIC, anon;
CREATE TRIGGER role_permissions_rules BEFORE INSERT ON public.role_permissions FOR EACH ROW EXECUTE FUNCTION app.role_permission_rules();

-- ---------------------------------------------------------------------------
-- Save and delete
-- ---------------------------------------------------------------------------
-- A key that is unique in the organisation and never equals a built-in key: custom_<name in lower case>.
CREATE FUNCTION app.custom_role_key(p_organisation_id uuid, p_name text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_base text; v_key text; v_n integer := 1;
BEGIN
  v_base := 'custom_' || left(coalesce(nullif(btrim(regexp_replace(lower(p_name), '[^a-z0-9]+', '_', 'g'), '_'), ''), 'role'), 40);
  v_key := v_base;
  WHILE EXISTS (SELECT 1 FROM public.roles WHERE organisation_id = p_organisation_id AND key = v_key) LOOP
    v_n := v_n + 1;
    v_key := v_base || '_' || v_n;
  END LOOP;
  RETURN v_key;
END $$;
REVOKE ALL ON FUNCTION app.custom_role_key(uuid, text) FROM PUBLIC, anon;

-- Makes (p_role null) or changes a custom role and replaces its permissions as a whole. The saver may only give permissions they could grant
-- themselves; built-in roles never change. Updating the role row moves its version (edit conflicts) and is audited with the permission rows.
CREATE FUNCTION app.save_custom_role(p_organisation_id uuid, p_role uuid, p_name text, p_description text, p_permissions text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_perms text[];
  v_bad text;
  v_role public.roles%ROWTYPE;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'roles.manage') THEN RAISE EXCEPTION 'You are not allowed to manage roles' USING ERRCODE = '42501'; END IF;

  SELECT coalesce(array_agg(DISTINCT btrim(x) ORDER BY btrim(x)), '{}') INTO v_perms FROM unnest(coalesce(p_permissions, '{}')) x WHERE btrim(x) <> '';
  IF cardinality(v_perms) = 0 THEN RAISE EXCEPTION 'Choose at least one permission for the role' USING ERRCODE = 'QM041'; END IF;
  SELECT p INTO v_bad FROM unnest(v_perms) p WHERE NOT EXISTS (SELECT 1 FROM public.permissions WHERE code = p) LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'There is no permission called "%"', v_bad USING ERRCODE = 'QM041'; END IF;
  IF 'roles.manage' = ANY (v_perms) THEN RAISE EXCEPTION 'Managing roles stays with the Owner role, so a custom role cannot include it' USING ERRCODE = 'QM041'; END IF;
  SELECT p INTO v_bad FROM unnest(v_perms) p WHERE p NOT IN (SELECT app.my_grantable_permissions(p_organisation_id)) ORDER BY p LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'You cannot give a permission you do not hold yourself (%)', (SELECT description FROM public.permissions WHERE code = v_bad) USING ERRCODE = 'QM041';
  END IF;

  IF p_role IS NULL THEN
    INSERT INTO public.roles (organisation_id, key, name, description, is_system)
    VALUES (p_organisation_id, app.custom_role_key(p_organisation_id, v_name), v_name, v_description, false) RETURNING * INTO v_role;
  ELSE
    SELECT * INTO v_role FROM public.roles WHERE id = p_role AND organisation_id = p_organisation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
    IF v_role.is_system THEN RAISE EXCEPTION 'The built-in roles cannot be changed. Make a copy and change that.' USING ERRCODE = 'QM041'; END IF;
    -- The row is always written, so its version moves even when only the permissions changed.
    UPDATE public.roles SET name = v_name, description = v_description WHERE id = p_role RETURNING * INTO v_role;
    DELETE FROM public.role_permissions WHERE role_id = p_role AND permission_code <> ALL (v_perms);
  END IF;

  INSERT INTO public.role_permissions (role_id, permission_code)
  SELECT v_role.id, p FROM unnest(v_perms) p
  ON CONFLICT DO NOTHING;
  RETURN v_role.id;
END $$;

-- Deletes a custom role nobody holds (the trigger holds the same rule for any other path).
CREATE FUNCTION app.delete_custom_role(p_role uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role public.roles%ROWTYPE;
BEGIN
  SELECT * INTO v_role FROM public.roles WHERE id = p_role FOR UPDATE;
  IF NOT FOUND OR v_role.organisation_id IS NULL OR NOT app.is_member(v_role.organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(v_role.organisation_id, 'roles.manage') THEN RAISE EXCEPTION 'You are not allowed to manage roles' USING ERRCODE = '42501'; END IF;
  IF v_role.is_system THEN RAISE EXCEPTION 'The built-in roles cannot be deleted' USING ERRCODE = 'QM041'; END IF;
  DELETE FROM public.roles WHERE id = p_role;
END $$;

REVOKE ALL ON FUNCTION app.save_custom_role(uuid, uuid, text, text, text[]), app.delete_custom_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.save_custom_role(uuid, uuid, text, text, text[]), app.delete_custom_role(uuid) TO authenticated;
