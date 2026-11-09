import { useState } from "react";
import { useSupplierPerformanceSettings } from "../../hooks/useSupplierPerformance";
import { usePerformanceMutation } from "../../hooks/useSupplierPerformance";
import { OTD_POLICIES, ppmBasisLabel } from "../../lib/supplierPerformance";
import CTAButton from "../CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice, FormError } from "../master-data/shared";

const blank = (v) => (v === null || v === undefined ? "" : String(v));
const toNum = (v) => (v === "" ? null : Number(v));

/** This supplier's own date policy, grace days and in-full tolerances. An empty field follows the organisation's model. */
const SettingsDialog = ({ supplier, settings, onClose }) => {
  const mutation = usePerformanceMutation();
  const o = settings.overrides;
  const e = settings.effective;
  const [policy, setPolicy] = useState(o.otdPolicy);
  const [before, setBefore] = useState(blank(o.graceDaysBefore));
  const [after, setAfter] = useState(blank(o.graceDaysAfter));
  const [under, setUnder] = useState(blank(o.inFullUnderPct));
  const [over, setOver] = useState(blank(o.inFullOverPct));
  const body = { otdPolicy: policy, graceDaysBefore: toNum(before), graceDaysAfter: toNum(after), inFullUnderPct: toNum(under), inFullOverPct: toNum(over) };
  const bad = [body.graceDaysBefore, body.graceDaysAfter].some((n) => n !== null && (!Number.isInteger(n) || n < 0 || n > 60)) || [body.inFullUnderPct, body.inFullOverPct].some((n) => n !== null && (n < 0 || n > 100));
  const org = settings.modelVersion;
  return (
    <Dialog title={`Scoring settings for ${supplier.displayName || supplier.name}`} onClose={onClose} width="max-w-lg">
      <form noValidate className="flex flex-col gap-3" onSubmit={(ev) => { ev.preventDefault(); if (!bad && !mutation.isPending) mutation.mutate({ action: "saveSupplierSettings", id: supplier.id, dialog: true, body }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">Leave a field empty to follow the organisation&apos;s model (version {org}). Saved scorecards keep the settings they were scored with. To allow no early-delivery limit when the organisation sets one, enter 60.</p>
        <ComboField label="On-time delivery is judged against" value={policy} onChange={setPolicy} options={OTD_POLICIES} clearable placeholder={`Follow the model (${OTD_POLICIES.find((p) => p.value === e.otdPolicy)?.label.toLowerCase()})`} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Days early that still count" type="number" min="0" max="60" value={before} onChange={(ev) => setBefore(ev.target.value)} placeholder={e.graceDaysBefore === null ? "No limit" : String(e.graceDaysBefore)} />
          <Field label="Days late that still count" type="number" min="0" max="60" value={after} onChange={(ev) => setAfter(ev.target.value)} placeholder={String(e.graceDaysAfter)} />
          <Field label="In full: % below the ordered quantity" type="number" min="0" max="100" step="any" value={under} onChange={(ev) => setUnder(ev.target.value)} placeholder={String(e.inFullUnderPct)} />
          <Field label="In full: % above the ordered quantity" type="number" min="0" max="100" step="any" value={over} onChange={(ev) => setOver(ev.target.value)} placeholder={String(e.inFullOverPct)} />
        </div>
        {bad && <p className="text-sm text-error-color" role="alert">Grace days are whole numbers from 0 to 60 and tolerances are percentages from 0 to 100.</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={bad || mutation.isPending}>{mutation.isPending ? "Saving…" : "Save settings"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** On the supplier's Performance tab: what it is scored with, and which of that is its own. */
export default function SupplierScoringSettings({ supplier, canConfigure }) {
  const query = useSupplierPerformanceSettings(supplier.id);
  const [open, setOpen] = useState(false);
  if (query.error) return <ErrorNotice error={query.error} />;
  const s = query.data;
  if (!s) return null;
  const e = s.effective;
  const own = (k) => (s.overrides[k] !== null ? " (this supplier)" : "");
  return (
    <MenuCard
      title="How this supplier is scored"
      subtitle="The organisation's scoring model, with anything set for this supplier on top."
      action={canConfigure && <CTAButton buttonType="button" type="secondary" size="default" onClick={() => setOpen(true)}>Change</CTAButton>}>
      <ul className="flex flex-col gap-1 text-sm text-primary-text" aria-label="Scoring settings in force">
        <li>On-time against the {OTD_POLICIES.find((p) => p.value === e.otdPolicy)?.label.toLowerCase()}{own("otdPolicy")}</li>
        <li>{e.graceDaysBefore === null ? "Any early delivery counts as on time" : `Up to ${e.graceDaysBefore} days early counts as on time`}{own("graceDaysBefore")}</li>
        <li>Up to {e.graceDaysAfter} days late counts as on time{own("graceDaysAfter")}</li>
        <li>In full: {e.inFullUnderPct}% under{own("inFullUnderPct")} to {e.inFullOverPct}% over{own("inFullOverPct")} the ordered quantity</li>
        <li>PPM that scores: {ppmBasisLabel(e.ppmBasis).toLowerCase()} (set for the organisation)</li>
      </ul>
      {open && <SettingsDialog supplier={supplier} settings={s} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
}
