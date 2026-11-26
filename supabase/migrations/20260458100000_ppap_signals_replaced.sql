-- PPAP, a fix to PP6b (docs/ppap-plan.md PP13, PP14): an approval that a revalidation has already replaced is not reminded about any more.
-- Starting a revalidation (or a resubmission) does not move the old approval's review date, so the reminders area ppap_reviews and the workflow event
-- ppap.review_due kept naming the old submission after the owner had started the new one. The dashboard and the home page already leave a replaced approval out
-- (a submission is replaced when another, not withdrawn, names it in replaces_id); the reminder and the event now use the same rule.
-- Information only: nothing here changes a submission. app.system_emit_ppap_due_events() and app.reminder_candidates() are changed by a checked text patch from their
-- live definitions (the migration refuses to finish unless the anchor is found exactly once, and does nothing when its marker is already there), so running it again
-- is safe and nothing a later migration changed is lost.
CREATE OR REPLACE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_marker text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- The worker's event: an approval that has a live replacement is not due for revalidation.
SELECT pg_temp.patch('app.system_emit_ppap_due_events(integer)'::regprocedure,
  $a$WHERE s.organisation_id = o.id AND s.status = 'approved' AND s.next_review_on <= v_today AND s.next_review_on >= v_today - 3$a$,
  $b$WHERE s.organisation_id = o.id AND s.status = 'approved' AND s.next_review_on <= v_today AND s.next_review_on >= v_today - 3
         AND NOT EXISTS (SELECT 1 FROM public.ppap_submissions r WHERE r.replaces_id = s.id AND r.organisation_id = s.organisation_id AND r.status <> 'withdrawn')$b$,
  $m$r.replaces_id = s.id$m$);

-- The reminders area: the same rule.
SELECT pg_temp.patch('app.reminder_candidates(uuid, date)'::regprocedure,
  $a$WHERE s.organisation_id = p_organisation_id AND s.status = 'approved' AND s.next_review_on IS NOT NULL$a$,
  $b$WHERE s.organisation_id = p_organisation_id AND s.status = 'approved' AND s.next_review_on IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.ppap_submissions r WHERE r.replaces_id = s.id AND r.organisation_id = s.organisation_id AND r.status <> 'withdrawn')$b$,
  $m$r.replaces_id = s.id$m$);
