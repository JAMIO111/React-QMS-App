-- Phase 1 exit check, database layer: organisation B's Owner (holding every permission in B) can
-- neither read nor change anything of organisation A — in any table, view or function.
-- Tables and views are discovered from the catalogue; the setup must seed organisation A in every
-- tenant table, so a new table without test data fails here until it is added.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('50000000-0000-0000-0000-0000000000a1', 'owner.a@sweep.test'),
  ('50000000-0000-0000-0000-0000000000b1', 'owner.b@sweep.test');

CREATE TEMP TABLE sweep (key text PRIMARY KEY, value text);
GRANT SELECT ON sweep TO authenticated;

-- ---------------------------------------------------------------------------
-- Organisation A with data everywhere; organisation B owned by B
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  a uuid; b uuid; site uuid; owner_role uuid; invite uuid; fm bigint; status bigint; proc bigint;
  part uuid := gen_random_uuid(); cust uuid := gen_random_uuid(); supp uuid := gen_random_uuid();
  emp uuid := gen_random_uuid(); d8 uuid := gen_random_uuid(); ncr uuid := gen_random_uuid(); notif uuid := gen_random_uuid();
  inspection uuid; qa uuid; qm uuid; sweep_q record;
BEGIN
  PERFORM pg_temp.login('50000000-0000-0000-0000-0000000000a1');
  a := app.create_organisation('Sweep Alpha');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('50000000-0000-0000-0000-0000000000b1');
  b := app.create_organisation('Sweep Beta');
  PERFORM pg_temp.logout();

  SELECT id INTO site FROM public.sites WHERE organisation_id = a;
  SELECT id INTO owner_role FROM public.roles WHERE organisation_id = a AND key = 'owner';

  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (a, site, 'QA', 'Quality');
  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (a, 'pending@sweep.test', 'invited', now()) RETURNING id INTO invite;
  INSERT INTO public.department_members (organisation_id, department_id, membership_id)
    SELECT a, d.id, invite FROM public.departments d WHERE d.organisation_id = a AND d.code = 'QA';
  INSERT INTO public."Employees" (id, organisation_id, first_name, surname) VALUES (emp, a, 'Sam', 'Sweeper');
  INSERT INTO storage.objects (bucket_id, name) VALUES ('nc-files', a || '/ncr/SW-001/x.pdf');
  -- Phase 2 master data (releasing the revision also writes an outbox event).
  INSERT INTO public.customers (organisation_id, code, name) VALUES (a, 'SWC', 'Sweep customer');
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (a, 'SWS', 'Sweep supplier');
  INSERT INTO public.parts (id, organisation_id, part_number, name) VALUES (gen_random_uuid(), a, 'SW-P1', 'Sweep part');
  INSERT INTO public.part_revisions (organisation_id, part_id, revision)
    SELECT a, id, 'A' FROM public.parts WHERE organisation_id = a AND part_number = 'SW-P1';
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = a;
  -- Phase 2 NCR core.
  INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (a, 'failure_mode', 'Sweep failure');
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, severity, quantity_affected)
    VALUES (a, 'SW-NCR-1', 'internal', 'Sweep NCR', 'minor', 1);
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount)
    SELECT a, id, 'scrap', 'GBP', 10 FROM public.nonconformances WHERE organisation_id = a AND reference = 'SW-NCR-1';
  INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes)
    SELECT a, id, a || '/ncr/' || id || '/sweep.txt', 'sweep.txt', 5 FROM public.nonconformances WHERE organisation_id = a AND reference = 'SW-NCR-1';
  INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description)
    SELECT a, id, 'quarantine', 'Sweep containment' FROM public.nonconformances WHERE organisation_id = a AND reference = 'SW-NCR-1';
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions)
    SELECT a, id, 'scrap', 1, 'Sweep disposition' FROM public.nonconformances WHERE organisation_id = a AND reference = 'SW-NCR-1';
  -- Calibration.
  INSERT INTO public.gauge_types (organisation_id, name) VALUES (a, 'Sweep caliper');
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal, tolerance_minus, tolerance_plus, unit_code)
    SELECT a, id, '25 mm block', 25, 0.02, 0.02, 'mm' FROM public.gauge_types WHERE organisation_id = a;
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id)
    SELECT a, 'SW-G1', 'Sweep caliper', id FROM public.gauge_types WHERE organisation_id = a;
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, outcome)
    SELECT a, id, 'SW-CAL-1', 'pass' FROM public.gauges WHERE organisation_id = a;
  INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, as_found)
    SELECT a, c.id, k.id, k.name, k.nominal, k.tolerance_minus, k.tolerance_plus, k.unit_code, 25.01
    FROM public.calibrations c JOIN public.gauge_characteristics k ON k.gauge_id = c.gauge_id WHERE c.organisation_id = a;
  INSERT INTO public.calibration_attachments (organisation_id, calibration_id, storage_path, file_name, size_bytes)
    SELECT a, id, a || '/calibration/' || id || '/cert.pdf', 'cert.pdf', 5 FROM public.calibrations WHERE organisation_id = a;
  -- Process control (PC1).
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (a, 'SW-M1', 'Sweep lathe', site);
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (a, 'SWF', 'Sweep family');
  UPDATE public.parts SET part_family_id = (SELECT id FROM public.part_families WHERE organisation_id = a) WHERE organisation_id = a AND part_number = 'SW-P1';
  INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, lower_limit, upper_limit, unit_code)
    SELECT a, id, 'LENGTH', 100, 99.9, 100.1, 'mm' FROM public.part_revisions WHERE organisation_id = a;
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, customer_part_number)
    SELECT a, p.id, c.id, 'CUST-PN-1' FROM public.parts p, public.customers c WHERE p.organisation_id = a AND p.part_number = 'SW-P1' AND c.organisation_id = a AND c.code = 'SWC';
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (a, 'SW-CP-1', 'Sweep plan');
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id)
    SELECT a, p.id, f.id FROM public.control_plans p, public.part_families f WHERE p.organisation_id = a AND f.organisation_id = a;
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code)
    SELECT a, id, 'A' FROM public.control_plans WHERE organisation_id = a;
  -- Process control (PC2): plan content.
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name)
    SELECT a, id, 'OP-10', 'Sweep turning' FROM public.control_plan_revisions WHERE organisation_id = a;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name,
                                                   value_source, applies_to, unit_code, spec_key)
    SELECT a, o.control_plan_revision_id, o.id, 'LENGTH', 'Length', 'part_spec', 'selected', 'mm', 'LENGTH'
    FROM public.control_plan_operations o WHERE o.organisation_id = a;
  INSERT INTO public.characteristic_applicability (organisation_id, control_plan_revision_id, plan_characteristic_id, part_id)
    SELECT a, c.control_plan_revision_id, c.id, p.id FROM public.control_plan_characteristics c, public.parts p
    WHERE c.organisation_id = a AND p.organisation_id = a AND p.part_number = 'SW-P1';
  INSERT INTO public.characteristic_templates (organisation_id, name, characteristic_key, upper_limit, unit_code) VALUES (a, 'Sweep template', 'OD', 5, 'mm');
  INSERT INTO public.sampling_rules (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, sample_size)
    SELECT a, control_plan_revision_id, id, 'first_off', 1 FROM public.control_plan_characteristics WHERE organisation_id = a;
  INSERT INTO public.reaction_plans (organisation_id, control_plan_revision_id, trigger_type, action, instruction)
    SELECT a, id, 'out_of_spec', 'hold', 'Quarantine the batch' FROM public.control_plan_revisions WHERE organisation_id = a;

  -- Manufacturing traceability (TR1): an order with an operation, a lot and a serial number.
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, site_id, quantity_planned)
    SELECT a, 'SW-WO-1', id, site, 10 FROM public.parts WHERE organisation_id = a AND part_number = 'SW-P1';
  INSERT INTO public.production_operations (organisation_id, production_order_id, sequence, operation_code)
    SELECT a, id, 10, 'OP-10' FROM public.production_orders WHERE organisation_id = a;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, production_order_id)
    SELECT a, 'SW-LOT-1', part_id, 'produced', id FROM public.production_orders WHERE organisation_id = a;
  INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id, lot_id)
    SELECT a, 'SW-SN-1', part_id, id FROM public.lots WHERE organisation_id = a;
  -- Affected lots (TR4): an NC of the lot's part naming the lot.
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, severity, quantity_affected, part_id)
    SELECT a, 'SW-NCR-LOT', 'internal', 'Sweep lot NCR', 'minor', 1, part_id FROM public.lots WHERE organisation_id = a;
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity)
    SELECT a, n.id, l.id, 1 FROM public.nonconformances n JOIN public.lots l ON l.organisation_id = a WHERE n.organisation_id = a AND n.reference = 'SW-NCR-LOT';

  -- Audits (AU1): a definition with one question and one machine it is relevant to.
  INSERT INTO public.audit_definitions (organisation_id, audit_number, reference, title, audit_type, frequency_kind, first_due_on)
    VALUES (a, 0, 'pending', 'Sweep audit', 'process', 'monthly', current_date);
  INSERT INTO public.audit_questions (organisation_id, audit_definition_id, sequence, question, answer_type)
    SELECT a, id, 1, 'Is the area clean?', 'pass_fail' FROM public.audit_definitions WHERE organisation_id = a;
  INSERT INTO public.audit_targets (organisation_id, audit_definition_id, kind, machine_id)
    SELECT a, d.id, 'machine', m.id FROM public.audit_definitions d JOIN public.machines m ON m.organisation_id = a WHERE d.organisation_id = a LIMIT 1;
  INSERT INTO public.audit_occurrences (organisation_id, audit_definition_id, due_on) SELECT a, id, current_date FROM public.audit_definitions WHERE organisation_id = a;
  -- Audit versions (AV1): the audit's first version, with its question and machine copied.
  PERFORM app.snapshot_audit_version(id, 1, 'First version') FROM public.audit_definitions WHERE organisation_id = a;
  -- Audit records (AU3): a record with its frozen question, target, answer and a link to the lot NC.
  INSERT INTO public.audit_records (organisation_id, reference, audit_definition_id, audit_reference, audit_title, audit_type, pass_mark)
    SELECT a, 'SW-AR-1', id, reference, title, audit_type, pass_mark FROM public.audit_definitions WHERE organisation_id = a;
  INSERT INTO public.audit_record_questions (organisation_id, audit_record_id, sequence, question, answer_type)
    SELECT a, id, 1, 'Is the area clean?', 'pass_fail' FROM public.audit_records WHERE organisation_id = a;
  INSERT INTO public.audit_record_targets (organisation_id, audit_record_id, kind, machine_id, label)
    SELECT a, r.id, 'machine', m.id, m.code FROM public.audit_records r JOIN public.machines m ON m.organisation_id = a WHERE r.organisation_id = a LIMIT 1;
  INSERT INTO public.audit_responses (organisation_id, audit_record_id, record_question_id, answer, result)
    SELECT a, audit_record_id, id, 'fail', 'fail' FROM public.audit_record_questions WHERE organisation_id = a;
  INSERT INTO public.audit_ncr_links (organisation_id, audit_record_id, response_id, nonconformance_id)
    SELECT a, s.audit_record_id, s.id, n.id FROM public.audit_responses s JOIN public.nonconformances n ON n.organisation_id = a AND n.reference = 'SW-NCR-LOT' WHERE s.organisation_id = a;
  INSERT INTO public.audit_attachments (organisation_id, audit_record_id, record_question_id, storage_path, file_name, size_bytes)
    SELECT a, q.audit_record_id, q.id, a::text || '/audit/' || q.audit_record_id::text || '/sweep.jpg', 'sweep.jpg', 1 FROM public.audit_record_questions q WHERE q.organisation_id = a;
  -- Audit findings (Phase A): a finding on the answer (classifications are seeded with the organisation), its evidence, and a link to the lot NC.
  INSERT INTO public.audit_findings (organisation_id, reference, audit_record_id, response_id, classification_id, title, description)
    SELECT a, 'SW-AF-1', s.audit_record_id, s.id, c.id, 'Sweep finding', 'Found by the sweep'
      FROM public.audit_responses s JOIN public.audit_finding_classifications c ON c.organisation_id = a AND c.key = 'major_nc' WHERE s.organisation_id = a;
  INSERT INTO public.audit_finding_attachments (organisation_id, audit_record_id, finding_id, storage_path, file_name, size_bytes)
    SELECT a, f.audit_record_id, f.id, a::text || '/audit/' || f.audit_record_id::text || '/findings/' || f.id::text || '/sweep.jpg', 'sweep.jpg', 1 FROM public.audit_findings f WHERE f.organisation_id = a;
  UPDATE public.audit_ncr_links SET finding_id = (SELECT id FROM public.audit_findings WHERE organisation_id = a) WHERE organisation_id = a;

  -- In-process inspection (PC4): make the sweep plan effective with one check, then inspect SW-P1.
  PERFORM pg_temp.login('50000000-0000-0000-0000-0000000000a1');
  UPDATE public.control_plan_revisions SET change_reason = 'Sweep' WHERE organisation_id = a;
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE organisation_id = a;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE organisation_id = a;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE organisation_id = a;
  inspection := app.start_inspection(site, (SELECT id FROM public.parts WHERE organisation_id = a AND part_number = 'SW-P1'));
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (a, inspection);
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric)
    SELECT a, s.inspection_record_id, s.id, q.id, 100 FROM public.inspection_samples s
    JOIN public.resolved_inspection_requirements q ON q.inspection_record_id = s.inspection_record_id WHERE s.organisation_id = a;
  -- PC5: a failing second sample, acknowledged, and an NC raised from it.
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (a, inspection);
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric)
    SELECT a, s.inspection_record_id, s.id, q.id, 105 FROM public.inspection_samples s
    JOIN public.resolved_inspection_requirements q ON q.inspection_record_id = s.inspection_record_id
    WHERE s.organisation_id = a AND s.sample_number = 2;
  INSERT INTO public.inspection_failure_acknowledgements (organisation_id, inspection_record_id, measurement_id, note)
    SELECT a, inspection_record_id, id, 'Seen by the sweep' FROM public.inspection_measurements WHERE inspection_record_id = inspection AND result = 'fail';
  PERFORM app.raise_ncr_from_inspection(inspection, ARRAY(SELECT id FROM public.inspection_measurements WHERE inspection_record_id = inspection AND result = 'fail'), 'Sweep NC from inspection');
  -- PC6: a saved SPC baseline.
  INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, chart_type, subgroup_size, window_from, window_to, n_points, provisional,
      measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma)
    SELECT a, id, 'SWEEP', 'imr', 1, now() - interval '1 day', now(), 5, true,
           ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()], 100, 103, 97, 1, 3.3, 0, 1
    FROM public.parts WHERE organisation_id = a AND part_number = 'SW-P1';
  -- PC11: an SPC alert, raised through the function.
  PERFORM app.raise_spc_alerts(a, (SELECT id FROM public.parts WHERE organisation_id = a AND part_number = 'SW-P1'),
    '[{"characteristicKey":"SWEEP","characteristicName":"Sweep","operationCode":"OP-1","variant":"imr","rule":"we1","side":"above","pointAt":"2026-11-05T08:00:00Z","summary":"Rule 1","inspectionId":null,"inspectionReference":null}]'::jsonb);
  -- DOC1: a quality alert draft with scope and targets.
  INSERT INTO public.quality_alerts (organisation_id, title, category, severity) VALUES (a, 'Sweep alert', 'product', 'low') RETURNING id INTO qa;
  PERFORM app.set_quality_alert_scope(qa, jsonb_build_object(
    'parts', jsonb_build_array(jsonb_build_object('partId', (SELECT id FROM public.parts WHERE organisation_id = a AND part_number = 'SW-P1'))),
    'machines', jsonb_build_array((SELECT id FROM public.machines WHERE organisation_id = a LIMIT 1)),
    'operations', jsonb_build_array('OP-1'),
    'departments', jsonb_build_array((SELECT id FROM public.departments WHERE organisation_id = a LIMIT 1)),
    'targets', jsonb_build_array(jsonb_build_object('membershipId', (SELECT id FROM public.organisation_users WHERE organisation_id = a AND user_id = '50000000-0000-0000-0000-0000000000a1')))));
  -- DOC3: an attachment and links on the draft.
  PERFORM app.add_quality_alert_attachment(qa, a::text || '/quality-alerts/' || qa::text || '/sweep.pdf', 'sweep.pdf', 'application/pdf', 10, 'Sweep file');
  PERFORM app.set_quality_alert_links(qa, jsonb_build_array(
    jsonb_build_object('supplierId', (SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1)),
    jsonb_build_object('nonconformanceId', (SELECT id FROM public.nonconformances WHERE organisation_id = a LIMIT 1)),
    jsonb_build_object('gaugeId', (SELECT id FROM public.gauges WHERE organisation_id = a LIMIT 1)),
    jsonb_build_object('calibrationId', (SELECT id FROM public.calibrations WHERE organisation_id = a LIMIT 1))));
  -- DOC2: issued, so its recipient (the owner) exists.
  UPDATE public.quality_alerts SET description = 'd', required_action = 'a', effective_date = current_date WHERE id = qa;
  PERFORM app.set_quality_alert_actions(qa, '[{"description":"a"}]'::jsonb);
  PERFORM app.issue_quality_alert(qa);
  -- CAPA1: an 8D started from a non-conformance (steps, the creator as leader, the NC link).
  PERFORM app.start_capa(a, NULL, NULL, NULL, NULL, (SELECT id FROM public.nonconformances WHERE organisation_id = a AND deleted_at IS NULL LIMIT 1));
  -- CAPA2: an Is / Is-Not analysis and an interim containment action.
  INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step, data)
    SELECT a, id, 'is_is_not', 'Sweep Is / Is-Not', 'd2', '{"rows": []}'::jsonb FROM public.capas WHERE organisation_id = a LIMIT 1;
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description)
    SELECT a, id, 'interim', 'Sweep containment' FROM public.capas WHERE organisation_id = a LIMIT 1;
  -- CAPA3: a root cause.
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description)
    SELECT a, id, 'occurrence', 'Sweep root cause' FROM public.capas WHERE organisation_id = a LIMIT 1;
  -- CAPA4: a corrective action carried out and verified.
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description)
    SELECT a, id, 'corrective', 'Sweep corrective action' FROM public.capas WHERE organisation_id = a LIMIT 1;
  UPDATE public.capa_actions SET status = 'done', evidence_note = 'Sweep findings' WHERE organisation_id = a AND phase = 'corrective';
  PERFORM app.record_capa_verification((SELECT id FROM public.capas WHERE organisation_id = a LIMIT 1), true, 'Sweep check', NULL);
  -- ON2: the wizard's saved progress.
  PERFORM app.set_onboarding_step(a, 'details', 'done');
  -- CAPA5: an evidence file.
  PERFORM app.add_capa_attachment((SELECT id FROM public.capas WHERE organisation_id = a LIMIT 1), a::text || '/capa/' || (SELECT id FROM public.capas WHERE organisation_id = a LIMIT 1)::text || '/sweep.pdf', 'sweep.pdf', 'application/pdf', 10, 'Sweep file');
  PERFORM pg_temp.logout();
  -- DOC: the history of an expiry, as the database writes it (nobody is signed in).
  INSERT INTO public.quality_alert_events (organisation_id, alert_id, kind, previous_expiry) VALUES (a, qa, 'expired', current_date - 1);

  -- Subscription: seats and an assignment through the API functions, invoice and payment as the provider would.
  PERFORM pg_temp.login('50000000-0000-0000-0000-0000000000a1');
  PERFORM app.set_subscription_seats(a, 'controller', 2);
  PERFORM app.assign_subscription_package((SELECT id FROM public.organisation_users WHERE organisation_id = a AND user_id = '50000000-0000-0000-0000-0000000000a1'), 'controller');
  PERFORM pg_temp.logout();
  INSERT INTO public.billing_invoices (organisation_id, provider_invoice_id, invoice_number, subtotal, tax_amount, total_amount, status)
    VALUES (a, 'in_sweep', 'INV-1', 5000, 1000, 6000, 'paid');
  INSERT INTO public.billing_payments (organisation_id, provider_payment_id, invoice_id, amount, status)
    SELECT a, 'pay_sweep', id, 6000, 'succeeded' FROM public.billing_invoices WHERE organisation_id = a;
  -- ON3: Stripe customer, a checkout and a webhook event (the last is platform-owned: only an operator reads it).
  INSERT INTO public.billing_customers (organisation_id, provider_customer_id) VALUES (a, 'cus_sweep1');
  INSERT INTO public.stripe_checkout_sessions (organisation_id, provider_session_id, membership_id, billing_interval, seats)
    SELECT a, 'cs_sweep_1', id, 'month', '{"controller":1}'::jsonb FROM public.organisation_users WHERE organisation_id = a AND user_id = '50000000-0000-0000-0000-0000000000a1';
  INSERT INTO public.stripe_events (event_id, event_type, organisation_id, status) VALUES ('evt_sweep_1', 'invoice.paid', a, 'processed');
  INSERT INTO public.notification_preferences (organisation_id, user_id, event_type_id, enabled)
    SELECT a, '50000000-0000-0000-0000-0000000000a1', id, false FROM public.notification_event_types WHERE key = 'parts.created';
  INSERT INTO public.saved_filters (organisation_id, user_id, scope, name, filters) VALUES (a, '50000000-0000-0000-0000-0000000000a1', 'ncr_register', 'Sweep filter', '{"stage":"open"}');
  -- Supplier quality (SQ1): the supplier's first status row exists already; classifications are seeded per organisation.
  INSERT INTO public.supplier_classification_links (organisation_id, supplier_id, classification_id)
    SELECT a, (SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1), id FROM public.supplier_classifications WHERE organisation_id = a AND key = 'welding';
  INSERT INTO public.supplier_contacts (organisation_id, supplier_id, name) VALUES (a, (SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1), 'Sweep Contact');
  INSERT INTO public.supplier_product_links (organisation_id, supplier_id, kind, description) VALUES (a, (SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1), 'service', 'Sweep service');
  -- Supplier quality (SQ2a): a document and a certification, written by the functions (as a member).
  PERFORM pg_temp.login('50000000-0000-0000-0000-0000000000a1');
  PERFORM app.add_supplier_certification((SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1),
    jsonb_build_object('certType', 'iso_9001', 'certificateNumber', 'SWEEP-1', 'issuingBody', 'Sweep Body', 'expiresOn', (current_date + 400)::text));
  PERFORM app.add_supplier_document((SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1), 'quality_manual', 'Sweep manual', 'A', NULL, NULL, NULL,
    a::text || '/supplier/' || (SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1)::text || '/sweep.pdf', 'sweep.pdf', 'application/pdf', 10);
  -- Supplier quality (SQ2b): a risk assessment against the organisation's default model.
  PERFORM app.record_supplier_risk_assessment((SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1),
    (SELECT jsonb_agg(jsonb_build_object('key', f ->> 'key', 'score', 2)) FROM public.supplier_risk_models m, jsonb_array_elements(m.factors) f WHERE m.organisation_id = a AND m.version = 1),
    'Sweep rationale');
  -- Supplier quality (SQ2c): a completed assessment (every question answered) and a proposed approval decision.
  CREATE TEMP TABLE _sweep_assessment AS
    SELECT app.start_supplier_assessment((SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1),
      (SELECT v.id FROM public.supplier_assessment_template_versions v WHERE v.organisation_id = a AND v.version = 1 LIMIT 1)) AS id;
  FOR sweep_q IN SELECT x FROM jsonb_array_elements((SELECT questions FROM public.supplier_assessments WHERE id = (SELECT id FROM _sweep_assessment))) x LOOP
    PERFORM app.record_supplier_assessment_response((SELECT id FROM _sweep_assessment), sweep_q.x ->> 'key',
      CASE sweep_q.x ->> 'answerType' WHEN 'yes_no' THEN 'yes' END, CASE sweep_q.x ->> 'answerType' WHEN 'rating' THEN 5 END,
      CASE sweep_q.x ->> 'answerType' WHEN 'text' THEN 'Sweep note' END,
      CASE WHEN (sweep_q.x ->> 'evidenceRequired')::boolean THEN (SELECT d.id FROM public.supplier_documents d WHERE d.organisation_id = a AND d.status = 'current' LIMIT 1) END);
  END LOOP;
  PERFORM app.complete_supplier_assessment((SELECT id FROM _sweep_assessment), 'Sweep summary');
  PERFORM app.propose_supplier_approval((SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1), 'approved', 'Sweep proposal', (SELECT id FROM _sweep_assessment));
  DROP TABLE _sweep_assessment;
  -- Supplier quality (SQ3): a SCAR taken through every stage, so each of its tables has a row.
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id)
    VALUES (a, 'supplier', 'Sweep supplier NC', 'x', 'minor', 1, (SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1));
  CREATE TEMP TABLE _sweep_scar AS
    SELECT (app.create_supplier_scar((SELECT id FROM public.suppliers WHERE organisation_id = a LIMIT 1), 'Sweep SCAR', NULL, 'minor', current_date + 10, NULL,
      ARRAY[(SELECT id FROM public.nonconformances WHERE organisation_id = a AND title = 'Sweep supplier NC')], NULL, NULL) ->> 'id')::uuid AS id;
  PERFORM app.issue_supplier_scar((SELECT id FROM _sweep_scar));
  PERFORM app.extend_scar_due_date((SELECT id FROM _sweep_scar), current_date + 20, 'Sweep extension');
  PERFORM app.acknowledge_supplier_scar((SELECT id FROM _sweep_scar), 'Sweep acknowledgement');
  PERFORM app.record_scar_response((SELECT id FROM _sweep_scar), 'Sweep cause', NULL, 'Sweep fix', NULL, NULL, current_date, 'Sweep supplier', NULL);
  PERFORM app.start_scar_review((SELECT id FROM _sweep_scar));
  PERFORM app.review_scar_response((SELECT id FROM _sweep_scar), 'accepted', 'Sweep review');
  PERFORM app.record_scar_implementation((SELECT id FROM _sweep_scar), 'Sweep implementation', current_date, NULL);
  PERFORM app.record_scar_verification((SELECT id FROM _sweep_scar), 'effective', 'Sweep method', 'Sweep finding');
  DROP TABLE _sweep_scar;
  PERFORM pg_temp.logout();
  INSERT INTO public.notification_reads (organisation_id, user_id, notification_id)
    SELECT a, '50000000-0000-0000-0000-0000000000a1', id FROM public.notifications WHERE organisation_id = a LIMIT 1;
  INSERT INTO sweep VALUES ('pc_part', (SELECT id FROM public.parts WHERE organisation_id = a AND part_number = 'SW-P1'));
  INSERT INTO sweep VALUES ('a', a), ('b', b), ('owner_role', owner_role), ('invite', invite),
    ('owner_membership', (SELECT id FROM public.organisation_users WHERE organisation_id = a AND user_id = '50000000-0000-0000-0000-0000000000a1'));
END $$;

-- Coverage: organisation A must have rows in every tenant table and view (catalogue-driven).
DO $$
DECLARE r record; n bigint; missing text := '';
  a uuid := (SELECT value FROM sweep WHERE key = 'a');
BEGIN
  FOR r IN SELECT c.relnamespace::regnamespace::text AS nsp, c.relname
           FROM pg_class c JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'organisation_id' AND NOT att.attisdropped
           WHERE c.relnamespace IN ('public'::regnamespace, 'audit'::regnamespace) AND c.relkind IN ('r', 'v')
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE organisation_id = $1', r.nsp, r.relname) INTO n USING a;
    IF n = 0 THEN missing := missing || ' ' || r.nsp || '.' || r.relname; END IF;
  END LOOP;
  IF missing <> '' THEN
    RAISE EXCEPTION 'sweep setup has no organisation A rows in:% (add seed data for new tables)', missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- As B's Owner: nothing of A is readable or writable anywhere
-- ---------------------------------------------------------------------------
SET CONSTRAINTS ALL IMMEDIATE;
DO $$
DECLARE r record; n bigint; failures text := '';
  a uuid := (SELECT value FROM sweep WHERE key = 'a');
BEGIN
  PERFORM pg_temp.login('50000000-0000-0000-0000-0000000000b1');
  FOR r IN SELECT c.relnamespace::regnamespace::text AS nsp, c.relname, c.relkind
           FROM pg_class c JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'organisation_id' AND NOT att.attisdropped
           WHERE c.relnamespace IN ('public'::regnamespace, 'audit'::regnamespace) AND c.relkind IN ('r', 'v')
  LOOP
    -- read
    BEGIN
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE organisation_id = $1', r.nsp, r.relname) INTO n USING a;
      IF n > 0 THEN failures := failures || format(E'\n  read %s.%s: %s rows', r.nsp, r.relname, n); END IF;
    EXCEPTION WHEN insufficient_privilege THEN NULL;  -- no access at all is fine
    END;
    -- update and delete (only tables)
    IF r.relkind = 'r' THEN
      BEGIN
        n := pg_temp.affected(format('UPDATE %I.%I SET organisation_id = organisation_id WHERE organisation_id = %L', r.nsp, r.relname, a));
        IF n > 0 THEN failures := failures || format(E'\n  update %s.%s: %s rows', r.nsp, r.relname, n); END IF;
      EXCEPTION WHEN OTHERS THEN NULL;  -- refused
      END;
      BEGIN
        n := pg_temp.affected(format('DELETE FROM %I.%I WHERE organisation_id = %L', r.nsp, r.relname, a));
        IF n > 0 THEN failures := failures || format(E'\n  delete %s.%s: %s rows', r.nsp, r.relname, n); END IF;
      EXCEPTION WHEN OTHERS THEN NULL;  -- refused
      END;
    END IF;
  END LOOP;

  -- Tables keyed differently.
  IF (SELECT count(*) FROM public.organisations WHERE id = a) > 0 THEN failures := failures || E'\n  read organisations'; END IF;
  IF pg_temp.affected(format($q$UPDATE public.organisations SET name = 'x' WHERE id = %L$q$, a)) > 0 THEN failures := failures || E'\n  update organisations'; END IF;
  IF (SELECT count(*) FROM public.profiles WHERE id = '50000000-0000-0000-0000-0000000000a1') > 0 THEN failures := failures || E'\n  read A owner profile'; END IF;
  IF (SELECT count(*) FROM public.role_permissions WHERE role_id = (SELECT value::uuid FROM sweep WHERE key = 'owner_role')) > 0 THEN failures := failures || E'\n  read A role permissions'; END IF;
  IF (SELECT count(*) FROM storage.objects WHERE name LIKE a || '/%') > 0 THEN failures := failures || E'\n  read A storage objects'; END IF;

  PERFORM pg_temp.logout();
  IF failures <> '' THEN RAISE EXCEPTION 'Cross-tenant access from B to A:%', failures; END IF;
END $$;

-- Functions: every callable function answers nothing about A.
DO $$
DECLARE
  a uuid := (SELECT value FROM sweep WHERE key = 'a');
  owner_role uuid := (SELECT value FROM sweep WHERE key = 'owner_role');
  owner_membership uuid := (SELECT value FROM sweep WHERE key = 'owner_membership');
  invite uuid := (SELECT value FROM sweep WHERE key = 'invite');
BEGIN
  PERFORM pg_temp.login('50000000-0000-0000-0000-0000000000b1');
  PERFORM pg_temp.assert_eq(app.is_member(a), false, 'is_member(A)');
  PERFORM pg_temp.assert_eq(app.has_permission(a, 'ncr.read'), false, 'has_permission(A)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_permissions(a)), 0::bigint, 'my_permissions(A)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.member_organisation_ids() WHERE member_organisation_ids = a), 0::bigint, 'member_organisation_ids');
  PERFORM pg_temp.assert_eq(app.shares_organisation('50000000-0000-0000-0000-0000000000a1'), false, 'shares_organisation(A owner)');
  PERFORM pg_temp.assert_eq(app.is_active_member_user(a, '50000000-0000-0000-0000-0000000000a1'), false, 'is_active_member_user probe');
  PERFORM pg_temp.assert_eq(app.can_assign_role(a, owner_role), false, 'can_assign_role probe');
  PERFORM pg_temp.assert_eq(app.can_manage_membership(owner_membership), false, 'can_manage_membership probe');
  PERFORM pg_temp.assert_fails(format('SELECT * FROM app.list_members(%L)', a), 'list_members(A)');
  PERFORM pg_temp.assert_fails(format('SELECT app.accept_invitation(%L)', invite), 'accept A invitation addressed to someone else');
  PERFORM pg_temp.assert_fails(format('SELECT app.create_default_roles(%L)', a), 'create_default_roles is not callable');
  PERFORM pg_temp.assert_fails($q$SELECT app.touch_updated()$q$, 'trigger functions are not callable');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_invitations() WHERE organisation_id = a), 0::bigint, 'my_invitations');
  PERFORM pg_temp.assert_fails(format('SELECT app.resolve_inspection_requirements(%L)', (SELECT value FROM sweep WHERE key = 'pc_part')), 'resolve_inspection_requirements(A part)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.gauge_usage((SELECT id FROM public.gauges LIMIT 1))), 0::bigint, 'gauge_usage of A');
  PERFORM pg_temp.assert_fails(format('SELECT app.raise_ncr_from_inspection(%L, ARRAY[]::uuid[], %L)', (SELECT id FROM public.inspection_records LIMIT 1), 'x'), 'raise_ncr_from_inspection(A inspection)');
  PERFORM pg_temp.assert_fails(format('SELECT app.start_inspection(%L, %L)', (SELECT id FROM public.sites LIMIT 1), (SELECT value FROM sweep WHERE key = 'pc_part')), 'start_inspection(A part)');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
