-- Return authorisations (RMA) for customer non-conformances.
--
--  * A new disposition decision `customer_return`: the customer sends the parts (all or part of the quantity affected) back under an RMA number.
--  * It is made only by app.generate_ncr_rma(ncr, quantity, instructions?, lot?) (`ncr.update` at the NC's site): the NC's source must be `customer`; the
--    database gives the number (`RMA-YY-NNNN`, per organisation and year, never reused) and stores it as the disposition's reference. It is a disposition
--    like any other: proposed, counted against the quantity affected, approved by an approver, cancelled with a reason.
--  * The decision and the number of a customer return never change, and no other disposition can be turned into one (trigger, for SQL too).
-- Errors use QM005 (409 ncr_rule).

ALTER TABLE public.ncr_dispositions DROP CONSTRAINT ncr_dispositions_decision_check;
ALTER TABLE public.ncr_dispositions ADD CONSTRAINT ncr_dispositions_decision_check
  CHECK (decision IN ('rework', 'repair', 'scrap', 'use_as_is', 'return_to_supplier', 'concession', 'customer_return'));

-- One RMA number, once, per organisation.
CREATE UNIQUE INDEX ncr_dispositions_rma_key ON public.ncr_dispositions (organisation_id, upper(reference)) WHERE decision = 'customer_return';

CREATE TABLE app.ncr_rma_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON app.ncr_rma_counters FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.ncr_rma_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_inside boolean := coalesce(current_setting('app.ncr_rma', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.decision = 'customer_return' AND NOT v_inside THEN
      RAISE EXCEPTION 'A customer return is made with "Generate an RMA number", which gives it its number' USING ERRCODE = 'QM005';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.decision = 'customer_return') <> (NEW.decision = 'customer_return') THEN
    RAISE EXCEPTION 'A customer return keeps its decision, and no other disposition can become one. Cancel it and make another.' USING ERRCODE = 'QM005';
  END IF;
  IF OLD.decision = 'customer_return' AND NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'An RMA number never changes' USING ERRCODE = 'QM005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ncr_dispositions_rma_rules BEFORE INSERT OR UPDATE ON public.ncr_dispositions FOR EACH ROW EXECUTE FUNCTION app.ncr_rma_rules();

-- Generates the next RMA number and proposes the customer return for p_quantity of the affected items. Returns the disposition's id.
CREATE FUNCTION app.generate_ncr_rma(p_ncr uuid, p_quantity numeric, p_instructions text DEFAULT NULL, p_lot uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n public.nonconformances%ROWTYPE; v_year integer := extract(year FROM current_date)::integer; v_n integer; v_number text; v_id uuid;
  v_instructions text := nullif(btrim(coalesce(p_instructions, '')), '');
BEGIN
  SELECT * INTO n FROM public.nonconformances WHERE id = p_ncr;
  IF NOT FOUND OR NOT app.has_permission(n.organisation_id, 'ncr.read', n.site_id) THEN RAISE EXCEPTION 'Non-conformance not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(n.organisation_id, 'ncr.update', n.site_id) THEN
    RAISE EXCEPTION 'You are not allowed to change this non-conformance' USING ERRCODE = '42501';
  END IF;
  IF n.source <> 'customer' THEN
    RAISE EXCEPTION 'An RMA number is for a non-conformance whose source is the customer' USING ERRCODE = 'QM005';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Say how many are coming back (above 0)' USING ERRCODE = 'QM005'; END IF;
  IF v_instructions IS NOT NULL AND length(v_instructions) > 2000 THEN RAISE EXCEPTION 'The instructions are up to 2000 characters' USING ERRCODE = 'QM005'; END IF;
  PERFORM app.assert_ncr_editable(n.id);
  INSERT INTO app.ncr_rma_counters AS c (organisation_id, year, last_value) VALUES (n.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  v_number := 'RMA-' || to_char(v_year % 100, 'FM00') || '-' || lpad(v_n::text, 4, '0');
  PERFORM set_config('app.ncr_rma', 'on', true);
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, reference, lot_id)
  VALUES (n.organisation_id, n.id, 'customer_return', p_quantity, coalesce(v_instructions, 'Customer to return the parts under ' || v_number), v_number, p_lot)
  RETURNING id INTO v_id;
  PERFORM set_config('app.ncr_rma', '', true);
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.ncr_rma_rules() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.generate_ncr_rma(uuid, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.generate_ncr_rma(uuid, numeric, text, uuid) TO authenticated;
