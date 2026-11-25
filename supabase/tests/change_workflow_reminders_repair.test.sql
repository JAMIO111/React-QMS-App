-- CH5a repair: the Gauge R&R migration patches shared functions by text, so running it twice leaves its trigger, reminders area and two branches in twice
-- (this happened live). The CH5a migration collapses the copies and is safe to run again; this test makes the damage and runs it.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.times(p_fn regprocedure, p_text text) RETURNS integer LANGUAGE sql AS $$
  SELECT ((length(d) - length(replace(d, p_text, ''))) / length(p_text))::integer FROM (SELECT pg_get_functiondef(p_fn) AS d) x
$$;

DO $$
BEGIN
  PERFORM pg_temp.assert_eq(pg_temp.times('app.workflow_triggers()'::regprocedure, '''msa.study.completed'''), 1, 'to start with, once');
  PERFORM pg_temp.assert_eq(pg_temp.times('app.reminder_candidates(uuid, date)'::regprocedure, '-- Gauge R&R studies that expire:'), 1, 'once in the candidates too');
END $$;

-- The damage: the Gauge R&R migration run a second time.
\ir ../migrations/20260429100000_gauge_rr_workflow_reminders.sql
DROP FUNCTION pg_temp.patch(regprocedure, text, text);

DO $$
BEGIN
  PERFORM pg_temp.assert_eq(pg_temp.times('app.workflow_triggers()'::regprocedure, '''msa.study.completed'''), 2, 'the damage is done: the trigger twice');
  PERFORM pg_temp.assert_eq(pg_temp.times('app.reminder_areas()'::regprocedure, '''msa_studies'','), 2, 'the area twice');
  PERFORM pg_temp.assert_eq(pg_temp.times('app.system_workflow_facts(uuid, text, uuid, jsonb)'::regprocedure, 'p_entity_type = ''msa_study'''), 2, 'the facts branch twice');
  PERFORM pg_temp.assert_eq(pg_temp.times('app.reminder_candidates(uuid, date)'::regprocedure, '-- Gauge R&R studies that expire:'), 2, 'the candidates twice');
END $$;

-- The repair (and the whole migration, a second time).
\ir ../migrations/20260434100000_change_workflow_reminders.sql

DO $$
BEGIN
  PERFORM pg_temp.assert_eq(pg_temp.times('app.workflow_triggers()'::regprocedure, '''msa.study.completed'''), 1, 'repaired: the trigger once');
  PERFORM pg_temp.assert_eq(pg_temp.times('app.reminder_areas()'::regprocedure, '''msa_studies'','), 1, 'the area once');
  PERFORM pg_temp.assert_eq(pg_temp.times('app.system_workflow_facts(uuid, text, uuid, jsonb)'::regprocedure, 'p_entity_type = ''msa_study'''), 1, 'the facts branch once');
  PERFORM pg_temp.assert_eq(pg_temp.times('app.reminder_candidates(uuid, date)'::regprocedure, '-- Gauge R&R studies that expire:'), 1, 'the candidates once');
  -- and nothing of the change slice was added twice by running it again
  PERFORM pg_temp.assert_eq(pg_temp.times('app.workflow_triggers()'::regprocedure, '''change.submitted'''), 1, 'change.submitted once');
  PERFORM pg_temp.assert_eq(pg_temp.times('app.system_workflow_facts(uuid, text, uuid, jsonb)'::regprocedure, 'p_entity_type = ''change_request'''), 1, 'the change facts once');
  PERFORM pg_temp.assert_eq(pg_temp.times('app.reminder_candidates(uuid, date)'::regprocedure, '''change_signoffs'''), 1, 'the sign-off reminders once');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers() WHERE event_type LIKE 'change.%'), 3::bigint, 'three change triggers');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers()), (SELECT count(DISTINCT event_type) FROM app.workflow_triggers()), 'no trigger listed twice');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_areas()), (SELECT count(DISTINCT key) FROM app.reminder_areas()), 'no area listed twice');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM pg_trigger WHERE tgname = 'change_requests_workflow_event'), 1::bigint, 'one trigger on change_requests');
END $$;

ROLLBACK;
