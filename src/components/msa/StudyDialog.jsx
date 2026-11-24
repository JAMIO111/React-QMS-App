import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import Dialog from "../ui/Dialog";
import FieldBase from "../ui/Field";
import ComboField from "../ui/ComboField";
import Callout from "../ui/Callout";
import Switch from "@/components/ui/Switch";
import RHFComboBox from "../ui/RHFComboBox";
import { RemoteComboBox, PartPicker } from "../ncr/Pickers";
import { describeApiError } from "../../lib/api-client";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { useGauges } from "../../hooks/useCalibration";
import { useEmployees } from "../../hooks/useNcr";
import { usePart } from "../../hooks/useMasterData";
import { useSpecValues } from "../../hooks/useProcessControl";
import { useMsaMutation } from "../../hooks/useMsa";
import { withVersion } from "../../lib/editConflicts";
import { ALPHA_OPTIONS, DEFAULT_DESIGN, SIGMA_OPTIONS, STUDY_TYPES, designProblem, isNumberText, toNumberText, typeOf } from "../../lib/msa";
import { msaPath } from "../../lib/msa";

/** The shared text box hands over the change event; the forms here work with the value. */
const Field = ({ onChange, ...props }) => <FieldBase {...props} onChange={(e) => onChange?.(e.target.value)} />;

const gaugeOption = (g) => ({ id: g.id, name: `${g.assetNumber} · ${g.description}` });

/** Gauge search (server-side) for choosing what the study is of. */
const GaugeChooser = ({ value, onChange, current, error }) => {
  const [q, setSearch] = useDebouncedSearch();
  const gauges = useGauges({ q, pageSize: 20, page: 1, status: "active" });
  return (
    <RemoteComboBox
      label="Gauge"
      required
      placeholder="Search asset number or description…"
      value={value}
      onChange={(id, item) => onChange(id, item)}
      items={(gauges.data?.data ?? []).map(gaugeOption)}
      isFetching={gauges.isFetching}
      onSearch={setSearch}
      current={current}
      error={error}
    />
  );
};

const text = (v) => (v === null || v === undefined ? "" : String(v));
const orNull = (v) => (v === "" || v === null || v === undefined ? null : toNumberText(v));

const formFrom = (s) => {
  const d = s.design ?? {};
  return {
    studyType: s.studyType,
    gaugeId: s.gauge?.id ?? null,
    partId: s.part?.id ?? null,
    characteristicKey: s.characteristicKey ?? "",
    characteristicName: s.characteristicName ?? "",
    unitCode: s.unitCode ?? "",
    nominal: text(d.nominal),
    lowerLimit: text(d.lowerLimit),
    upperLimit: text(d.upperLimit),
    referenceValue: text(d.referenceValue),
    partCount: s.partCount,
    appraiserCount: s.appraiserCount,
    trialCount: s.trialCount,
    sigmaMultiplier: d.sigmaMultiplier ?? 6,
    interactionAlpha: d.interactionAlpha ?? 0.05,
    kPercent: d.kPercent ?? 20,
    lMultiplier: d.lMultiplier ?? 6,
    appraisers: (s.appraisers ?? []).map((a) => ({ employeeId: a.employeeId ?? null, name: a.employeeId ? "" : a.name ?? "" })),
    decisions: (s.parts ?? []).map((p) => p.referenceDecision),
  };
};

const NEW = (type = "grr_crossed") => ({
  studyType: type,
  gaugeId: null,
  partId: null,
  characteristicKey: "",
  characteristicName: "",
  unitCode: "",
  nominal: "",
  lowerLimit: "",
  upperLimit: "",
  referenceValue: "",
  ...DEFAULT_DESIGN[type],
  sigmaMultiplier: 6,
  interactionAlpha: 0.05,
  kPercent: 20,
  lMultiplier: 6,
  appraisers: [],
  decisions: [],
});

const resized = (list, n, make) => Array.from({ length: n }, (_, i) => list[i] ?? make(i));

/** The characteristic of a chosen part's released revision, to fill in what is measured and its limits. */
const SpecChooser = ({ partId, value, onPick, autoKey }) => {
  const part = usePart(partId);
  const released = part.data?.revisions?.find((r) => r.status === "released");
  const values = useSpecValues(released?.id);
  const options = (values.data ?? []).map((v) => ({ id: v.characteristicKey, name: v.description ? `${v.characteristicKey} · ${v.description}` : v.characteristicKey }));
  // A study planned from a coverage row picks the characteristic by itself, once its values have arrived.
  const [autoDone, setAutoDone] = useState(false);
  useEffect(() => {
    if (!autoKey || autoDone || !values.data) return;
    const found = values.data.find((v) => v.characteristicKey.toUpperCase() === autoKey.toUpperCase());
    setAutoDone(true);
    if (found) onPick(found);
  }, [autoKey, autoDone, values.data, onPick]);
  if (!partId) return null;
  if (part.data && !released) return <Callout tone="info">This part has no released revision, so its values cannot be copied. Type what is measured and its limits below.</Callout>;
  if (options.length === 0) return null;
  return (
    <RHFComboBox
      label="Characteristic of the part"
      hint="Fills in the name, unit and limits from the part's released revision."
      options={options}
      value={value || null}
      sort={false}
      clearable
      onChange={(key) => onPick(key ? (values.data ?? []).find((v) => v.characteristicKey === key) : null)}
    />
  );
};

const AppraiserRows = ({ rows, onChange }) => {
  const employees = useEmployees();
  const options = (employees.data ?? []).filter((e) => e.active).map((e) => ({ id: e.id, name: e.name, hint: e.jobTitle ?? undefined }));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium">Appraisers</legend>
      <p className="text-xs text-secondary-text">Choose each person from the Employees register, or type a name for someone outside the company. Left empty they are called Appraiser 1, 2 …</p>
      {rows.map((a, i) => (
        <div key={i} className="grid gap-2 sm:grid-cols-2">
          <RHFComboBox label={`Appraiser ${i + 1}`} options={options} value={a.employeeId} clearable placeholder="From the register…" onChange={(id) => onChange(i, { employeeId: id ?? null, name: id ? "" : a.name })} />
          <Field label="Or a name" value={a.name} disabled={!!a.employeeId} maxLength={100} onChange={(v) => onChange(i, { name: v })} />
        </div>
      ))}
    </fieldset>
  );
};

const Decisions = ({ rows, onChange }) => (
  <fieldset className="flex flex-col gap-2">
    <legend className="text-sm font-medium">The right answer for each sample</legend>
    <p className="text-xs text-secondary-text">Every sample needs its reference decision before the study can be judged. They can be set now or edited while the study is still a draft.</p>
    <div className="grid max-h-64 gap-1 overflow-y-auto sm:grid-cols-2">
      {rows.map((d, i) => (
        <div key={i} className="flex items-center justify-between gap-2 rounded-md border border-border-color px-2 py-1 text-sm">
          <span>Sample {i + 1}</span>
          <div role="group" aria-label={`Reference decision for sample ${i + 1}`} className="flex gap-1">
            <button type="button" aria-pressed={d === true} onClick={() => onChange(i, true)} className={`min-h-9.5 rounded-md px-3 text-xs font-medium ${d === true ? "bg-success-color text-white" : "border border-border-color hover:bg-border-color/40"}`}>
              Accept
            </button>
            <button type="button" aria-pressed={d === false} onClick={() => onChange(i, false)} className={`min-h-9.5 rounded-md px-3 text-xs font-medium ${d === false ? "bg-error-color text-white" : "border border-border-color hover:bg-border-color/40"}`}>
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  </fieldset>
);

const Count = ({ label, value, onChange, min, max }) => (
  <Field label={label} type="number" required value={String(value)} min={min} max={max} onChange={(v) => onChange(v === "" ? 0 : Math.round(Number(v)))} />
);

/**
 * Plan a study, or change the design of a draft. The kind and the gauge are chosen once. What the server decides (numbers, the run sheet) is not guessed:
 * a new study opens its page when the server has made it.
 */
const StudyDialog = ({ study, defaultGauge, defaults, onClose }) => {
  const editing = !!study;
  const navigate = useNavigate();
  const mutation = useMsaMutation();
  const [opened] = useState(study);
  const startGauge = defaultGauge ?? defaults?.gauge ?? null;
  const [form, setForm] = useState(() => {
    if (study) return formFrom(study);
    const type = defaults?.studyType ?? "grr_crossed";
    return { ...NEW(type), gaugeId: startGauge?.id ?? null, partId: defaults?.part?.id ?? null, characteristicKey: defaults?.characteristicKey ?? "", characteristicName: defaults?.characteristicName ?? "" };
  });
  const [gaugeItem, setGaugeItem] = useState(startGauge ? gaugeOption(startGauge) : null);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const type = form.studyType;
  const crossed = type === "grr_crossed";
  const type1 = type === "type1";
  const attribute = type === "attribute";

  const setType = (t) => setForm((f) => ({ ...NEW(t), gaugeId: f.gaugeId, partId: f.partId, characteristicKey: f.characteristicKey, characteristicName: f.characteristicName, unitCode: f.unitCode, nominal: f.nominal, lowerLimit: f.lowerLimit, upperLimit: f.upperLimit }));
  const appraisers = useMemo(() => resized(form.appraisers, form.appraiserCount, () => ({ employeeId: null, name: "" })), [form.appraisers, form.appraiserCount]);
  const decisions = useMemo(() => resized(form.decisions, form.partCount, () => null), [form.decisions, form.partCount]);

  const problem = designProblem(type, form) || (!editing && !form.gaugeId ? "Choose the gauge." : "");
  const numbersOk = ["nominal", "lowerLimit", "upperLimit", "referenceValue"].every((k) => form[k] === "" || isNumberText(form[k]));
  const blocked = problem || !numbersOk;

  const body = () => {
    const base = {
      partId: form.partId,
      characteristicKey: form.characteristicKey.trim() || null,
      characteristicName: form.characteristicName.trim(),
      unitCode: form.unitCode.trim() || null,
      nominal: orNull(form.nominal),
      lowerLimit: orNull(form.lowerLimit),
      upperLimit: orNull(form.upperLimit),
      referenceValue: type1 ? orNull(form.referenceValue) : null,
      partCount: form.partCount,
      appraiserCount: form.appraiserCount,
      trialCount: form.trialCount,
      ...(crossed ? { sigmaMultiplier: form.sigmaMultiplier, interactionAlpha: form.interactionAlpha } : {}),
      ...(type1 ? { kPercent: Number(form.kPercent), lMultiplier: Number(form.lMultiplier) } : {}),
      appraisers: appraisers.map((a, i) => (a.employeeId ? { employeeId: a.employeeId } : { name: a.name.trim() || `Appraiser ${i + 1}` })),
      ...(attribute ? { parts: decisions.map((d, i) => ({ label: `Sample ${i + 1}`, referenceDecision: d })) } : {}),
    };
    return base;
  };

  const submit = (e) => {
    e.preventDefault();
    setError("");
    const request = editing
      ? { path: `/msa/studies/${study.id}`, method: "PATCH", body: withVersion(opened, body()) }
      : { path: "/msa/studies", method: "POST", body: { studyType: type, gaugeId: form.gaugeId, ...body() } };
    mutation.mutate(request, {
      onSuccess: (saved) => {
        onClose();
        if (!editing && saved?.id) navigate(msaPath(saved.id));
      },
      onError: (err) => setError(describeApiError(err)),
    });
  };

  return (
    <Dialog title={editing ? `Design of ${study.reference}` : "Plan a measurement system study"} onClose={onClose} width="max-w-3xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {!editing && (
          <>
            <ComboField label="Kind of study" required value={type} onChange={(v) => setType(v ?? "grr_crossed")} options={STUDY_TYPES.map((t) => ({ value: t.value, label: t.label }))} hint={typeOf(type).hint} />
            <GaugeChooser value={form.gaugeId} onChange={(id, item) => { set("gaugeId")(id); setGaugeItem(item); }} current={gaugeItem ?? undefined} />
          </>
        )}
        {editing && <p className="text-sm text-secondary-text">{typeOf(type).label} on {study.gauge?.assetNumber}. The design can be changed until collecting starts.</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <PartPicker label="Part (optional)" value={form.partId} current={study?.part ?? defaults?.part ?? undefined} onChange={(id) => setForm((f) => ({ ...f, partId: id ?? null, characteristicKey: id ? f.characteristicKey : "" }))} />
          <SpecChooser
            partId={form.partId}
            value={form.characteristicKey}
            autoKey={!editing ? defaults?.characteristicKey : undefined}
            onPick={(v) =>
              setForm((f) =>
                v
                  ? { ...f, characteristicKey: v.characteristicKey, characteristicName: v.description || v.characteristicKey, unitCode: v.unitCode ?? f.unitCode, nominal: text(v.nominal), lowerLimit: text(v.lowerLimit), upperLimit: text(v.upperLimit) }
                  : { ...f, characteristicKey: "" }
              )
            }
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What is measured" required value={form.characteristicName} onChange={set("characteristicName")} maxLength={200} />
          <Field label="Unit" value={form.unitCode} onChange={set("unitCode")} maxLength={20} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Nominal" inputMode="decimal" value={form.nominal} onChange={set("nominal")} error={form.nominal !== "" && !isNumberText(form.nominal) ? "Give a number" : undefined} />
          <Field label="Lower limit" inputMode="decimal" value={form.lowerLimit} onChange={set("lowerLimit")} error={form.lowerLimit !== "" && !isNumberText(form.lowerLimit) ? "Give a number" : undefined} />
          <Field label="Upper limit" inputMode="decimal" value={form.upperLimit} onChange={set("upperLimit")} error={form.upperLimit !== "" && !isNumberText(form.upperLimit) ? "Give a number" : undefined} />
        </div>
        <p className="-mt-2 text-xs text-secondary-text">Both limits give the tolerance, so the study can say how much of it the gauge uses. Without them only the share of the study variation is judged.</p>

        {type1 && <Field label="Reference value of the part" required inputMode="decimal" value={form.referenceValue} onChange={set("referenceValue")} hint="The value the part is known to have, from a calibrated standard." error={form.referenceValue !== "" && !isNumberText(form.referenceValue) ? "Give a number" : undefined} />}

        <div className="grid gap-3 sm:grid-cols-3">
          {!type1 && <Count label={attribute ? "Samples" : "Parts"} value={form.partCount} onChange={set("partCount")} min={2} max={attribute ? 200 : 50} />}
          {!type1 && <Count label="Appraisers" value={form.appraiserCount} onChange={set("appraiserCount")} min={attribute ? 2 : 2} max={10} />}
          <Count label={type1 ? "Readings" : "Trials"} value={form.trialCount} onChange={set("trialCount")} min={type1 ? 10 : 2} max={type1 ? 500 : 10} />
        </div>

        {!type1 && <AppraiserRows rows={appraisers} onChange={(i, patch) => setForm((f) => ({ ...f, appraisers: resized(f.appraisers, f.appraiserCount, () => ({ employeeId: null, name: "" })).map((a, j) => (j === i ? { ...a, ...patch } : a)) }))} />}
        {attribute && <Decisions rows={decisions} onChange={(i, d) => setForm((f) => ({ ...f, decisions: resized(f.decisions, f.partCount, () => null).map((x, j) => (j === i ? d : x)) }))} />}

        {(crossed || type1) && (
          <div className="flex flex-col gap-3">
            <Switch checked={advanced} onChange={(e) => setAdvanced(e.target.checked)}>
              Show the options of the method
            </Switch>
            {advanced && crossed && (
              <div className="grid gap-3 sm:grid-cols-2">
                <ComboField label="Study variation multiplier" value={form.sigmaMultiplier} onChange={(v) => set("sigmaMultiplier")(v ?? 6)} options={SIGMA_OPTIONS} required />
                <ComboField label="Keep the part × appraiser term when it is significant at" value={form.interactionAlpha} onChange={(v) => set("interactionAlpha")(v ?? 0.05)} options={ALPHA_OPTIONS} required />
              </div>
            )}
            {advanced && type1 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Share of the tolerance the gauge may use (%)" type="number" value={String(form.kPercent)} onChange={set("kPercent")} min={1} max={100} />
                <Field label="Standard deviations counted as the gauge's spread" type="number" value={String(form.lMultiplier)} onChange={set("lMultiplier")} min={1} max={10} />
              </div>
            )}
          </div>
        )}

        {(problem || error) && (
          <Callout tone={error ? "error" : "info"} role={error ? "alert" : undefined}>
            {error || problem}
          </Callout>
        )}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!!blocked} loading={mutation.isPending}>
            {editing ? "Save the design" : "Plan the study"}
          </CTAButton>
        </div>
        {!editing && (
          <p className="text-xs text-secondary-text">
            The study starts as a draft. Collecting readings begins when you start it, and then the design is locked. <Link to="/Calibration/Gauges" className="text-link-color hover:underline">Gauges</Link>
          </p>
        )}
      </form>
    </Dialog>
  );
};

export default StudyDialog;
