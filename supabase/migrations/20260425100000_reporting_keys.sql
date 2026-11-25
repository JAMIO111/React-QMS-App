-- Reporting API for Power BI (docs/reporting-api-plan.md, slice RP1): read-only keys and the flat views they read.
--
--  * reporting_keys: one row per key. The key itself (fqr_ + 32 random bytes) is made by the API and shown once; only its SHA-256 and an eight-character
--    prefix are stored. A key acts as the person who made it (user_id), read-only: the API lets it call GET /reporting/v1/* and nothing else, and every
--    existing check (active membership, two-factor, seat, network rule, permission, row-level security) still runs for that person. It expires
--    (1 to 730 days), can be revoked with a reason, and keeps the last time and address it was used. Never deleted.
--  * People do not write the table: app.create_reporting_key / app.revoke_reporting_key (integrations.manage, so a Controller seat). The API login alone
--    runs app.system_report_key_lookup, which turns a key's hash into the organisation and person it stands for (or nothing).
--  * report_* views: flat, readable datasets for non-conformances, their costs, suppliers, SCARs, receipt lines with their decisions and saved scorecards.
--    security_invoker = true, so the caller's rights and row-level security apply, never the view owner's. Joins to names are LEFT JOINs, so a missing
--    lookup right blanks a name instead of dropping a row.
-- Errors: QM022 (409 integration_rule); another organisation's key is P0002 (404).

CREATE TABLE public.reporting_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  key_prefix text NOT NULL CHECK (key_prefix ~ '^[A-Za-z0-9_-]{8}$'),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  last_used_address text CHECK (last_used_address IS NULL OR length(last_used_address) <= 45),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  revoked_reason text CHECK (revoked_reason IS NULL OR length(btrim(revoked_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  UNIQUE (id, organisation_id),
  CONSTRAINT reporting_keys_revoked_check CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX reporting_keys_org_idx ON public.reporting_keys (organisation_id, created_at DESC);

CREATE FUNCTION app.reporting_key_never_deleted() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Reporting keys are never deleted; revoke them instead' USING ERRCODE = 'QM022';
END $$;
CREATE TRIGGER reporting_keys_no_delete BEFORE DELETE ON public.reporting_keys FOR EACH ROW EXECUTE FUNCTION app.reporting_key_never_deleted();
CREATE TRIGGER reporting_keys_org_immutable BEFORE UPDATE ON public.reporting_keys FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
-- Audited: making and revoking a key. Use (last_used_*) is skipped, or every refresh would write to the trail.
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OF name, expires_at, revoked_at, revoked_reason OR DELETE ON public.reporting_keys
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.reporting_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reporting_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reporting_keys TO authenticated;
CREATE POLICY reporting_keys_select ON public.reporting_keys FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));

-- ---------------------------------------------------------------------------
-- People's functions
-- ---------------------------------------------------------------------------
-- The API makes the key and passes only its SHA-256 and prefix. The caller must be able to manage integrations; the key stands for the caller.
CREATE FUNCTION app.create_reporting_key(p_organisation_id uuid, p_name text, p_days integer, p_hash text, p_prefix text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_name text := btrim(coalesce(p_name, '')); v_days integer := coalesce(p_days, 365); v_id uuid; v_expires timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT app.has_permission(p_organisation_id, 'integrations.manage') THEN
    RAISE EXCEPTION 'Making reporting keys needs the integrations manage permission (a Controller seat)' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) < 1 OR length(v_name) > 80 THEN RAISE EXCEPTION 'Give the key a name (1 to 80 characters)' USING ERRCODE = 'QM022'; END IF;
  IF v_days < 1 OR v_days > 730 THEN RAISE EXCEPTION 'A key lasts from 1 to 730 days' USING ERRCODE = 'QM022'; END IF;
  IF (SELECT count(*) FROM public.reporting_keys WHERE organisation_id = p_organisation_id AND revoked_at IS NULL AND expires_at > now()) >= 10 THEN
    RAISE EXCEPTION 'An organisation can have ten reporting keys at a time; revoke one first' USING ERRCODE = 'QM022';
  END IF;
  v_expires := now() + make_interval(days => v_days);
  INSERT INTO public.reporting_keys (organisation_id, user_id, name, key_prefix, key_hash, expires_at)
  VALUES (p_organisation_id, auth.uid(), v_name, p_prefix, p_hash, v_expires) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'expiresAt', v_expires);
END $$;

CREATE FUNCTION app.revoke_reporting_key(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.reporting_keys%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO r FROM public.reporting_keys WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Reporting key not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(r.organisation_id, 'integrations.manage') THEN
    RAISE EXCEPTION 'Revoking reporting keys needs the integrations manage permission (a Controller seat)' USING ERRCODE = '42501';
  END IF;
  IF r.revoked_at IS NOT NULL THEN RETURN; END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RAISE EXCEPTION 'Say why the key is being revoked (3 to 500 characters)' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.reporting_keys SET revoked_at = now(), revoked_by = auth.uid(), revoked_reason = v_reason WHERE id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- The API login's one function: whose key is this? Nothing when it is unknown, revoked, expired, or its person is no longer an active member
-- of an active organisation. Records when it was last used (at most once a minute).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.system_report_key_lookup(p_hash text, p_address text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k public.reporting_keys%ROWTYPE; v_email text;
BEGIN
  SELECT * INTO k FROM public.reporting_keys WHERE key_hash = p_hash AND revoked_at IS NULL AND expires_at > now();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organisation_users m JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
                  WHERE m.organisation_id = k.organisation_id AND m.user_id = k.user_id AND m.status = 'active') THEN
    RETURN NULL;
  END IF;
  IF k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute' THEN
    UPDATE public.reporting_keys SET last_used_at = now(), last_used_address = left(nullif(btrim(coalesce(p_address, '')), ''), 45) WHERE id = k.id;
  END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = k.user_id;
  RETURN jsonb_build_object('keyId', k.id, 'organisationId', k.organisation_id, 'userId', k.user_id, 'email', v_email);
END $$;

REVOKE ALL ON FUNCTION app.reporting_key_never_deleted(), app.create_reporting_key(uuid, text, integer, text, text), app.revoke_reporting_key(uuid, text),
  app.system_report_key_lookup(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.create_reporting_key(uuid, text, integer, text, text), app.revoke_reporting_key(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_report_key_lookup(text, text) TO qms_api;

-- ---------------------------------------------------------------------------
-- The datasets. Flat, readable column names; ordered by the API on (updated_at, id). Every view runs with the caller's rights.
-- ---------------------------------------------------------------------------
CREATE VIEW public.report_non_conformances WITH (security_invoker = true) AS
SELECT n.id, n.organisation_id, n.reference, n.title, n.source, n.stage, n.severity,
       cat.name AS category, fm.name AS failure_mode, sfm.name AS sub_failure_mode,
       n.description, n.requirement, n.actual_result,
       s.code AS site_code, s.name AS site,
       p.part_number, p.name AS part_name,
       cu.code AS customer_code, cu.name AS customer,
       su.code AS supplier_code, su.name AS supplier,
       n.work_order, n.purchase_order, n.customer_reference, n.lot_number, n.serial_number,
       n.quantity_affected, n.quantity_inspected,
       n.detected_at AS detected_on, n.created_at AS raised_at, n.closed_at,
       dm.name AS detected_at_machine, cm.name AS causal_machine, rd.name AS responsible_department,
       nullif(btrim(coalesce(de.first_name, '') || ' ' || coalesce(de.surname, '')), '') AS detected_by,
       nullif(btrim(coalesce(re.first_name, '') || ' ' || coalesce(re.surname, '')), '') AS responsible_employee,
       tc.currency AS cost_currency, tc.total AS total_cost, tc.lines AS cost_lines, tc.waiting AS cost_lines_waiting_for_rate,
       greatest(n.updated_at, tc.last_change) AS updated_at
  FROM public.nonconformances n
  LEFT JOIN public.ncr_classifications cat ON cat.id = n.category_id
  LEFT JOIN public.ncr_classifications fm ON fm.id = n.failure_mode_id
  LEFT JOIN public.ncr_classifications sfm ON sfm.id = n.sub_failure_mode_id
  LEFT JOIN public.sites s ON s.id = n.site_id
  LEFT JOIN public.parts p ON p.id = n.part_id
  LEFT JOIN public.customers cu ON cu.id = n.customer_id
  LEFT JOIN public.suppliers su ON su.id = n.supplier_id
  LEFT JOIN public.machines dm ON dm.id = n.detection_process_id
  LEFT JOIN public.machines cm ON cm.id = n.causal_process_id
  LEFT JOIN public.departments rd ON rd.id = n.responsible_department_id
  LEFT JOIN public."Employees" de ON de.id = n.detected_by_employee_id
  LEFT JOIN public."Employees" re ON re.id = n.responsible_employee_id
  LEFT JOIN LATERAL (
    SELECT sum(c.net_org * c.cost_sign) AS total, max(c.org_currency) AS currency, count(*) AS lines,
           count(*) FILTER (WHERE c.net_org IS NULL) AS waiting, max(c.updated_at) AS last_change
      FROM public.ncr_costs c WHERE c.nonconformance_id = n.id AND c.deleted_at IS NULL
  ) tc ON true
 WHERE n.deleted_at IS NULL;

-- One row per cost line. Amounts are signed (a supplier recovery or customer charge is a credit, so a sum is right); a line still waiting for an
-- exchange rate has no converted amount (NULL) and says so in rate_status.
CREATE VIEW public.report_non_conformance_costs WITH (security_invoker = true) AS
SELECT c.id, c.organisation_id, n.id AS non_conformance_id, n.reference AS non_conformance_reference, n.title AS non_conformance_title,
       c.cost_type, c.description, c.incurred_on, c.currency AS entered_currency, c.quantity, c.unit_cost, c.amount AS entered_amount,
       c.vat_treatment, c.vat_rate,
       c.base_currency AS site_currency, c.net_base * c.cost_sign AS net_site_currency,
       c.org_currency AS organisation_currency, c.net_org * c.cost_sign AS net_organisation_currency, c.gross_org * c.cost_sign AS gross_organisation_currency,
       c.cost_sign, c.rate_status, c.rate_date, c.updated_at
  FROM public.ncr_costs c
  JOIN public.nonconformances n ON n.id = c.nonconformance_id AND n.deleted_at IS NULL
 WHERE c.deleted_at IS NULL;

CREATE VIEW public.report_suppliers WITH (security_invoker = true) AS
SELECT s.id, s.organisation_id, s.code, s.name, s.display_name, s.supplier_type, s.approval_status, s.approval_status_changed_at, s.risk_rating,
       s.active, s.country, s.city, s.postcode, s.currency, s.purchasing_reference, s.created_at, s.updated_at
  FROM public.suppliers s;

CREATE VIEW public.report_scars WITH (security_invoker = true) AS
SELECT r.id, r.organisation_id, r.reference, su.code AS supplier_code, su.name AS supplier, r.title, r.severity, r.status,
       r.original_response_due_on, r.response_due_on, r.issued_at, r.acknowledged_at, r.closed_at, r.cancelled_at,
       (r.status IN ('issued', 'acknowledged', 'revision_requested') AND r.response_due_on < current_date) AS response_overdue,
       (SELECT count(*) FROM public.supplier_scar_ncrs l WHERE l.scar_id = r.id AND l.ended_at IS NULL) AS live_non_conformances,
       r.created_at, r.updated_at
  FROM public.supplier_scars r
  LEFT JOIN public.suppliers su ON su.id = r.supplier_id
 WHERE r.status <> 'draft';

-- One row per received line with its latest decision. quantity_rejected is what was refused: the recorded quantity, or the whole line when it was
-- rejected without one. updated_at is the latest change to the line, its receipt or its decision.
CREATE VIEW public.report_receipt_lines WITH (security_invoker = true) AS
SELECT l.id, l.organisation_id, g.reference AS receipt_reference, g.status AS receipt_status, g.received_on, g.delivery_note,
       su.code AS supplier_code, su.name AS supplier, po.po_number AS purchase_order, l.line_number,
       p.part_number, p.name AS part_name, l.material, l.quantity_received, lt.lot_number,
       d.decision AS latest_decision, d.decided_at AS decided_at,
       CASE WHEN d.decision = 'rejected' THEN coalesce(d.quantity_rejected, l.quantity_received) ELSE 0 END AS quantity_rejected,
       (SELECT count(*) FROM public.receipt_line_ncrs rn WHERE rn.receipt_line_id = l.id AND rn.ended_at IS NULL) AS live_non_conformances,
       greatest(l.updated_at, g.updated_at, d.updated_at) AS updated_at
  FROM public.goods_receipt_lines l
  JOIN public.goods_receipts g ON g.id = l.goods_receipt_id
  LEFT JOIN public.suppliers su ON su.id = g.supplier_id
  LEFT JOIN public.purchase_orders po ON po.id = g.purchase_order_id
  LEFT JOIN public.parts p ON p.id = l.part_id
  LEFT JOIN public.lots lt ON lt.id = l.lot_id
  LEFT JOIN LATERAL (
    SELECT x.decision, x.decided_at, x.quantity_rejected, x.updated_at
      FROM public.receipt_line_dispositions x WHERE x.receipt_line_id = l.id ORDER BY x.decided_at DESC, x.id DESC LIMIT 1
  ) d ON true;

CREATE VIEW public.report_supplier_scorecards WITH (security_invoker = true) AS
SELECT c.id, c.organisation_id, su.code AS supplier_code, su.name AS supplier, c.period_kind, c.period_from, c.period_to,
       c.score, c.band, c.model_version, c.note, c.metrics, c.components, c.created_at, c.updated_at
  FROM public.supplier_scorecards c
  LEFT JOIN public.suppliers su ON su.id = c.supplier_id;

REVOKE ALL ON public.report_non_conformances, public.report_non_conformance_costs, public.report_suppliers, public.report_scars,
  public.report_receipt_lines, public.report_supplier_scorecards FROM PUBLIC, anon;
GRANT SELECT ON public.report_non_conformances, public.report_non_conformance_costs, public.report_suppliers, public.report_scars,
  public.report_receipt_lines, public.report_supplier_scorecards TO authenticated;
