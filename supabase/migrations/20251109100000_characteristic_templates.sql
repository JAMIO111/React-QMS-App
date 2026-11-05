-- Process control: reusable characteristic templates (Settings → Process control).
-- A template holds the content of a control plan characteristic (what is checked, limits or
-- part-specific key, method, gauge type, criticality, SPC, sampling rules and reactions) so it can
-- be picked from a dropdown on a draft revision instead of typed again for every part family.
-- Picking a template copies its values into the characteristic form; nothing links back, so
-- changing or switching off a template never alters an existing (or approved) revision.

CREATE TABLE public.characteristic_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  characteristic_key text NOT NULL CHECK (characteristic_key ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  data_type text NOT NULL DEFAULT 'variable' CHECK (data_type IN ('variable', 'attribute')),
  value_source text NOT NULL DEFAULT 'plan' CHECK (value_source IN ('plan', 'part_spec')),
  nominal numeric,
  lower_limit numeric,
  upper_limit numeric,
  unit_code text REFERENCES public.units (code),
  spec_key text CHECK (spec_key IS NULL OR spec_key ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  method text CHECK (method IS NULL OR length(method) <= 500),
  gauge_type_id uuid,
  criticality text NOT NULL DEFAULT 'minor' CHECK (criticality IN ('critical', 'major', 'minor')),
  spc_eligible boolean NOT NULL DEFAULT false,
  chart_type text CHECK (chart_type IN ('imr', 'xbar_r')),
  subgroup_size integer,
  decimals integer CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 6),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  -- [{ triggerType, intervalValue, sampleSize }] and [{ triggerType, action, instruction }]; validated
  -- again by the API schemas and by the plan tables when the template is used.
  sampling jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sampling) = 'array' AND jsonb_array_length(sampling) <= 8),
  reactions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reactions) = 'array' AND jsonb_array_length(reactions) <= 20),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT characteristic_templates_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT characteristic_templates_gauge_type_fkey FOREIGN KEY (gauge_type_id, organisation_id)
    REFERENCES public.gauge_types (id, organisation_id),
  CONSTRAINT characteristic_templates_values CHECK (
    CASE
      WHEN data_type = 'attribute' THEN
        value_source = 'plan' AND unit_code IS NULL AND nominal IS NULL AND lower_limit IS NULL
        AND upper_limit IS NULL AND spec_key IS NULL AND NOT spc_eligible
      WHEN value_source = 'plan' THEN
        unit_code IS NOT NULL AND spec_key IS NULL AND (lower_limit IS NOT NULL OR upper_limit IS NOT NULL)
        AND (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
        AND (nominal IS NULL OR ((lower_limit IS NULL OR nominal >= lower_limit) AND (upper_limit IS NULL OR nominal <= upper_limit)))
      ELSE
        unit_code IS NOT NULL AND spec_key IS NOT NULL AND nominal IS NULL AND lower_limit IS NULL AND upper_limit IS NULL
    END),
  CONSTRAINT characteristic_templates_spc CHECK (
    CASE WHEN spc_eligible THEN
      (chart_type = 'imr' AND subgroup_size = 1) OR (chart_type = 'xbar_r' AND subgroup_size BETWEEN 2 AND 10)
    ELSE chart_type IS NULL AND subgroup_size IS NULL END)
);
CREATE UNIQUE INDEX characteristic_templates_name_key ON public.characteristic_templates (organisation_id, upper(name));

CREATE TRIGGER characteristic_templates_stamp BEFORE INSERT ON public.characteristic_templates
  FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER characteristic_templates_touch BEFORE UPDATE ON public.characteristic_templates
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER characteristic_templates_org_immutable BEFORE UPDATE ON public.characteristic_templates
  FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.characteristic_templates
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.characteristic_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.characteristic_templates FROM anon, authenticated;
GRANT SELECT, INSERT ON public.characteristic_templates TO authenticated;
GRANT UPDATE (name, description, characteristic_key, data_type, value_source, nominal, lower_limit, upper_limit, unit_code,
              spec_key, method, gauge_type_id, criticality, spc_eligible, chart_type, subgroup_size, decimals, notes,
              sampling, reactions, active)
  ON public.characteristic_templates TO authenticated;

CREATE POLICY characteristic_templates_select ON public.characteristic_templates FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'process_control.read'));
CREATE POLICY characteristic_templates_insert ON public.characteristic_templates FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'process_control.manage'));
CREATE POLICY characteristic_templates_update ON public.characteristic_templates FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'process_control.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'process_control.manage'));
