-- Mappings from before templates, loaded right before the templates migration so that its carry-over is exercised: a file connection with two
-- versions of a machine mapping and "add and update" settings, and a second connection with one version.
DO $$
DECLARE org uuid := (SELECT id FROM public.organisations ORDER BY created_at LIMIT 1); prov uuid := (SELECT id FROM public.integration_providers WHERE key = 'csv'); c1 uuid; c2 uuid;
BEGIN
  INSERT INTO public.integration_connections (organisation_id, provider_id, name, external_system, status) VALUES (org, prov, 'Fixture files', 'fixture-files', 'active') RETURNING id INTO c1;
  INSERT INTO public.integration_connections (organisation_id, provider_id, name, external_system, status) VALUES (org, prov, 'Fixture uploads', 'fixture-files-2', 'active') RETURNING id INTO c2;
  INSERT INTO public.integration_mappings (organisation_id, connection_id, entity_type, version, key_field, fields, reason, superseded_at)
    VALUES (org, c1, 'machine', 1, 'Id', '[{"target": "code", "source": "Code"}]', NULL, now());
  INSERT INTO public.integration_mappings (organisation_id, connection_id, entity_type, version, key_field, fields, reason)
    VALUES (org, c1, 'machine', 2, 'Id', '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name", "transform": "upper"}]', 'Names too');
  INSERT INTO public.integration_import_settings (organisation_id, connection_id, entity_type, write_mode, match_existing) VALUES (org, c1, 'machine', 'add_update', true);
  INSERT INTO public.integration_mappings (organisation_id, connection_id, entity_type, version, key_field, fields)
    VALUES (org, c2, 'machine', 1, 'Ref', '[{"target": "code", "source": "Ref"}]');
END $$;
