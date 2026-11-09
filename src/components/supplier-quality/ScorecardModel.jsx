import { useState } from "react";
import { usePerformanceMutation, useScorecardModel } from "../../hooks/useSupplierPerformance";
import { formatDateTime } from "../../lib/processControl";
import { METRIC_LABELS, METRIC_ORDER, OTD_POLICIES, PPM_BASES, WEIGHT_KEY, ppmBasisLabel } from "../../lib/supplierPerformance";
import CTAButton from "../CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";

const num = (v) => (v === "" ? NaN : Number(v));

/** A new version of the scoring model: date policy and grace days, in-full tolerance, which PPM scores, weights, PPM targets, NC penalties, bands and the minimum data. The reason is kept with it. */
const ModelDialog = ({ model, onClose }) => {
  const mutation = usePerformanceMutation();
  const c = model.config;
  const [policy, setPolicy] = useState(c.otdPolicy);
  const [graceBefore, setGraceBefore] = useState(c.graceDaysBefore === null || c.graceDaysBefore === undefined ? "" : String(c.graceDaysBefore));
  const [graceAfter, setGraceAfter] = useState(String(c.graceDaysAfter ?? 0));
  const [under, setUnder] = useState(String(c.inFullUnderPct ?? 0));
  const [over, setOver] = useState(String(c.inFullOverPct ?? 10));
  const [ppmBasis, setPpmBasis] = useState(c.ppmBasis ?? "rejected");
  const [includeUnlinked, setIncludeUnlinked] = useState(c.ppmNcIncludeUnlinked ? "yes" : "no");
  const [weights, setWeights] = useState(Object.fromEntries(METRIC_ORDER.map((k) => [k, String(c.weights[WEIGHT_KEY[k]] ?? 0)])));
  const [ppmGood, setPpmGood] = useState(String(c.ppmGood));
  const [ppmZero, setPpmZero] = useState(String(c.ppmZero));
  const [pen, setPen] = useState({ critical: String(c.ncPenalty.critical), major: String(c.ncPenalty.major), minor: String(c.ncPenalty.minor) });
  const [goodFrom, setGoodFrom] = useState(String(c.goodFrom));
  const [watchFrom, setWatchFrom] = useState(String(c.watchFrom));
  const [minLines, setMinLines] = useState(String(c.minLines));
  const [reason, setReason] = useState("");

  const config = {
    otdPolicy: policy,
    ppmBasis,
    ppmNcIncludeUnlinked: includeUnlinked === "yes",
    graceDaysBefore: graceBefore === "" ? null : num(graceBefore),
    graceDaysAfter: num(graceAfter),
    inFullUnderPct: num(under),
    inFullOverPct: num(over),
    weights: Object.fromEntries(METRIC_ORDER.map((k) => [WEIGHT_KEY[k], num(weights[k])])),
    ppmGood: num(ppmGood), ppmZero: num(ppmZero),
    ncPenalty: { critical: num(pen.critical), major: num(pen.major), minor: num(pen.minor) },
    goodFrom: num(goodFrom), watchFrom: num(watchFrom), minLines: num(minLines),
  };
  const ints = [...Object.values(config.weights), ...Object.values(config.ncPenalty), config.minLines];
  const problems = [];
  if (ints.some((n) => !Number.isInteger(n) || n < 0)) problems.push("Weights, penalties and the minimum are whole numbers");
  else if (Object.values(config.weights).reduce((a, b) => a + b, 0) <= 0) problems.push("At least one metric needs a weight above zero");
  if (!(config.ppmZero > config.ppmGood && config.ppmGood >= 0)) problems.push("The PPM that scores zero must be above the one that scores 100");
  if (!(config.watchFrom > 0 && config.watchFrom < config.goodFrom && config.goodFrom <= 100)) problems.push("Bands must rise: watch below good, up to 100");
  if (!(config.minLines >= 1)) problems.push("Ask for at least one delivered line");
  if (!Number.isInteger(config.graceDaysAfter) || config.graceDaysAfter < 0 || config.graceDaysAfter > 60 || (config.graceDaysBefore !== null && (!Number.isInteger(config.graceDaysBefore) || config.graceDaysBefore < 0 || config.graceDaysBefore > 60))) problems.push("Grace days are whole numbers from 0 to 60");
  if (![config.inFullUnderPct, config.inFullOverPct].every((n) => n >= 0 && n <= 100)) problems.push("In-full tolerances are percentages from 0 to 100");
  const ok = problems.length === 0 && reason.trim().length >= 3;

  return (
    <Dialog title="Change the scorecard model" onClose={onClose} width="max-w-2xl">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok && !mutation.isPending) mutation.mutate({ action: "saveModel", dialog: true, body: { config, reason: reason.trim() } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">This saves version {model.version + 1}. Scorecards already saved keep the version they used; the live figures use the new one straight away. A supplier can override the date policy, grace days and in-full tolerances on its own Performance tab.</p>
        <ComboField label="On-time delivery is judged against" required value={policy} onChange={setPolicy} options={OTD_POLICIES} clearable={false} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Days early that still count as on time" type="number" min="0" max="60" value={graceBefore} onChange={(e) => setGraceBefore(e.target.value)} hint="Leave empty for no limit: early is never late" />
          <Field label="Days late that still count as on time" type="number" min="0" max="60" value={graceAfter} onChange={(e) => setGraceAfter(e.target.value)} hint="Also the time allowed for an order line to be delivered in full" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="In full: % below the ordered quantity" type="number" min="0" max="100" step="any" value={under} onChange={(e) => setUnder(e.target.value)} hint="At 5, receiving 95 of 100 is in full" />
          <Field label="In full: % above the ordered quantity" type="number" min="0" max="100" step="any" value={over} onChange={(e) => setOver(e.target.value)} hint="Receiving more than this is over-delivery, not in full" />
        </div>
        <ComboField label="The PPM that scores is measured from" required value={ppmBasis} onChange={setPpmBasis} options={PPM_BASES} clearable={false} hint="Both measures are always worked out and shown; this chooses which one counts toward the score" />
        <ComboField label="Non-conformance PPM counts" required value={includeUnlinked} onChange={setIncludeUnlinked} options={UNLINKED_OPTIONS} clearable={false}
          hint="Pieces on a non-conformance linked to no received line cannot be matched to a delivery. They are always shown apart; this decides whether they count." />
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-1 text-sm font-medium text-secondary-text">Weight of each metric (0 to 100; 0 shows it without scoring it)</legend>
          {METRIC_ORDER.map((k) => <Field key={k} label={METRIC_LABELS[k]} type="number" min="0" max="100" value={weights[k]} onChange={(e) => setWeights((w) => ({ ...w, [k]: e.target.value }))} />)}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="PPM that scores 100" type="number" min="0" value={ppmGood} onChange={(e) => setPpmGood(e.target.value)} />
          <Field label="PPM that scores 0" type="number" min="1" value={ppmZero} onChange={(e) => setPpmZero(e.target.value)} />
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-1 text-sm font-medium text-secondary-text">Points taken off per non-conformance</legend>
          {["critical", "major", "minor"].map((k) => <Field key={k} label={k[0].toUpperCase() + k.slice(1)} type="number" min="0" max="100" value={pen[k]} onChange={(e) => setPen((p) => ({ ...p, [k]: e.target.value }))} />)}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Good from (score)" type="number" min="1" max="100" value={goodFrom} onChange={(e) => setGoodFrom(e.target.value)} />
          <Field label="Watch from (score)" type="number" min="1" max="100" value={watchFrom} onChange={(e) => setWatchFrom(e.target.value)} hint="Below this is poor" />
          <Field label="Delivered lines needed" type="number" min="1" max="100" value={minLines} onChange={(e) => setMinLines(e.target.value)} hint="Before on-time, in-full and PPM are scored" />
        </div>
        <TextAreaField label="Why is it changing?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
        {problems.length > 0 && <p className="text-sm text-error-color" role="alert">{problems.join(". ")}.</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending}>{mutation.isPending ? "Saving…" : "Save new version"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const UNLINKED_OPTIONS = [
  { value: "no", label: "Only non-conformances linked to a received line", hint: "Exact: each piece is measured against the delivery it came in on" },
  { value: "yes", label: "Also non-conformances with no receipt linked", hint: "Counts every piece on a supplier non-conformance detected in the period, even when it cannot be matched to a delivery" },
];

const PPM_TOGGLE = [
  { value: "rejected", label: "Rejected at receiving", title: PPM_BASES[0].hint },
  { value: "ncs", label: "From non-conformances", title: PPM_BASES[1].hint },
];

/** Settings → Supplier quality: how performance is scored. */
export default function ScorecardModelCard({ canConfigure }) {
  const query = useScorecardModel();
  const mutation = usePerformanceMutation();
  const [open, setOpen] = useState(false);
  if (query.isLoading) return null;
  if (query.error) return <ErrorNotice error={query.error} />;
  const m = query.data;
  const c = m.config;
  const switchPpm = (basis) => mutation.mutate({ action: "saveModel", body: { config: { ...c, ppmBasis: basis }, reason: `PPM now measured from ${ppmBasisLabel(basis).toLowerCase()}` } });
  return (
    <MenuCard
      title="Supplier performance scoring"
      subtitle={`How scorecards are worked out (version ${m.version}). Each metric scores 0 to 100; the weighted average gives the band. A metric without enough data is left out.`}
      action={canConfigure && <CTAButton buttonType="button" type="secondary" size="default" onClick={() => setOpen(true)}>Change the model</CTAButton>}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-secondary-text" id="ppm-measure-label">PPM that scores</span>
        {canConfigure ? (
          <SlidingToggle ariaLabel="PPM that scores" options={PPM_TOGGLE} value={c.ppmBasis ?? "rejected"} onChange={switchPpm} />
        ) : (
          <span className="text-sm text-primary-text">{ppmBasisLabel(c.ppmBasis ?? "rejected")}</span>
        )}
        <span className="text-xs text-secondary-text">Both are shown on every supplier&apos;s Performance tab.{(c.ppmBasis ?? "rejected") === "ncs" && (c.ppmNcIncludeUnlinked ? " Non-conformances with no receipt linked are counted too." : " Only non-conformances linked to a received line are counted.")}</span>
      </div>
      <table className="w-full text-left text-sm" aria-label="Scoring weights">
        <thead><tr className="text-secondary-text"><th className="py-1 pr-3 font-medium">Metric</th><th className="py-1 font-medium">Weight</th></tr></thead>
        <tbody>{METRIC_ORDER.map((k) => <tr key={k} className="border-t border-border-color"><td className="py-1.5 pr-3 text-primary-text">{METRIC_LABELS[k]}</td><td className="py-1.5 tabular-nums text-primary-text">{c.weights[WEIGHT_KEY[k]] ?? 0}</td></tr>)}</tbody>
      </table>
      <p className="mt-3 text-sm text-secondary-text">
        On-time delivery by the {OTD_POLICIES.find((p) => p.value === c.otdPolicy)?.label.toLowerCase()}, {c.graceDaysBefore === null || c.graceDaysBefore === undefined ? "any early delivery" : `up to ${c.graceDaysBefore} days early`} and up to {c.graceDaysAfter ?? 0} days late counting as on time · in full means {c.inFullUnderPct ?? 0}% under to {c.inFullOverPct ?? 10}% over the ordered quantity · {Number(c.ppmGood).toLocaleString()} PPM scores 100, {Number(c.ppmZero).toLocaleString()} scores 0 · NC penalties {c.ncPenalty.critical}/{c.ncPenalty.major}/{c.ncPenalty.minor} (critical/major/minor) · good from {c.goodFrom}, watch from {c.watchFrom} · {c.minLines} delivered lines needed
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-secondary-text">Versions ({m.versions.length})</summary>
        <ul className="mt-2 flex flex-col gap-1 text-sm text-secondary-text" aria-label="Scoring model versions">
          {m.versions.map((v) => <li key={v.version}>Version {v.version} · {formatDateTime(v.createdAt)}{v.createdBy ? ` · ${v.createdBy.name}` : ""} · {v.reason}</li>)}
        </ul>
      </details>
      {open && <ModelDialog model={m} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
}
