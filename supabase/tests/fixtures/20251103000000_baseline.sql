-- Legacy data shaped like the live project before Phase 1 (one organisation, one login user whose
-- employee record belongs to it, other employees without an organisation, NCRs referencing
-- lookups, a notification). Loaded right after the baseline so the Phase 1 backfills are exercised.
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000a1', 'legacy.owner@example.test');

INSERT INTO public."Organisations" (id, name, base_currency, vat_rate)
VALUES ('00000000-0000-0000-0000-00000000000a', 'Legacy Org Ltd', 'GBP', 0.20);

INSERT INTO public."Employees" (id, first_name, surname, job_title, active, auth_id, organisation_id) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'Lee', 'Owner', 'Quality Manager', true, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-0000000000e2', 'Op', 'One', 'Operator', true, NULL, NULL);

INSERT INTO public."Status" (id, name, type) VALUES (1, 'Open', 'initial'), (2, 'Closed', 'terminal');
INSERT INTO public."Failure Mode" (id, code, name) VALUES (1, 'DIM', 'Dimensional');
INSERT INTO public."Sub-Failure Mode" (id, failure_mode, name, updated_at) VALUES (1, 1, 'Oversize', '');
INSERT INTO public."Process" (id, code, name) VALUES (1, 'CNC', 'Machining');
INSERT INTO public."Part" (id, part_number, name) VALUES ('00000000-0000-0000-0000-0000000000b1', 'P-100', 'Bracket');
INSERT INTO public."Customers" (id, name, display_name) VALUES ('00000000-0000-0000-0000-0000000000c1', 'Acme', 'Acme');

INSERT INTO public."NCM" (ncm_id, date, type, part_number, quantity_defective, failure_mode, sub_failure_mode, status, causal_process, responsible_operator, logged_by, customer)
VALUES ('NCM-25-001', now(), 'Internal', '00000000-0000-0000-0000-0000000000b1', 3, 1, 1, 1, 1, '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1');

INSERT INTO public."NC Files" (name, path, id_ref, owner) VALUES ('photo.jpg', 'NCM-25-001_photo.jpg', 'NCM-25-001', '00000000-0000-0000-0000-0000000000a1');

INSERT INTO public."Notifications" (id, org, created_by, title) VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'Hello');
INSERT INTO public."Notification Recipients" (notification_id, recipient_id) VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1');

-- Explicit ids above don't advance identity sequences; keep them in step as the live project's are.
SELECT setval(pg_get_serial_sequence('public."Status"', 'id'), (SELECT max(id) FROM public."Status"));
SELECT setval(pg_get_serial_sequence('public."Failure Mode"', 'id'), (SELECT max(id) FROM public."Failure Mode"));
SELECT setval(pg_get_serial_sequence('public."Process"', 'id'), (SELECT max(id) FROM public."Process"));
