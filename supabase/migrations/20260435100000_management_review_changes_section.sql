-- Change management, slice CH5b (docs/change-management-plan.md §8f): a "Changes" input section for the management review.
--
-- ISO 9001 9.3.2 asks the review to consider "changes that could affect the quality management system" (9.3.2 b) and 6.3 planned changes. The review gets its own
-- section for them, between "Effectiveness of actions on risks and opportunities" and "Opportunities for improvement", so the twelve fixed sections become thirteen.
--  * app.management_review_sections() lists it (position 12; "Opportunities for improvement" moves to 13).
--  * A review that is only planned gets the new section (it gathers every data section when it starts); one being held, completed or cancelled is left exactly as it was.
-- The figures are gathered by the API from the changes dashboard, as the person (needs change.read), like every other section.
CREATE OR REPLACE FUNCTION app.management_review_sections() RETURNS TABLE (key text, ord integer, title text, commentary_only boolean)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT * FROM (VALUES
    ('previous_actions',     1, 'Actions from previous reviews', false),
    ('context',              2, 'Changes in external and internal issues', true),
    ('customer_feedback',    3, 'Customer satisfaction and feedback', false),
    ('quality_objectives',   4, 'Quality objectives', false),
    ('process_performance',  5, 'Process performance and product conformity', false),
    ('nonconformities',      6, 'Nonconformities and corrective actions', false),
    ('monitoring',           7, 'Monitoring and measurement results', false),
    ('audit_results',        8, 'Audit results', false),
    ('external_providers',   9, 'Performance of external providers', false),
    ('resources',           10, 'Adequacy of resources', false),
    ('risks',               11, 'Effectiveness of actions on risks and opportunities', false),
    ('changes',             12, 'Changes to the quality management system', false),
    ('improvement',         13, 'Opportunities for improvement', true)
  ) s(key, ord, title, commentary_only)
$$;

-- Reviews not yet started: make room for the new section and add it (idempotent: nothing happens a second time).
UPDATE public.management_review_inputs i SET position = 13
 WHERE i.section = 'improvement' AND i.position = 12
   AND EXISTS (SELECT 1 FROM public.management_reviews m WHERE m.id = i.review_id AND m.status = 'planned');

INSERT INTO public.management_review_inputs (organisation_id, review_id, section, position)
SELECT m.organisation_id, m.id, 'changes', 12
  FROM public.management_reviews m
 WHERE m.status = 'planned'
   AND NOT EXISTS (SELECT 1 FROM public.management_review_inputs i WHERE i.review_id = m.id AND i.section = 'changes');
