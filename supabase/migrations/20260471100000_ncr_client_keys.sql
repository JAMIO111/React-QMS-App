-- NC module audit (docs/audit-nc-2026-11.md), API-13: a double click or a retry duplicated what it created. A non-conformance, a cost line, a disposition or an
-- RMA number was made twice (money counted twice, an RMA number burnt). A create may now carry a client key, made once by the screen when it opens and kept
-- across retries: the same key again answers the record it already made instead of making another.
--
-- The key is optional (imports, scripts and older callers send none), unique per organisation, written only when the record is made and never changed
-- (the UPDATE grants of these tables are column by column and do not list it). The API looks the key up first and treats the unique index as the backstop
-- for two retries that arrive together. For an RMA the number is taken inside the function, so a retry that finds its key answers before taking a number,
-- and one that loses a race on the index rolls its number back with the rest of its transaction.

ALTER TABLE public.nonconformances ADD COLUMN IF NOT EXISTS client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 100);
ALTER TABLE public.ncr_costs ADD COLUMN IF NOT EXISTS client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 100);
ALTER TABLE public.ncr_dispositions ADD COLUMN IF NOT EXISTS client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 100);

CREATE UNIQUE INDEX IF NOT EXISTS nonconformances_client_key ON public.nonconformances (organisation_id, client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ncr_costs_client_key ON public.ncr_costs (organisation_id, client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ncr_dispositions_client_key ON public.ncr_dispositions (organisation_id, client_key) WHERE client_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- app.generate_ncr_rma gains p_client_key. It is rewritten from its live text (the numbering migration changed its padding), with each change checked to
-- apply exactly once; running this again does nothing.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_old regprocedure := 'app.generate_ncr_rma(uuid, numeric, text, uuid)'::regprocedure;
  v_def text;
  v_n integer;
  PROCEDURE_ANCHOR constant text := 'p_lot uuid DEFAULT NULL::uuid)';
BEGIN
  IF to_regprocedure('app.generate_ncr_rma(uuid, numeric, text, uuid, text)') IS NOT NULL THEN
    RETURN;
  END IF;
  v_def := replace(pg_get_functiondef(v_old), E'\r', '');

  -- 1. The new argument.
  v_n := (length(v_def) - length(replace(v_def, PROCEDURE_ANCHOR, ''))) / length(PROCEDURE_ANCHOR);
  IF v_n <> 1 THEN RAISE EXCEPTION 'generate_ncr_rma: expected the argument list once, found % times', v_n; END IF;
  v_def := replace(v_def, PROCEDURE_ANCHOR, 'p_lot uuid DEFAULT NULL::uuid, p_client_key text DEFAULT NULL::text)');

  -- 2. A retry with the same key answers the disposition already made (checked before a number is taken). A key belonging to another non-conformance is refused.
  v_n := (length(v_def) - length(replace(v_def, 'IF p_quantity IS NULL OR p_quantity <= 0 THEN', ''))) / length('IF p_quantity IS NULL OR p_quantity <= 0 THEN');
  IF v_n <> 1 THEN RAISE EXCEPTION 'generate_ncr_rma: expected the quantity check once, found % times', v_n; END IF;
  v_def := replace(v_def, 'IF p_quantity IS NULL OR p_quantity <= 0 THEN',
    E'IF p_client_key IS NOT NULL THEN\n'
    || E'    SELECT d.id INTO v_id FROM public.ncr_dispositions d WHERE d.organisation_id = n.organisation_id AND d.client_key = p_client_key AND d.nonconformance_id = n.id;\n'
    || E'    IF FOUND THEN RETURN v_id; END IF;\n'
    || E'    IF EXISTS (SELECT 1 FROM public.ncr_dispositions d WHERE d.organisation_id = n.organisation_id AND d.client_key = p_client_key) THEN\n'
    || E'      RAISE EXCEPTION ''That client key was used for another record'' USING ERRCODE = ''QM005'';\n'
    || E'    END IF;\n'
    || E'  END IF;\n'
    || E'  IF p_quantity IS NULL OR p_quantity <= 0 THEN');

  -- 3. The key is kept on the disposition it makes.
  v_n := (length(v_def) - length(replace(v_def, '(organisation_id, nonconformance_id, decision, quantity, instructions, reference, lot_id)', '')))
         / length('(organisation_id, nonconformance_id, decision, quantity, instructions, reference, lot_id)');
  IF v_n <> 1 THEN RAISE EXCEPTION 'generate_ncr_rma: expected the insert column list once, found % times', v_n; END IF;
  v_def := replace(v_def, '(organisation_id, nonconformance_id, decision, quantity, instructions, reference, lot_id)',
                          '(organisation_id, nonconformance_id, decision, quantity, instructions, reference, lot_id, client_key)');
  v_n := (length(v_def) - length(replace(v_def, 'v_number, p_lot)', ''))) / length('v_number, p_lot)');
  IF v_n <> 1 THEN RAISE EXCEPTION 'generate_ncr_rma: expected the insert values once, found % times', v_n; END IF;
  v_def := replace(v_def, 'v_number, p_lot)', 'v_number, p_lot, p_client_key)');

  EXECUTE v_def;
  DROP FUNCTION app.generate_ncr_rma(uuid, numeric, text, uuid);
  REVOKE ALL ON FUNCTION app.generate_ncr_rma(uuid, numeric, text, uuid, text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION app.generate_ncr_rma(uuid, numeric, text, uuid, text) TO authenticated;
END $$;
