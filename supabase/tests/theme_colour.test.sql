-- organisation_settings.theme_colour: defaults to purple, accepts the seven colours, rejects others.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('20000000-0000-0000-0000-0000000000d1', 'theme@example.test');

DO $$
DECLARE
  org uuid;
  ok boolean;
BEGIN
  PERFORM pg_temp.login('20000000-0000-0000-0000-0000000000d1');
  org := app.create_organisation('Theme Test Ltd', 'Main site', 'MAIN', NULL);
  PERFORM pg_temp.assert_eq((SELECT theme_colour FROM public.organisation_settings WHERE organisation_id = org), 'purple', 'default colour');

  UPDATE public.organisation_settings SET theme_colour = 'green' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((SELECT theme_colour FROM public.organisation_settings WHERE organisation_id = org), 'green', 'owner can change colour');

  ok := false;
  BEGIN
    UPDATE public.organisation_settings SET theme_colour = 'teal' WHERE organisation_id = org;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  PERFORM pg_temp.assert_eq(ok, true, 'unknown colour rejected');

  -- The change is in the audit trail.
  PERFORM pg_temp.assert_eq(
    (SELECT count(*) > 0 FROM public.audit_events
      WHERE organisation_id = org AND entity_type = 'organisation_settings' AND action = 'update'
        AND changed_fields @> ARRAY['theme_colour']),
    true, 'change audited');
END $$;

ROLLBACK;
