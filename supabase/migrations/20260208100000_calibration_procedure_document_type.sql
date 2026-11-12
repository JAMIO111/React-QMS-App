-- A built-in document type for calibration procedures.
--
-- A gauge type's calibration procedure is a controlled document (20260207100000). Until now any document could be chosen. Organisations
-- need the procedures kept together, so:
--
--  * document_types.system_key marks a type the application itself relies on (first and only key: 'calibration_procedure'). A built-in
--    type is never deleted (no type is) and cannot be switched off; its key never changes. Its name, prefix (until a document uses it),
--    description and review interval stay the organisation's to change.
--  * every organisation gets the type "Calibration procedure" (prefix CALP, or CALP-2 … when that prefix is taken); an active type already
--    called "Calibration procedure" is adopted instead of making a second one. New organisations get it with the other seeded types.
--  * a gauge type's procedure must be a document of that type. The rule is checked when the procedure is set or changed, so a link made
--    before this migration is left as it is until someone changes it.

ALTER TABLE public.document_types
  ADD COLUMN system_key text CHECK (system_key IS NULL OR system_key IN ('calibration_procedure'));
CREATE UNIQUE INDEX document_types_system_key ON public.document_types (organisation_id, system_key) WHERE system_key IS NOT NULL;
COMMENT ON COLUMN public.document_types.system_key IS 'Set on a built-in type the application relies on (calibration_procedure: gauge types choose their procedure from it); such a type cannot be switched off';

-- ---------------------------------------------------------------------------
-- Rules (replaces the 20260202100000 trigger function; it now also runs on insert)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.document_type_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_seeding boolean := coalesce(current_setting('app.document_type_system', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A document type is never deleted. Switch it off instead.' USING ERRCODE = 'QM025'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.system_key IS NOT NULL AND NOT v_seeding THEN RAISE EXCEPTION 'A built-in document type is made by the application, not by hand' USING ERRCODE = 'QM025'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.prefix <> OLD.prefix AND EXISTS (SELECT 1 FROM public.documents d WHERE d.type_id = OLD.id) THEN
    RAISE EXCEPTION 'The prefix % is used by documents and cannot change', OLD.prefix USING ERRCODE = 'QM025';
  END IF;
  IF NEW.system_key IS DISTINCT FROM OLD.system_key AND NOT v_seeding THEN
    RAISE EXCEPTION 'Whether a document type is built in cannot be changed' USING ERRCODE = 'QM025';
  END IF;
  IF NEW.system_key IS NOT NULL AND NOT NEW.active THEN
    RAISE EXCEPTION '% is a built-in document type and cannot be switched off', OLD.name USING ERRCODE = 'QM025';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER document_types_rules ON public.document_types;
CREATE TRIGGER document_types_rules BEFORE INSERT OR UPDATE OR DELETE ON public.document_types FOR EACH ROW EXECUTE FUNCTION app.document_type_rules();

-- ---------------------------------------------------------------------------
-- Seeding
-- ---------------------------------------------------------------------------
-- Gives the organisation its calibration procedure type, once: an active type already called "Calibration procedure" is adopted, otherwise a
-- new one is made with the first free prefix of CALP, CALP-2, CALP-3 …
CREATE FUNCTION app.seed_calibration_procedure_type(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_prefix text := 'CALP'; n integer := 1;
BEGIN
  IF EXISTS (SELECT 1 FROM public.document_types WHERE organisation_id = p_organisation_id AND system_key = 'calibration_procedure') THEN RETURN; END IF;
  PERFORM set_config('app.document_type_system', 'on', true);
  SELECT id INTO v_id FROM public.document_types
   WHERE organisation_id = p_organisation_id AND active AND lower(btrim(name)) = 'calibration procedure';
  IF v_id IS NOT NULL THEN
    UPDATE public.document_types SET system_key = 'calibration_procedure' WHERE id = v_id;
  ELSE
    WHILE EXISTS (SELECT 1 FROM public.document_types WHERE organisation_id = p_organisation_id AND prefix = v_prefix) LOOP
      n := n + 1;
      v_prefix := 'CALP-' || n;
    END LOOP;
    INSERT INTO public.document_types (organisation_id, name, prefix, description, review_months, content_hint, sequence, system_key)
    VALUES (p_organisation_id, 'Calibration procedure', v_prefix,
      'How gauges of a type are calibrated. A gauge type''s procedure is chosen from documents of this type.', 24, 'text',
      (SELECT coalesce(max(sequence), 0) + 1 FROM public.document_types WHERE organisation_id = p_organisation_id), 'calibration_procedure');
  END IF;
  PERFORM set_config('app.document_type_system', '', true);
END $$;

-- New organisations: the six general types as before, then the calibration procedure type.
CREATE OR REPLACE FUNCTION app.seed_document_types(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.document_types (organisation_id, name, prefix, review_months, content_hint, sequence) VALUES
    (p_organisation_id, 'Procedure',        'SOP',  24, 'text', 1),
    (p_organisation_id, 'Work instruction', 'WI',   24, 'text', 2),
    (p_organisation_id, 'Form',             'FRM',  36, 'file', 3),
    (p_organisation_id, 'Specification',    'SPEC', 36, 'file', 4),
    (p_organisation_id, 'Policy',           'POL',  12, 'text', 5),
    (p_organisation_id, 'External',         'EXT',  12, 'file', 6)
  ON CONFLICT (organisation_id, prefix) DO NOTHING;
  PERFORM app.seed_calibration_procedure_type(p_organisation_id);
END $$;

-- Existing organisations.
SELECT app.seed_calibration_procedure_type(o.id) FROM public.organisations o;

-- ---------------------------------------------------------------------------
-- A gauge type's procedure is a calibration procedure
-- ---------------------------------------------------------------------------
-- Checked when the procedure is set or changed. A document that does not exist in the organisation is left to the foreign key.
CREATE FUNCTION app.gauge_type_procedure_rule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_key text; v_found boolean;
BEGIN
  IF NEW.procedure_document_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.procedure_document_id IS NOT DISTINCT FROM OLD.procedure_document_id THEN RETURN NEW; END IF;
  SELECT t.system_key, true INTO v_key, v_found
    FROM public.documents d JOIN public.document_types t ON t.id = d.type_id
   WHERE d.id = NEW.procedure_document_id AND d.organisation_id = NEW.organisation_id;
  IF v_found IS NOT TRUE THEN RETURN NEW; END IF;
  IF v_key IS DISTINCT FROM 'calibration_procedure' THEN
    RAISE EXCEPTION 'The procedure must be a document of the type %',
      coalesce((SELECT name FROM public.document_types WHERE organisation_id = NEW.organisation_id AND system_key = 'calibration_procedure'), 'Calibration procedure')
      USING ERRCODE = 'QM006';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gauge_types_procedure_rule BEFORE INSERT OR UPDATE OF procedure_document_id ON public.gauge_types
  FOR EACH ROW EXECUTE FUNCTION app.gauge_type_procedure_rule();

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.seed_calibration_procedure_type(uuid), app.gauge_type_procedure_rule() FROM PUBLIC, anon, authenticated;
