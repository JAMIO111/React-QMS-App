-- Audits, AU5: response types set in the template — the rules for defining each type, the frozen copy, how each type is answered and scored, evidence files (needed to complete, added and removed
-- only while in progress, never deleted, the storage rule) and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('38000000-0000-0000-0000-000000000901', 'owner@qt.test'), ('38000000-0000-0000-0000-000000000902', 'inspector@qt.test'), ('38000000-0000-0000-0000-000000000903', 'viewer@qt.test'),
  ('38000000-0000-0000-0000-000000000904', 'other@qt.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.qid(p_record uuid, p_seq int) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM public.audit_record_questions WHERE audit_record_id = p_record AND sequence = p_seq $$;
CREATE FUNCTION pg_temp.res(p_record uuid, p_seq int) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(s.result, 'none') FROM public.audit_responses s WHERE s.record_question_id = pg_temp.qid(p_record, p_seq) $$;
CREATE FUNCTION pg_temp.checklist(p_def uuid, p_json text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.fails(format('SELECT app.set_audit_checklist(%L, %L::jsonb)', p_def, p_json)) $$;

DO $$
DECLARE
  u_owner uuid := '38000000-0000-0000-0000-000000000901'; u_insp uuid := '38000000-0000-0000-0000-000000000902'; u_view uuid := '38000000-0000-0000-0000-000000000903'; u_other uuid := '38000000-0000-0000-0000-000000000904';
  org uuid; org2 uuid; m uuid; def uuid; rec uuid; rec2 uuid; att uuid; att2 uuid; r text; q record; n int;
  v_path text;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Types Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, pass_mark) VALUES (org, 'Types', 'process', 'on_demand', 50) RETURNING id INTO def;

  -- ---- defining each type ----
  PERFORM app.set_audit_checklist(def, '[
    {"question":"Procedure followed?","answerType":"yes_no","passAnswer":"yes","critical":true},
    {"question":"Process meets requirements?","answerType":"compliant"},
    {"question":"Product meets specification?","answerType":"pass_fail"},
    {"question":"Requirement applicable?","answerType":"yes_no_na","passAnswer":"yes"},
    {"question":"Measured temperature","answerType":"numeric","unit":"C"},
    {"question":"Describe the observation","answerType":"text"},
    {"question":"Select applicable condition","answerType":"multiple_choice","options":[{"label":" Clean ","passes":true},{"label":"Dusty","passes":true},{"label":"Oily","passes":false}]},
    {"question":"Actual diameter","answerType":"measurement","nominal":10,"lowerLimit":9.95,"upperLimit":10.05,"unit":"mm","critical":true},
    {"question":"Upload photograph","answerType":"evidence"},
    {"question":"Housekeeping score","answerType":"rating","passRating":3},
    {"question":"Overall impression","answerType":"rating","ratingMax":7}]'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT string_agg(answer_type, ',' ORDER BY sequence) FROM public.audit_questions WHERE audit_definition_id = def),
    'yes_no,compliant,pass_fail,yes_no_na,numeric,text,multiple_choice,measurement,evidence,rating,rating', 'every type is stored');
  PERFORM pg_temp.assert_eq((SELECT options::text FROM public.audit_questions WHERE audit_definition_id = def AND sequence = 7), '[{"label": "Clean", "passes": true}, {"label": "Dusty", "passes": true}, {"label": "Oily", "passes": false}]', 'options are trimmed and kept in order');
  PERFORM pg_temp.assert_eq((SELECT nominal || '/' || lower_limit || '/' || upper_limit || '/' || unit FROM public.audit_questions WHERE audit_definition_id = def AND sequence = 8), '10/9.95/10.05/mm', 'a measurement keeps its nominal, limits and unit');
  PERFORM pg_temp.assert_eq((SELECT rating_max || '/' || coalesce(pass_rating::text, 'none') FROM public.audit_questions WHERE audit_definition_id = def AND sequence = 10), '5/3', 'a rating defaults to a scale of 5, with its lowest acceptable rating');
  PERFORM pg_temp.assert_eq((SELECT rating_max || '/' || coalesce(pass_rating::text, 'none') FROM public.audit_questions WHERE audit_definition_id = def AND sequence = 11), '7/none', 'a scale can be wider and need no minimum');

  -- ---- what cannot be defined ----
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"number"}]') LIKE 'QM018: Question 1: choose how it is answered%', true, 'the old "number" is not a type');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"yes_no","passAnswer":"maybe"}]') LIKE 'QM018: Question 1: choose whether yes or no passes%', true, 'which answer passes is yes or no');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"numeric","lowerLimit":5,"upperLimit":1}]') LIKE 'QM018: Question 1: the lower limit is above the upper limit%', true, 'limits in order');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"measurement","nominal":10,"lowerLimit":9,"upperLimit":11}]') LIKE 'QM018: Question 1: a measurement needs a nominal value, its tolerance and a unit%', true, 'a measurement needs a unit');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"measurement","nominal":10,"upperLimit":11,"unit":"mm"}]') LIKE 'QM018: Question 1: a measurement needs a nominal value%', true, 'and both limits');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"measurement","nominal":12,"lowerLimit":9,"upperLimit":11,"unit":"mm"}]') LIKE 'QM018: Question 1: the nominal value must lie between%', true, 'the nominal lies between the limits');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"multiple_choice","options":[{"label":"Only"}]}]') LIKE 'QM018: Question 1: give between 2 and 20 options%', true, 'at least two options');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"multiple_choice"}]') LIKE 'QM018: Question 1: give between 2 and 20 options%', true, 'options are needed');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"multiple_choice","options":[{"label":"A"},{"label":" a "}]}]') LIKE 'QM018: Question 1: the option "a" is listed twice%', true, 'options are unique whatever their case');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"multiple_choice","options":[{"label":"A"},{"label":""}]}]') LIKE 'QM018: Question 1: every option needs its words%', true, 'every option has words');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"multiple_choice","options":[{"label":"A","passes":false},{"label":"B","passes":false}]}]') LIKE 'QM018: Question 1: at least one option must be acceptable%', true, 'one option must be acceptable');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"rating","ratingMax":2}]') LIKE 'QM018: Question 1: a rating scale runs from 1 to between 3 and 10%', true, 'a scale is 3 to 10');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"rating","ratingMax":11}]') LIKE 'QM018: Question 1: a rating scale runs from 1 to between 3 and 10%', true, 'and not wider');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"rating","passRating":6}]') LIKE 'QM018: Question 1: the lowest acceptable rating must be on the scale%', true, 'the lowest acceptable rating is on the scale');
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"rating","passRating":0}]') LIKE 'QM018: Question 1: the lowest acceptable rating must be on the scale%', true, 'at least 1');
  FOREACH r IN ARRAY ARRAY['{"question":"x","answerType":"text","critical":true}', '{"question":"x","answerType":"evidence","critical":true}', '{"question":"x","answerType":"numeric","critical":true}', '{"question":"x","answerType":"rating","critical":true}'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[' || r || ']') LIKE 'QM018: Question 1: it cannot be critical unless it can fail%', true, 'cannot be critical: ' || r);
  END LOOP;
  PERFORM pg_temp.assert_eq(pg_temp.checklist(def, '[{"question":"x","answerType":"numeric","lowerLimit":1,"critical":true},{"question":"y","answerType":"rating","passRating":2,"critical":true}]'), 'ok', 'a limit or a lowest acceptable rating makes them able to fail, so they can be critical');
  PERFORM app.set_audit_checklist(def, '[
    {"question":"Procedure followed?","answerType":"yes_no","passAnswer":"yes","critical":true},
    {"question":"Process meets requirements?","answerType":"compliant"},
    {"question":"Product meets specification?","answerType":"pass_fail"},
    {"question":"Requirement applicable?","answerType":"yes_no_na","passAnswer":"yes"},
    {"question":"Measured temperature","answerType":"numeric","unit":"C"},
    {"question":"Describe the observation","answerType":"text"},
    {"question":"Select applicable condition","answerType":"multiple_choice","options":[{"label":"Clean","passes":true},{"label":"Dusty","passes":true},{"label":"Oily","passes":false}]},
    {"question":"Actual diameter","answerType":"measurement","nominal":10,"lowerLimit":9.95,"upperLimit":10.05,"unit":"mm","critical":true},
    {"question":"Upload photograph","answerType":"evidence"},
    {"question":"Housekeeping score","answerType":"rating","passRating":3},
    {"question":"Overall impression","answerType":"rating","ratingMax":7}]'::jsonb);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_questions (organisation_id, audit_definition_id, sequence, question, answer_type, critical) VALUES (%L, %L, 20, 'x', 'text', true)$q$, org, def), 'direct writes are refused too');
  PERFORM pg_temp.logout();

  -- ---- the record keeps all of it, frozen ----
  PERFORM pg_temp.login(u_insp);
  rec := app.start_audit(def);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_record_questions WHERE audit_record_id = rec), 11::bigint, 'the whole checklist is copied');
  PERFORM pg_temp.assert_eq((SELECT jsonb_array_length(options) FROM public.audit_record_questions WHERE id = pg_temp.qid(rec, 7)), 3, 'with its options');
  PERFORM pg_temp.assert_eq((SELECT nominal::text || '/' || upper_limit::text FROM public.audit_record_questions WHERE id = pg_temp.qid(rec, 8)), '10/10.05', 'a measurement''s nominal and limits');
  PERFORM pg_temp.assert_eq((SELECT rating_max::text || '/' || coalesce(pass_rating::text, 'none') FROM public.audit_record_questions WHERE id = pg_temp.qid(rec, 10)), '5/3', 'a rating''s scale and minimum');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM app.set_audit_checklist(def, '[{"question":"Something else","answerType":"text"}]'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_record_questions WHERE audit_record_id = rec AND answer_type = 'rating'), 2::bigint, 'changing the audit leaves the record''s questions as they were');
  PERFORM pg_temp.logout();

  -- ---- answering each type ----
  PERFORM pg_temp.login(u_insp);
  -- yes / no: no N/A, the passing answer decides
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 1), 'yes');
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 1), 'pass', 'yes passes when yes is the passing answer');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'na')$q$, rec, pg_temp.qid(rec, 1))) LIKE 'QM018: Answer yes or no%', true, 'a plain yes / no has no N/A');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'compliant')$q$, rec, pg_temp.qid(rec, 1))) LIKE 'QM018: Answer yes or no%', true, 'and takes no other words');
  -- compliant / non-compliant
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 2), 'non_compliant');
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 2), 'fail', 'non-compliant fails');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 2), 'compliant');
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 2), 'pass', 'compliant passes');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'pass')$q$, rec, pg_temp.qid(rec, 2))) LIKE 'QM018: Answer compliant or non-compliant%', true, 'only its own words');
  -- pass / fail: no N/A any more
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'na')$q$, rec, pg_temp.qid(rec, 3))) LIKE 'QM018: Answer pass or fail%', true, 'pass / fail has no N/A');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 3), 'pass');
  -- yes / no / N/A
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 4), 'na');
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 4), 'na', 'yes / no / N/A can be not applicable');
  -- numeric without limits is recorded, not scored
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 5), NULL, 212.5);
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 5), 'none', 'a numeric question with no limit is not scored');
  PERFORM pg_temp.assert_eq((SELECT value_number::text FROM public.audit_responses WHERE record_question_id = pg_temp.qid(rec, 5)), '212.5', 'but the number is kept');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, NULL, NULL, 'x')$q$, rec, pg_temp.qid(rec, 5))) LIKE 'QM018: Enter a number%', true, 'a number is needed');
  -- text
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 6), NULL, NULL, 'Tidy');
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 6), 'none', 'a note is not scored');
  -- multiple choice
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 7), NULL, NULL, NULL, ' dusty ');
  PERFORM pg_temp.assert_eq((SELECT choice || '/' || result FROM public.audit_responses WHERE record_question_id = pg_temp.qid(rec, 7)), 'Dusty/pass', 'an acceptable option passes, whatever the case, and is stored as listed');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 7), NULL, NULL, NULL, 'Oily');
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 7), 'fail', 'an unacceptable option fails');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, NULL, NULL, NULL, 'Wet')$q$, rec, pg_temp.qid(rec, 7))) LIKE 'QM018: That is not one of the options%', true, 'only a listed option');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'pass')$q$, rec, pg_temp.qid(rec, 7))) LIKE 'QM018: Choose one of the options%', true, 'an option has to be chosen');
  -- measurement
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 8), NULL, 10.05);
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 8), 'pass', 'a measurement on the upper limit passes');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 8), NULL, 9.95);
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 8), 'pass', 'and on the lower limit');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 8), NULL, 10.051);
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 8), 'fail', 'just over fails');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 8), NULL, 9.949);
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 8), 'fail', 'and just under');
  -- rating: whole numbers on the scale; scored only with a lowest acceptable rating
  FOREACH n IN ARRAY ARRAY[0, 6] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, NULL, %s)$q$, rec, pg_temp.qid(rec, 10), n)) LIKE 'QM018: Choose a rating from 1 to 5%', true, 'off the scale: ' || n);
  END LOOP;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, NULL, 2.5)$q$, rec, pg_temp.qid(rec, 10))) LIKE 'QM018: Choose a rating from 1 to 5%', true, 'a whole number');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 10), NULL, 3);
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 10), 'pass', 'a rating at the lowest acceptable passes');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 10), NULL, 2);
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 10), 'fail', 'below it fails');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 10), NULL, 5);
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 11), NULL, 7);
  PERFORM pg_temp.assert_eq(pg_temp.res(rec, 11), 'none', 'a rating with no lowest acceptable rating is not scored');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, NULL, 8)$q$, rec, pg_temp.qid(rec, 11))) LIKE 'QM018: Choose a rating from 1 to 7%', true, 'a wider scale');
  -- evidence takes a note only
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'pass')$q$, rec, pg_temp.qid(rec, 9))) LIKE 'QM018: Write the note%', true, 'evidence is a file, not an answer');
  PERFORM pg_temp.logout();

  -- ---- evidence files ----
  PERFORM pg_temp.login(u_insp);
  v_path := org::text || '/audit/' || rec::text || '/' || gen_random_uuid()::text || '-photo.jpg';
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(rec), ' | ') LIKE '%add a photograph or document to question 9%', true, 'an evidence question without a file is still needed');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.add_audit_attachment(%L, %L, %L, 'photo.jpg', 'image/jpeg', 1000)$q$, rec, pg_temp.qid(rec, 3), v_path)) LIKE 'QM018: Files can only be added to a question that asks for evidence%', true, 'only an evidence question takes files');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.add_audit_attachment(%L, %L, %L, 'photo.jpg', 'image/jpeg', 1000)$q$, rec, pg_temp.qid(rec, 9), org::text || '/audit/' || gen_random_uuid()::text || '/x.jpg')) LIKE 'QM018: The file must be stored in this record%', true, 'only in the record''s own folder');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.add_audit_attachment(%L, %L, %L, 'photo.jpg', 'image/jpeg', 99999999)$q$, rec, pg_temp.qid(rec, 9), v_path)) LIKE '23514:%', true, 'at most 25 MB');
  att := app.add_audit_attachment(rec, pg_temp.qid(rec, 9), v_path, 'photo.jpg', 'image/jpeg', 1000);
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(rec), ' | ') LIKE '%photograph or document%', false, 'a file satisfies it');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_attachments (organisation_id, audit_record_id, record_question_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, %L, 'x', 1)$q$, org, rec, pg_temp.qid(rec, 9), v_path || '2'), 'files cannot be written directly');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_attachments SET file_name = 'other' WHERE id = %L$q$, att), 'nor changed');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.audit_attachments WHERE id = %L$q$, att), 'nor deleted');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.remove_audit_attachment(%L, ' ')$q$, att)) LIKE 'QM018: Say why the file is removed%', true, 'removing needs a reason');
  PERFORM app.remove_audit_attachment(att, 'Wrong photo');
  PERFORM pg_temp.assert_eq((SELECT deleted_at IS NOT NULL AND delete_reason = 'Wrong photo' AND deleted_by = u_insp FROM public.audit_attachments WHERE id = att), true, 'removed, with who and why');
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(rec), ' | ') LIKE '%add a photograph or document to question 9%', true, 'a removed file no longer counts');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.remove_audit_attachment(%L, 'again')$q$, att)) LIKE 'QM018: That file is already removed%', true, 'not twice');
  PERFORM app.restore_audit_attachment(att);
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(rec), ' | ') LIKE '%photograph or document%', false, 'restored, it counts again');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.restore_audit_attachment(%L)', att)) LIKE 'QM018: That file is not removed%', true, 'only a removed one');
  PERFORM pg_temp.logout();

  -- who may add files, and the storage rule
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.add_audit_attachment(%L, %L, %L, 'x.jpg', 'image/jpeg', 1)$q$, rec, pg_temp.qid(rec, 9), v_path || 'v')) LIKE '42501:%', true, 'a viewer cannot add files');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.remove_audit_attachment(%L, 'x')$q$, att)) LIKE '42501:%', true, 'or remove them');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_attachments WHERE audit_record_id = rec), 1::bigint, 'but sees them');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(v_path, false), true, 'a viewer may read the stored file');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(v_path, true), false, 'and not upload one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(v_path, true), true, 'someone who performs audits may upload into an in-progress record');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(org::text || '/audit/' || gen_random_uuid()::text || '/x.jpg', true), false, 'not into a folder that is no record');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(org::text || '/ncr/' || rec::text || '/x.jpg', true), false, 'nor another kind of folder');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(v_path, false), false, 'another organisation reads nothing');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_attachments), 0::bigint, 'and sees no files');
  PERFORM pg_temp.logout();

  -- ---- completing: what is scored and what is not ----
  PERFORM pg_temp.login(u_insp);
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 1), 'yes');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 8), NULL, 10);
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 7), NULL, NULL, 'Because it was oily', 'Oily');
  PERFORM app.record_audit_response(rec, pg_temp.qid(rec, 10), NULL, 2, 'Poor');
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(rec), '|'), '', 'nothing left once every failure has its note');
  PERFORM app.complete_audit(rec);
  -- scored: 1 yes pass, 2 compliant pass, 3 pass, 7 oily fail, 8 measurement pass, 10 rating fail → 4 pass, 2 fail; n/a (4) left out; unscored (5, 6, 9, 11) left out.
  PERFORM pg_temp.assert_eq((SELECT status || '/' || passed_count || '/' || failed_count || '/' || na_count || '/' || score || '/' || result FROM public.audit_records WHERE id = rec), 'completed/4/2/1/66.67/pass', 'unscored questions are left out of the score; 66.67 reaches the pass mark of 50');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.add_audit_attachment(%L, %L, %L, 'late.jpg', 'image/jpeg', 1)$q$, rec, pg_temp.qid(rec, 9), v_path || 'late')) LIKE 'QM018: % is completed%', true, 'no file can be added once completed');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.remove_audit_attachment(%L, 'late')$q$, att)) LIKE 'QM018: % is completed%', true, 'or removed');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(v_path || 'late', true), false, 'the storage rule closes with it');

  -- a critical measurement that fails fails the audit
  rec2 := app.start_audit(def);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM app.set_audit_checklist(def, '[{"question":"Diameter","answerType":"measurement","nominal":10,"lowerLimit":9.95,"upperLimit":10.05,"unit":"mm","critical":true},{"question":"Score","answerType":"rating","passRating":1}]'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  rec2 := app.start_audit(def);
  PERFORM app.record_audit_response(rec2, pg_temp.qid(rec2, 1), NULL, 10.5, 'Oversize');
  PERFORM app.record_audit_response(rec2, pg_temp.qid(rec2, 2), NULL, 5);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.complete_audit(%L)', rec2)) LIKE 'QM018: Before AR-%raise a finding for the failed critical question%', true, 'a failed critical measurement needs a finding before the audit is completed');
  PERFORM app.create_audit_finding(rec2, (SELECT id FROM public.audit_responses WHERE record_question_id = pg_temp.qid(rec2, 1)),
    (SELECT id FROM public.audit_finding_classifications WHERE organisation_id = org AND key = 'major_nc'), 'Diameter oversize', 'Measured 10.5 mm against 10 ± 0.05');
  PERFORM app.complete_audit(rec2);
  PERFORM pg_temp.assert_eq((SELECT result || '/' || score || '/' || critical_failed_count FROM public.audit_records WHERE id = rec2), 'fail/50.00/1', 'a failed critical measurement fails an audit whose score reaches the mark');
  PERFORM pg_temp.logout();

  SELECT count(*) INTO n FROM public.audit_events WHERE organisation_id = org AND entity_type = 'audit_attachments';
  PERFORM pg_temp.assert_eq(n > 0, true, 'files are audited');
END $$;

ROLLBACK;
