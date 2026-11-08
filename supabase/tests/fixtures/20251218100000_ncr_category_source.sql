-- An audit that existed before versions, with one record that matches what the audit says now and one that was done against an earlier wording, loaded right before the
-- audit versions migration so that its backfill is exercised: version 1 is made from the current content, and only the matching record is linked to it.
INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, procedure, pass_mark)
  SELECT id, 'Fixture audit', 'process', 'on_demand', 'Walk the cell.', 90 FROM public.organisations ORDER BY created_at LIMIT 1;
INSERT INTO public.audit_questions (organisation_id, audit_definition_id, sequence, question, answer_type, critical)
  SELECT organisation_id, id, s.n, s.q, 'pass_fail', s.n = 1
    FROM public.audit_definitions, (VALUES (1, 'Is the cell clean?'), (2, 'Are the gauges in date?')) AS s(n, q) WHERE title = 'Fixture audit';
INSERT INTO public.audit_records (organisation_id, reference, audit_definition_id, audit_reference, audit_title, audit_type, procedure, pass_mark)
  SELECT organisation_id, 'FIX-AR-SAME', id, reference, title, audit_type, procedure, pass_mark FROM public.audit_definitions WHERE title = 'Fixture audit';
INSERT INTO public.audit_records (organisation_id, reference, audit_definition_id, audit_reference, audit_title, audit_type, procedure, pass_mark)
  SELECT organisation_id, 'FIX-AR-OLD', id, reference, 'Fixture audit (old title)', audit_type, procedure, pass_mark FROM public.audit_definitions WHERE title = 'Fixture audit';
INSERT INTO public.audit_records (organisation_id, reference, audit_definition_id, audit_reference, audit_title, audit_type, procedure, pass_mark)
  SELECT organisation_id, 'FIX-AR-WORDS', id, reference, title, audit_type, procedure, pass_mark FROM public.audit_definitions WHERE title = 'Fixture audit';
INSERT INTO public.audit_record_questions (organisation_id, audit_record_id, sequence, question, answer_type, critical)
  SELECT r.organisation_id, r.id, s.n, s.q, 'pass_fail', s.n = 1
    FROM public.audit_records r, (VALUES (1, 'Is the cell clean?'), (2, 'Are the gauges in date?')) AS s(n, q) WHERE r.reference IN ('FIX-AR-SAME', 'FIX-AR-OLD');
-- Same header, different wording of a question.
INSERT INTO public.audit_record_questions (organisation_id, audit_record_id, sequence, question, answer_type, critical)
  SELECT r.organisation_id, r.id, s.n, s.q, 'pass_fail', s.n = 1
    FROM public.audit_records r, (VALUES (1, 'Is the cell tidy?'), (2, 'Are the gauges in date?')) AS s(n, q) WHERE r.reference = 'FIX-AR-WORDS';
