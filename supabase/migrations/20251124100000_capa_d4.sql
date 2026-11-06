-- CAPA3 (docs/capa-8d-plan.md): D4 root cause.
--
--  * `capa_root_causes`: why the problem occurred, why it escaped detection, and the systemic cause (kind occurrence / escape / systemic). A cause is
--    verified (how, and a note) before anyone acts on it; verifying is stamped by the database. Changing the words or the kind of a VERIFIED cause
--    withdraws its verification (it must be verified again). A cause can come from an analysis (`source_analysis_id`: an Ishikawa diagram or a 5 Whys
--    chain, both saved as `capa_analyses`, whose table already allows their kinds). Removing a cause marks it deleted; nothing is ever deleted.
--  * D4 needs at least one occurrence cause and every cause verified. An escape cause is advised, not required.
--  * An 8D is a fluid document: completing D4 locks nothing.

CREATE TABLE public.capa_root_causes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  capa_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('occurrence', 'escape', 'systemic')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  source_analysis_id uuid,
  verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  verified_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  verification_method text CHECK (verification_method IS NULL OR length(btrim(verification_method)) BETWEEN 1 AND 200),
  verification_note text CHECK (verification_note IS NULL OR length(btrim(verification_note)) BETWEEN 1 AND 2000),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT capa_root_causes_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT capa_root_causes_analysis_fkey FOREIGN KEY (source_analysis_id, organisation_id) REFERENCES public.capa_analyses (id, organisation_id),
  CONSTRAINT capa_root_causes_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT capa_root_causes_verified_stamped CHECK (verified = (verified_at IS NOT NULL))
);
CREATE INDEX capa_root_causes_capa_idx ON public.capa_root_causes (capa_id) WHERE deleted_at IS NULL;

CREATE FUNCTION app.capa_root_cause_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_stage text;
BEGIN
  SELECT stage INTO v_stage FROM public.capas WHERE id = NEW.capa_id;
  IF v_stage IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'This 8D is %; reopen it to change its root causes', v_stage USING ERRCODE = 'QM013';
  END IF;
  IF NEW.source_analysis_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.source_analysis_id IS DISTINCT FROM OLD.source_analysis_id)
     AND NOT EXISTS (SELECT 1 FROM public.capa_analyses a WHERE a.id = NEW.source_analysis_id AND a.capa_id = NEW.capa_id AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'That analysis is not part of this 8D' USING ERRCODE = 'QM013';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.deleted_at := NULL; NEW.deleted_by := NULL;
    IF NEW.verified THEN
      IF NEW.verification_method IS NULL THEN
        RAISE EXCEPTION 'Say how the root cause was verified' USING ERRCODE = 'QM013';
      END IF;
      NEW.verified_at := now(); NEW.verified_by := auth.uid();
    ELSE
      NEW.verified_at := NULL; NEW.verified_by := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.capa_id <> OLD.capa_id OR NEW.source_analysis_id IS DISTINCT FROM OLD.source_analysis_id THEN
    RAISE EXCEPTION 'A root cause cannot be moved to another 8D or analysis' USING ERRCODE = 'QM013';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.description <> OLD.description OR NEW.kind <> OLD.kind OR NEW.verified <> OLD.verified) THEN
    RAISE EXCEPTION 'A removed root cause stays removed' USING ERRCODE = 'QM013';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    NEW.deleted_at := now(); NEW.deleted_by := auth.uid();
  END IF;
  -- Verification: stamped by the database; changing a verified cause's words or kind withdraws it.
  IF OLD.verified AND NEW.verified AND (NEW.description <> OLD.description OR NEW.kind <> OLD.kind) THEN
    NEW.verified := false;
  END IF;
  IF NEW.verified AND NOT OLD.verified THEN
    IF NEW.verification_method IS NULL THEN
      RAISE EXCEPTION 'Say how the root cause was verified' USING ERRCODE = 'QM013';
    END IF;
    NEW.verified_at := now(); NEW.verified_by := auth.uid();
  ELSIF NEW.verified AND OLD.verified THEN
    NEW.verified_at := OLD.verified_at; NEW.verified_by := OLD.verified_by;
  ELSE
    NEW.verified_at := NULL; NEW.verified_by := NULL;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text := 'capa_root_causes';
BEGIN
  EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
  EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t);
  EXECUTE format('CREATE TRIGGER %1$s_org_immutable BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t);
  EXECUTE format('CREATE TRIGGER %1$s_no_delete BEFORE DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.capa_children_no_delete()', t);
  EXECUTE format('CREATE TRIGGER %1$s_rules BEFORE INSERT OR UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.capa_root_cause_rules()', t);
  EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  EXECUTE format('GRANT SELECT, INSERT ON public.%I TO authenticated', t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id))', t || '_select', t);
  EXECUTE format('CREATE POLICY %1$I ON public.%2$I FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, ''capa.manage'') AND EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id AND c.organisation_id = %2$I.organisation_id))', t || '_insert', t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (app.has_permission(organisation_id, ''capa.manage'')) WITH CHECK (app.has_permission(organisation_id, ''capa.manage''))', t || '_update', t);
END $$;
GRANT UPDATE (kind, description, verified, verification_method, verification_note, deleted_at) ON public.capa_root_causes TO authenticated;

-- ---------------------------------------------------------------------------
-- What D4 still needs: one occurrence cause at least, and every cause verified. D5 to D8 arrive later.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.capa_step_problems(p_capa uuid, p_step text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; v_problems text[] := ARRAY[]::text[]; v_leaders integer; v_people integer; v_open integer; v_done integer; v_occurrence integer; v_unverified integer;
BEGIN
  SELECT * INTO c FROM public.capas WHERE id = p_capa;
  IF NOT FOUND OR NOT app.has_permission(c.organisation_id, 'capa.read') THEN
    RAISE EXCEPTION '8D not found' USING ERRCODE = 'QM013';
  END IF;
  CASE p_step
    WHEN 'd0' THEN
      IF c.problem_statement IS NULL THEN v_problems := array_append(v_problems, 'Describe the problem in the problem statement'); END IF;
    WHEN 'd1' THEN
      SELECT count(*) FILTER (WHERE role = 'leader'), count(*) INTO v_leaders, v_people
        FROM public.capa_team_members WHERE capa_id = p_capa AND ended_at IS NULL;
      IF v_leaders = 0 THEN v_problems := array_append(v_problems, 'Name a team leader'); END IF;
      IF v_people < 2 THEN v_problems := array_append(v_problems, 'Add at least two people to the team'); END IF;
    WHEN 'd2' THEN
      IF c.d2_what IS NULL THEN v_problems := array_append(v_problems, 'Say what is wrong (the What of 5W2H)'); END IF;
      IF c.d2_where IS NULL THEN v_problems := array_append(v_problems, 'Say where it was found (the Where of 5W2H)'); END IF;
      IF c.d2_when IS NULL THEN v_problems := array_append(v_problems, 'Say when it was found (the When of 5W2H)'); END IF;
    WHEN 'd3' THEN
      SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
        FROM public.capa_actions WHERE capa_id = p_capa AND phase = 'interim';
      IF v_open > 0 THEN
        v_problems := array_append(v_problems, format('Finish or cancel the %s open containment %s', v_open, CASE WHEN v_open = 1 THEN 'action' ELSE 'actions' END));
      END IF;
      IF v_done = 0 AND c.d3_no_containment_reason IS NULL THEN
        v_problems := array_append(v_problems, 'Add an interim containment action, or say why none is needed');
      END IF;
    WHEN 'd4' THEN
      SELECT count(*) FILTER (WHERE kind = 'occurrence'), count(*) FILTER (WHERE NOT verified) INTO v_occurrence, v_unverified
        FROM public.capa_root_causes WHERE capa_id = p_capa AND deleted_at IS NULL;
      IF v_occurrence = 0 THEN
        v_problems := array_append(v_problems, 'Record at least one occurrence root cause (why the problem happened)');
      END IF;
      IF v_unverified > 0 THEN
        v_problems := array_append(v_problems, format('Verify the %s root %s not yet verified', v_unverified, CASE WHEN v_unverified = 1 THEN 'cause' ELSE 'causes' END));
      END IF;
    ELSE
      v_problems := array_append(v_problems, 'This step is not available yet');
  END CASE;
  RETURN v_problems;
END $$;

REVOKE ALL ON FUNCTION app.capa_root_cause_rules(), app.capa_step_problems(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.capa_step_problems(uuid, text) TO authenticated;
