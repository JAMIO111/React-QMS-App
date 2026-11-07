-- NC containment and disposition (docs/ncr-containment-disposition-plan.md, NC1).
--
-- Containment actions record what was done to stop suspect product going on (or why none was needed); dispositions record what happens to the affected items, approved by someone
-- with ncr.approve_disposition. Stage moves forward are gated, cumulatively: to reach Contained or anything beyond, containment must be resolved; to reach Dispositioned or beyond,
-- dispositions must also be settled (none proposed, approved ones covering the whole quantity affected). Existing NCs keep their stage; the rules apply from their next move.
-- Nothing is deleted: actions and dispositions are cancelled with a reason.

INSERT INTO public.permissions (code, description) VALUES
  ('ncr.approve_disposition', 'Approve and cancel approved dispositions of non-conformances (what happens to the affected items)');

WITH grants(key, perms) AS (VALUES
  ('owner',           ARRAY['ncr.approve_disposition']),
  ('admin',           ARRAY['ncr.approve_disposition']),
  ('quality_manager', ARRAY['ncr.approve_disposition'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

ALTER TABLE public.nonconformances
  ADD COLUMN containment_not_needed_reason text CHECK (containment_not_needed_reason IS NULL OR length(trim(containment_not_needed_reason)) BETWEEN 1 AND 500);
GRANT UPDATE (containment_not_needed_reason) ON public.nonconformances TO authenticated;

-- ---------------------------------------------------------------------------
-- Containment actions
-- ---------------------------------------------------------------------------
CREATE TABLE public.ncr_containment_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  nonconformance_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('quarantine', 'sort', 'stop_ship', 'notify_customer', 'notify_supplier', 'recall', 'other')),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 1000),
  owner_employee_id uuid,
  due_date date,
  quantity_contained numeric CHECK (quantity_contained IS NULL OR quantity_contained >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  done_note text CHECK (done_note IS NULL OR length(done_note) <= 2000),
  done_at timestamptz,
  done_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ncr_containment_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT ncr_containment_owner_fkey FOREIGN KEY (owner_employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  CONSTRAINT ncr_containment_done_shape CHECK ((status = 'done') = (done_at IS NOT NULL)),
  CONSTRAINT ncr_containment_cancel_has_reason CHECK (status <> 'cancelled' OR length(trim(coalesce(cancel_reason, ''))) > 0)
);
CREATE INDEX ncr_containment_ncr_idx ON public.ncr_containment_actions (nonconformance_id);

CREATE FUNCTION app.ncr_containment_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.nonconformance_id <> OLD.nonconformance_id THEN
    RAISE EXCEPTION 'A containment action cannot move to another non-conformance' USING ERRCODE = 'QM005';
  END IF;
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  PERFORM app.assert_ncr_editable(NEW.nonconformance_id);
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'open'; NEW.done_at := NULL; NEW.done_by := NULL; NEW.done_note := NULL; NEW.cancel_reason := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'open' AND (NEW.kind, NEW.description, NEW.owner_employee_id, NEW.due_date, NEW.quantity_contained, NEW.done_note, NEW.cancel_reason)
         IS DISTINCT FROM (OLD.kind, OLD.description, OLD.owner_employee_id, OLD.due_date, OLD.quantity_contained, OLD.done_note, OLD.cancel_reason) THEN
      RAISE EXCEPTION 'This containment action is %; reopen it to change it', OLD.status USING ERRCODE = 'QM005';
    END IF;
    IF NEW.done_at IS DISTINCT FROM OLD.done_at OR NEW.done_by IS DISTINCT FROM OLD.done_by THEN
      RAISE EXCEPTION 'Who and when are set by the system' USING ERRCODE = 'QM005';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'done' THEN
    IF length(trim(coalesce(NEW.done_note, ''))) = 0 THEN
      RAISE EXCEPTION 'Say what was done and what was found before marking the action done' USING ERRCODE = 'QM005';
    END IF;
    NEW.done_at := now(); NEW.done_by := auth.uid(); NEW.cancel_reason := NULL;
  ELSIF OLD.status = 'open' AND NEW.status = 'cancelled' THEN
    IF length(trim(coalesce(NEW.cancel_reason, ''))) = 0 THEN
      RAISE EXCEPTION 'Give a reason for cancelling the action' USING ERRCODE = 'QM005';
    END IF;
    NEW.done_at := NULL; NEW.done_by := NULL;
  ELSIF OLD.status IN ('done', 'cancelled') AND NEW.status = 'open' THEN
    NEW.done_at := NULL; NEW.done_by := NULL; NEW.cancel_reason := NULL;
  ELSE
    RAISE EXCEPTION 'A % containment action cannot become %; reopen it first', OLD.status, NEW.status USING ERRCODE = 'QM005';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Dispositions
-- ---------------------------------------------------------------------------
CREATE TABLE public.ncr_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  nonconformance_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('rework', 'repair', 'scrap', 'use_as_is', 'return_to_supplier', 'concession')),
  quantity numeric NOT NULL CHECK (quantity > 0),
  instructions text NOT NULL CHECK (length(trim(instructions)) BETWEEN 1 AND 2000),
  reference text CHECK (reference IS NULL OR length(trim(reference)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'cancelled')),
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  approval_note text CHECK (approval_note IS NULL OR length(approval_note) <= 1000),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ncr_dispositions_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT ncr_dispositions_approved_shape CHECK ((status = 'approved') = (approved_at IS NOT NULL) OR status = 'cancelled'),
  CONSTRAINT ncr_dispositions_cancelled_shape CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL) AND (status <> 'cancelled' OR length(trim(coalesce(cancel_reason, ''))) > 0))
);
CREATE INDEX ncr_dispositions_ncr_idx ON public.ncr_dispositions (nonconformance_id);

/** Quantity already given a live (proposed or approved) disposition on an NC, optionally leaving one out. */
CREATE FUNCTION app.ncr_disposed_quantity(p_ncr_id uuid, p_except uuid DEFAULT NULL) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(sum(quantity), 0) FROM public.ncr_dispositions
   WHERE nonconformance_id = p_ncr_id AND status IN ('proposed', 'approved') AND id IS DISTINCT FROM p_except
$$;

CREATE FUNCTION app.ncr_disposition_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_affected numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.nonconformance_id <> OLD.nonconformance_id THEN
    RAISE EXCEPTION 'A disposition cannot move to another non-conformance' USING ERRCODE = 'QM005';
  END IF;
  IF coalesce(auth.role(), '') <> 'authenticated' AND coalesce(current_setting('app.ncr_disposition_step', true), '') <> 'on' THEN
    RETURN NEW;
  END IF;
  IF coalesce(auth.role(), '') = 'authenticated' AND coalesce(current_setting('app.ncr_disposition_step', true), '') <> 'on' THEN
    PERFORM app.assert_ncr_editable(NEW.nonconformance_id);
    IF TG_OP = 'INSERT' THEN
      NEW.status := 'proposed'; NEW.approved_at := NULL; NEW.approved_by := NULL; NEW.approval_note := NULL;
      NEW.cancelled_at := NULL; NEW.cancelled_by := NULL; NEW.cancel_reason := NULL;
    ELSIF OLD.status <> 'proposed' THEN
      RAISE EXCEPTION 'This disposition is %; only a proposed one can be changed', OLD.status USING ERRCODE = 'QM005';
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'A disposition is approved or cancelled with its own action' USING ERRCODE = 'QM005';
    END IF;
  END IF;
  IF NEW.status IN ('proposed', 'approved') THEN
    SELECT quantity_affected INTO v_affected FROM public.nonconformances WHERE id = NEW.nonconformance_id;
    IF app.ncr_disposed_quantity(NEW.nonconformance_id, NEW.id) + NEW.quantity > coalesce(v_affected, 0) THEN
      RAISE EXCEPTION 'Dispositions would total % but only % are affected (% already covered)',
        app.ncr_disposed_quantity(NEW.nonconformance_id, NEW.id) + NEW.quantity, coalesce(v_affected, 0), app.ncr_disposed_quantity(NEW.nonconformance_id, NEW.id)
        USING ERRCODE = 'QM005';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Approve: a separate step with its own permission.
CREATE FUNCTION app.approve_ncr_disposition(p_id uuid, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.ncr_dispositions%ROWTYPE;
  v_site uuid;
BEGIN
  SELECT * INTO d FROM public.ncr_dispositions WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Disposition not found' USING ERRCODE = 'P0002';
  END IF;
  v_site := app.ncr_site(d.nonconformance_id);
  IF NOT app.has_permission(d.organisation_id, 'ncr.read', v_site) THEN
    RAISE EXCEPTION 'Disposition not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(d.organisation_id, 'ncr.approve_disposition', v_site) THEN
    RAISE EXCEPTION 'Approving a disposition needs the ncr.approve_disposition permission' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_ncr_editable(d.nonconformance_id);
  IF d.status <> 'proposed' THEN
    RAISE EXCEPTION 'This disposition is %; only a proposed one can be approved', d.status USING ERRCODE = 'QM005';
  END IF;
  IF d.decision = 'concession' AND length(trim(coalesce(d.reference, ''))) = 0 THEN
    RAISE EXCEPTION 'A concession needs a reference, such as the customer''s written approval, before it can be approved' USING ERRCODE = 'QM005';
  END IF;
  PERFORM set_config('app.ncr_disposition_step', 'on', true);
  UPDATE public.ncr_dispositions
     SET status = 'approved', approved_at = now(), approved_by = auth.uid(), approval_note = nullif(trim(coalesce(p_note, '')), '')
   WHERE id = p_id;
  PERFORM set_config('app.ncr_disposition_step', '', true);
  PERFORM app.emit_event(d.organisation_id, 'ncr.disposition.approved', 'nonconformance', d.nonconformance_id,
    jsonb_build_object('disposition_id', d.id, 'decision', d.decision, 'quantity', d.quantity, 'reference', d.reference));
END $$;

-- Cancel: a proposed one by anyone who can edit the NC, an approved one only by an approver.
CREATE FUNCTION app.cancel_ncr_disposition(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.ncr_dispositions%ROWTYPE;
  v_site uuid;
  v_reason text := trim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO d FROM public.ncr_dispositions WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Disposition not found' USING ERRCODE = 'P0002';
  END IF;
  v_site := app.ncr_site(d.nonconformance_id);
  IF NOT app.has_permission(d.organisation_id, 'ncr.read', v_site) THEN
    RAISE EXCEPTION 'Disposition not found' USING ERRCODE = 'P0002';
  END IF;
  IF d.status = 'approved' THEN
    IF NOT app.has_permission(d.organisation_id, 'ncr.approve_disposition', v_site) THEN
      RAISE EXCEPTION 'Cancelling an approved disposition needs the ncr.approve_disposition permission' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT app.has_permission(d.organisation_id, 'ncr.update', v_site) THEN
    RAISE EXCEPTION 'Changing non-conformances needs the ncr.update permission' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_ncr_editable(d.nonconformance_id);
  IF d.status = 'cancelled' THEN
    RAISE EXCEPTION 'This disposition is already cancelled' USING ERRCODE = 'QM005';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'Give a reason for cancelling the disposition' USING ERRCODE = 'QM005';
  END IF;
  PERFORM set_config('app.ncr_disposition_step', 'on', true);
  UPDATE public.ncr_dispositions SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason WHERE id = p_id;
  PERFORM set_config('app.ncr_disposition_step', '', true);
END $$;

-- ---------------------------------------------------------------------------
-- Gates: what is still needed to reach a stage. Used by the trigger below and shown to people by the API.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ncr_gate_problems(p_ncr_id uuid, p_target text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n public.nonconformances%ROWTYPE;
  v_open integer; v_done integer; v_proposed integer; v_covered numeric;
  v_problems text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO n FROM public.nonconformances WHERE id = p_ncr_id;
  IF NOT FOUND THEN
    RETURN v_problems;
  END IF;
  IF p_target IN ('contained', 'investigating', 'dispositioned', 'awaiting_closure', 'closed') THEN
    SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
      FROM public.ncr_containment_actions WHERE nonconformance_id = p_ncr_id;
    IF v_open > 0 THEN
      v_problems := array_append(v_problems, format('%s containment %s still open', v_open, CASE WHEN v_open = 1 THEN 'action is' ELSE 'actions are' END));
    ELSIF v_done = 0 AND length(trim(coalesce(n.containment_not_needed_reason, ''))) = 0 THEN
      v_problems := array_append(v_problems, 'record a containment action, or say why none is needed');
    END IF;
  END IF;
  IF p_target IN ('dispositioned', 'awaiting_closure', 'closed') THEN
    SELECT count(*) FILTER (WHERE status = 'proposed'), coalesce(sum(quantity) FILTER (WHERE status = 'approved'), 0) INTO v_proposed, v_covered
      FROM public.ncr_dispositions WHERE nonconformance_id = p_ncr_id;
    IF v_proposed > 0 THEN
      v_problems := array_append(v_problems, format('%s proposed %s still to approve or cancel', v_proposed, CASE WHEN v_proposed = 1 THEN 'disposition is' ELSE 'dispositions are' END));
    END IF;
    IF v_covered < coalesce(n.quantity_affected, 0) THEN
      v_problems := array_append(v_problems, format('approved dispositions cover %s of the %s affected', v_covered, n.quantity_affected));
    END IF;
  END IF;
  RETURN v_problems;
END $$;

CREATE FUNCTION app.ncr_stage_gates() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_problems text[];
  v_disposed numeric;
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF NEW.stage <> OLD.stage AND OLD.stage NOT IN ('draft', 'closed', 'cancelled') AND NEW.stage NOT IN ('draft', 'open', 'cancelled') THEN
    v_problems := app.ncr_gate_problems(NEW.id, NEW.stage);
    IF cardinality(v_problems) > 0 THEN
      RAISE EXCEPTION 'Before this can move to %: %', replace(NEW.stage, '_', ' '), array_to_string(v_problems, '; ') USING ERRCODE = 'QM005';
    END IF;
  END IF;
  IF NEW.quantity_affected IS DISTINCT FROM OLD.quantity_affected THEN
    v_disposed := app.ncr_disposed_quantity(NEW.id);
    IF v_disposed > coalesce(NEW.quantity_affected, 0) THEN
      RAISE EXCEPTION 'Dispositions already cover % items; cancel or reduce them before lowering the quantity affected to %', v_disposed, coalesce(NEW.quantity_affected, 0)
        USING ERRCODE = 'QM005';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nonconformances_stage_gates BEFORE UPDATE ON public.nonconformances FOR EACH ROW EXECUTE FUNCTION app.ncr_stage_gates();
CREATE TRIGGER ncr_containment_rules BEFORE INSERT OR UPDATE ON public.ncr_containment_actions FOR EACH ROW EXECUTE FUNCTION app.ncr_containment_rules();
CREATE TRIGGER ncr_disposition_rules BEFORE INSERT OR UPDATE ON public.ncr_dispositions FOR EACH ROW EXECUTE FUNCTION app.ncr_disposition_rules();

-- Bookkeeping and audit.
CREATE TRIGGER ncr_containment_stamp BEFORE INSERT ON public.ncr_containment_actions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER ncr_dispositions_stamp BEFORE INSERT ON public.ncr_dispositions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER ncr_containment_touch BEFORE UPDATE ON public.ncr_containment_actions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER ncr_dispositions_touch BEFORE UPDATE ON public.ncr_dispositions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.ncr_containment_actions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.ncr_dispositions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- ---------------------------------------------------------------------------
-- Row level security and privileges (site-aware through the parent NCR). Containment and proposals need ncr.update; approval is a function.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ncr_containment_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ncr_dispositions ENABLE ROW LEVEL SECURITY;

CREATE POLICY ncr_containment_select ON public.ncr_containment_actions FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.read', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_containment_insert ON public.ncr_containment_actions FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_containment_update ON public.ncr_containment_actions FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)))
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));

CREATE POLICY ncr_dispositions_select ON public.ncr_dispositions FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.read', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_dispositions_insert ON public.ncr_dispositions FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_dispositions_update ON public.ncr_dispositions FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)))
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));

REVOKE ALL ON public.ncr_containment_actions, public.ncr_dispositions FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ncr_containment_actions, public.ncr_dispositions TO authenticated;
GRANT UPDATE (kind, description, owner_employee_id, due_date, quantity_contained, status, done_note, cancel_reason) ON public.ncr_containment_actions TO authenticated;
GRANT UPDATE (decision, quantity, instructions, reference) ON public.ncr_dispositions TO authenticated;

REVOKE ALL ON FUNCTION app.ncr_containment_rules(), app.ncr_disposition_rules(), app.ncr_stage_gates() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.ncr_disposed_quantity(uuid, uuid), app.approve_ncr_disposition(uuid, text), app.cancel_ncr_disposition(uuid, text), app.ncr_gate_problems(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.approve_ncr_disposition(uuid, text), app.cancel_ncr_disposition(uuid, text), app.ncr_gate_problems(uuid, text) TO authenticated;
