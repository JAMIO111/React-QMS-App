-- Gauge R&R, slice MS5 (docs/gauge-rr-plan.md §6): a workflow trigger for a completed study and a reminders area for studies about to expire. Information only.
--
--  * Workflow trigger "A Gauge R&R study is completed" (event msa.study.completed, already written by app.system_complete_msa_study). Facts a rule can test: the
--    verdict, the person's conclusion, the kind of study, %study variation of the gauge R&R (crossed), Cgk (Type 1), effectiveness (attribute), the characteristic
--    and part. Rules still only tell people, give tasks and hold lots (W6); nothing here changes a gauge.
--  * Reminders area msa_studies: the gauge's custodian is told when the latest completed study of a gauge and characteristic is within 30 days of expiring or has
--    expired. A study that a newer one has replaced is not asked about. The area can be switched off per person like the others.
-- app.workflow_triggers(), app.system_workflow_facts(), app.reminder_areas() and app.reminder_candidates() are shared, so they are changed by a checked text patch
-- from their live definitions (the migration refuses to finish unless the anchor is found exactly once): nothing a later migration changed is lost.
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- The trigger and its facts
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.workflow_triggers()'::regprocedure,
  '(''quality_alert.issued'',',
  '(''msa.study.completed'',                 ''msa_study'',                ''A Gauge R&R study is completed'',              ''calibration.read''),
    (''quality_alert.issued'',');

SELECT pg_temp.patch('app.system_workflow_facts(uuid, text, uuid, jsonb)'::regprocedure,
  'ELSIF p_entity_type = ''quality_alert'' THEN',
  'ELSIF p_entity_type = ''msa_study'' THEN
    SELECT jsonb_build_object(''label'', s.reference || '' · '' || s.characteristic_name || '' (gauge '' || g.asset_number || '')'', ''record_kind'', ''msa_study'', ''record_id'', s.id,
             ''site_id'', g.site_id, ''owner_user_id'', s.completed_by,
             ''verdict'', r.verdict, ''conclusion'', s.conclusion, ''study_type'', s.study_type,
             ''pct_grr'', (SELECT (vr ->> ''pctStudyVar'')::numeric FROM jsonb_array_elements(coalesce(r.result -> ''variation'', ''[]''::jsonb)) vr WHERE vr ->> ''name'' = ''grr''),
             ''cgk'', (r.result ->> ''cgk'')::numeric, ''effectiveness'', (r.result #>> ''{overall,effectiveness}'')::numeric,
             ''characteristic_key'', s.characteristic_key, ''part_id'', s.part_id)
      INTO v FROM public.msa_studies s
      JOIN public.msa_study_results r ON r.study_id = s.id
      JOIN public.gauges g ON g.id = s.gauge_id AND g.organisation_id = s.organisation_id
     WHERE s.id = p_entity_id AND s.organisation_id = p_organisation_id AND s.status = ''completed'';
  ELSIF p_entity_type = ''quality_alert'' THEN');

-- ---------------------------------------------------------------------------
-- The reminders area
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.reminder_areas()'::regprocedure,
  '(''competence'',',
  '(''msa_studies'',     13, ''Gauge R&R studies'',        ''Gauge R&R studies on gauges in your custody that are expiring'',   30),
    (''competence'',');

SELECT pg_temp.patch('app.reminder_candidates(uuid, date)'::regprocedure,
  '-- The person''s own competence: current assessments at level 1 or more of an active skill that expire.',
  '-- Gauge R&R studies that expire: the latest completed study of each gauge and characteristic, for the gauge''s custodian.
    SELECT g.custodian_id, ''msa_studies''::text, s.id, s.id, s.reference || '' · '' || left(s.characteristic_name, 100) || '' (Gauge R&R expires)'', s.valid_until, ''calibration.read''::text, g.site_id
      FROM (SELECT DISTINCT ON (x.gauge_id, x.study_type, coalesce(x.part_id::text, ''''), lower(coalesce(x.characteristic_key, x.characteristic_name))) x.*
              FROM public.msa_studies x
             WHERE x.organisation_id = p_organisation_id AND x.status = ''completed''
             ORDER BY x.gauge_id, x.study_type, coalesce(x.part_id::text, ''''), lower(coalesce(x.characteristic_key, x.characteristic_name)), x.completed_at DESC, x.reference DESC) s
      JOIN public.gauges g ON g.id = s.gauge_id AND g.organisation_id = s.organisation_id AND g.deleted_at IS NULL AND g.custodian_id IS NOT NULL
                          AND g.status IN (''active'', ''in_calibration'')
     WHERE s.valid_until IS NOT NULL
    UNION ALL
    -- The person''s own competence: current assessments at level 1 or more of an active skill that expire.');
