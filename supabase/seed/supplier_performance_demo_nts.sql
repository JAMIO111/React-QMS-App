-- Demo data for the Performance tab of supplier NTS (National Tube Stockholders Limited).
-- Four purchase orders over the last ~90 days for four of our parts, deliveries against them (some late, one partial, one open past due,
-- one agreed-date change), dispositions (one rejected, one conditional) and non-conformances raised from the receipt lines.
-- Runs through the real functions as the first active member of the organisation, so every rule and audit record applies.
-- Safe to run twice: it stops when order NTS-DEMO-101 already exists. Test data only.
DO $seed$
DECLARE
  v_sup uuid; v_org uuid; v_user uuid; v_site uuid;
  p405251 uuid; p408237 uuid; p427618 uuid; p427665 uuid;
  c_prod uuid; c_mat uuid;
  po1 uuid; po2 uuid; po3 uuid; po4 uuid;
  r jsonb; v_rec uuid; ln record; v_line uuid; v_ncr jsonb;
BEGIN
  SELECT id, organisation_id INTO v_sup, v_org FROM public.suppliers WHERE display_name = 'NTS' ORDER BY created_at LIMIT 1;
  IF v_sup IS NULL THEN RAISE EXCEPTION 'No supplier with the short name NTS'; END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE organisation_id = v_org AND po_number = 'NTS-DEMO-101') THEN RAISE NOTICE 'Demo orders already exist; nothing done'; RETURN; END IF;
  SELECT user_id INTO v_user FROM public.organisation_users WHERE organisation_id = v_org AND status = 'active' ORDER BY created_at LIMIT 1;
  SELECT id INTO v_site FROM public.sites WHERE organisation_id = v_org AND code = 'MAIN';
  SELECT id INTO p405251 FROM public.parts WHERE organisation_id = v_org AND part_number = '405251';
  SELECT id INTO p408237 FROM public.parts WHERE organisation_id = v_org AND part_number = '408237';
  SELECT id INTO p427618 FROM public.parts WHERE organisation_id = v_org AND part_number = '427618';
  SELECT id INTO p427665 FROM public.parts WHERE organisation_id = v_org AND part_number = '427665';
  SELECT id INTO c_prod FROM public.ncr_classifications WHERE organisation_id = v_org AND kind = 'category' AND code = 'PRODUCT';
  SELECT id INTO c_mat FROM public.ncr_classifications WHERE organisation_id = v_org AND kind = 'category' AND code = 'MATERIAL';

  -- act as the member, through the same checks the app uses
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  SET LOCAL ROLE authenticated;

  po1 := app.create_purchase_order(v_sup, 'NTS-DEMO-101', current_date - 85, 'Demo: first quarter call-off', jsonb_build_array(
    jsonb_build_object('partId', p405251, 'quantity', 2000, 'unit', 'pcs', 'requestedOn', current_date - 71),
    jsonb_build_object('partId', p408237, 'quantity', 1500, 'unit', 'pcs', 'requestedOn', current_date - 71)));
  po2 := app.create_purchase_order(v_sup, 'NTS-DEMO-102', current_date - 57, 'Demo', jsonb_build_array(
    jsonb_build_object('partId', p427618, 'quantity', 3000, 'unit', 'pcs', 'requestedOn', current_date - 43),
    jsonb_build_object('partId', p427665, 'quantity', 1000, 'unit', 'pcs', 'requestedOn', current_date - 43, 'agreedOn', current_date - 36)));
  po3 := app.create_purchase_order(v_sup, 'NTS-DEMO-103', current_date - 36, 'Demo', jsonb_build_array(
    jsonb_build_object('partId', p405251, 'quantity', 2500, 'unit', 'pcs', 'requestedOn', current_date - 22),
    jsonb_build_object('partId', p408237, 'quantity', 1200, 'unit', 'pcs', 'requestedOn', current_date - 22),
    jsonb_build_object('partId', p427618, 'quantity', 2000, 'unit', 'pcs', 'requestedOn', current_date - 15),
    jsonb_build_object('partId', p427665, 'quantity', 150, 'unit', 'pcs', 'requestedOn', current_date - 22)));
  po4 := app.create_purchase_order(v_sup, 'NTS-DEMO-104', current_date - 15, 'Demo', jsonb_build_array(
    jsonb_build_object('partId', p427665, 'quantity', 1500, 'unit', 'pcs', 'requestedOn', current_date - 6),
    jsonb_build_object('partId', p405251, 'quantity', 2000, 'unit', 'pcs', 'requestedOn', current_date + 8),
    jsonb_build_object('partId', p408237, 'quantity', 1000, 'unit', 'pcs', 'requestedOn', current_date - 7)));

  -- PO 101: one line on time, one three days late
  r := app.record_goods_receipt(v_sup, po1, v_site, current_date - 71, 'DN-48110', NULL, (SELECT jsonb_build_array(jsonb_build_object('poLineId', id, 'quantity', 2000, 'lotNumber', 'NTS-L-4101')) FROM public.purchase_order_lines WHERE purchase_order_id = po1 AND line_number = 1), NULL);
  r := app.record_goods_receipt(v_sup, po1, v_site, current_date - 68, 'DN-48127', NULL, (SELECT jsonb_build_array(jsonb_build_object('poLineId', id, 'quantity', 1500, 'lotNumber', 'NTS-L-4102')) FROM public.purchase_order_lines WHERE purchase_order_id = po1 AND line_number = 2), NULL);
  -- PO 102: one on time, one on the agreed (later) date
  r := app.record_goods_receipt(v_sup, po2, v_site, current_date - 43, 'DN-48302', NULL, (SELECT jsonb_build_array(jsonb_build_object('poLineId', id, 'quantity', 3000, 'lotNumber', 'NTS-L-4201')) FROM public.purchase_order_lines WHERE purchase_order_id = po2 AND line_number = 1), NULL);
  r := app.record_goods_receipt(v_sup, po2, v_site, current_date - 36, 'DN-48350', NULL, (SELECT jsonb_build_array(jsonb_build_object('poLineId', id, 'quantity', 1000, 'lotNumber', 'NTS-L-4202')) FROM public.purchase_order_lines WHERE purchase_order_id = po2 AND line_number = 2), NULL);
  -- PO 103: two on time (one of them small and later rejected), one 4 days late, one part-delivered
  r := app.record_goods_receipt(v_sup, po3, v_site, current_date - 22, 'DN-48611', NULL, (SELECT jsonb_agg(jsonb_build_object('poLineId', id, 'quantity', quantity_ordered, 'lotNumber', CASE line_number WHEN 1 THEN 'NTS-L-4301' ELSE 'NTS-L-4304' END)) FROM public.purchase_order_lines WHERE purchase_order_id = po3 AND line_number IN (1, 4)), NULL);
  r := app.record_goods_receipt(v_sup, po3, v_site, current_date - 18, 'DN-48640', NULL, (SELECT jsonb_build_array(jsonb_build_object('poLineId', id, 'quantity', 1200, 'lotNumber', 'NTS-L-4302')) FROM public.purchase_order_lines WHERE purchase_order_id = po3 AND line_number = 2), NULL);
  r := app.record_goods_receipt(v_sup, po3, v_site, current_date - 15, 'DN-48655', 'Short shipment, balance to follow', (SELECT jsonb_build_array(jsonb_build_object('poLineId', id, 'quantity', 1200, 'lotNumber', 'NTS-L-4303')) FROM public.purchase_order_lines WHERE purchase_order_id = po3 AND line_number = 3), NULL);
  -- PO 104: one on time; the rest still open (one already past due)
  r := app.record_goods_receipt(v_sup, po4, v_site, current_date - 6, 'DN-48790', NULL, (SELECT jsonb_build_array(jsonb_build_object('poLineId', id, 'quantity', 1500, 'lotNumber', 'NTS-L-4401')) FROM public.purchase_order_lines WHERE purchase_order_id = po4 AND line_number = 1), NULL);

  -- Decisions: most accepted, one rejected, one conditional
  FOR ln IN SELECT l.id, lt.lot_number FROM public.goods_receipt_lines l JOIN public.lots lt ON lt.id = l.lot_id WHERE l.organisation_id = v_org AND lt.lot_number LIKE 'NTS-L-%' LOOP
    IF ln.lot_number = 'NTS-L-4304' THEN PERFORM app.disposition_receipt_line(ln.id, 'rejected', 'Wall thickness out of tolerance on 9 of 13 sampled', NULL);
    ELSIF ln.lot_number = 'NTS-L-4202' THEN PERFORM app.disposition_receipt_line(ln.id, 'conditional', 'Surface marks within cosmetic limit', 'Skim 0.2 mm on arrival; sample every tenth piece');
    ELSE PERFORM app.disposition_receipt_line(ln.id, 'accepted', NULL, NULL);
    END IF;
  END LOOP;

  -- Non-conformances from the receipt lines (427665 gets two, so the repeat count shows)
  FOR ln IN SELECT l.id, lt.lot_number FROM public.goods_receipt_lines l JOIN public.lots lt ON lt.id = l.lot_id WHERE l.organisation_id = v_org AND lt.lot_number IN ('NTS-L-4304', 'NTS-L-4202', 'NTS-L-4302', 'NTS-L-4401') LOOP
    IF ln.lot_number = 'NTS-L-4304' THEN v_ncr := app.raise_ncr_from_receipt_line(ln.id, 'Tube wall thickness below minimum', 'Wall thickness measured at 3.1 mm against a 3.5 mm minimum on 9 of 13 sampled pieces.', 'major', c_prod, NULL);
    ELSIF ln.lot_number = 'NTS-L-4202' THEN v_ncr := app.raise_ncr_from_receipt_line(ln.id, 'Surface marks on tube bore', 'Handling marks along the bore, within the cosmetic limit but above what we normally receive.', 'minor', c_prod, 40);
    ELSIF ln.lot_number = 'NTS-L-4302' THEN v_ncr := app.raise_ncr_from_receipt_line(ln.id, 'Mill certificate missing heat number', 'Certificate supplied without a heat number, so the lot cannot be traced to the melt.', 'minor', c_mat, NULL);
    ELSE v_ncr := app.raise_ncr_from_receipt_line(ln.id, 'Damaged packaging on arrival', 'Two crates split in transit; tubes scored along the outer diameter.', 'minor', c_prod, 60);
    END IF;
  END LOOP;

  RESET ROLE;
END
$seed$;
