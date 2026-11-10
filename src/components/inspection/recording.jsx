import { useEffect, useMemo, useState } from "react";
import { CircleAlertIcon, HistoryIcon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import RHFComboBox from "../ui/RHFComboBox";
import { useInspectionMutation } from "../../hooks/useInspection";
import { describeLimits, eventTriggers, isDecimal, nextSample, previewResult, TRIGGER_LABEL } from "../../lib/inspection";
import { formatDate, formatDateTime } from "../../lib/processControl";
import { FormError, SelectField, TextAreaField } from "../master-data/shared";
import { ResultBadge } from "./shared";
import CTAButton from "@/components/CTAButton";

/**
 * The recording pieces of an in-process inspection, shared by the inspection page (/Inspections/:id) and the operator job hub (/Jobs/:id) so the two
 * screens record, correct, retest, complete and abandon in exactly the same way.
 */

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";
const today = () => new Date().toISOString().slice(0, 10);

/** Whether a gauge may be used for a requirement now, and why not. */
const gaugeProblem = (gauge, requirement) => {
  if (!gauge) return null;
  if (gauge.status !== "active") return `${gauge.status.replace("_", " ")}`;
  if (gauge.nextDueOn && gauge.nextDueOn < today()) return `overdue (due ${formatDate(gauge.nextDueOn)})`;
  if (requirement.gaugeType && gauge.type?.id !== requirement.gaugeType.id) return `not a ${requirement.gaugeType.name}`;
  return null;
};

/** Variable checks always take a gauge; pass/fail checks when the plan names a gauge type (go/no-go, bore gauges). */
const usesGauge = (q) => q.dataType === "variable" || !!q.gaugeType;

/** The reading currently in force for a requirement in a sample (the end of its correction chain). */
const currentReadings = (measurements) => measurements.filter((m) => !m.supersededById);

const ValueInput = ({ requirement, value, onChange, label }) =>
  requirement.dataType === "attribute" ? (
    <div role="radiogroup" aria-label={label} className="flex gap-2">
      {[
        [true, "Pass"],
        [false, "Fail"],
      ].map(([v, text]) => (
        <button
          key={text}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(value === v ? null : v)}
          className={`min-h-11 min-w-20 rounded-lg border px-3 text-sm font-medium cursor-pointer ${
            value === v ? (v ? "border-success-color bg-success-color/15 text-success-color" : "border-error-color bg-error-color/15 text-error-color") : "border-border-color text-primary-text"
          }`}>
          {text}
        </button>
      ))}
    </div>
  ) : (
    <div className="flex items-center gap-2">
      <input
        aria-label={label}
        inputMode={requirement.dataType === "count" ? "numeric" : "decimal"}
        autoComplete="off"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-11 w-32 rounded-lg border border-border-color bg-text-input-color px-3 text-right text-lg tabular-nums text-primary-text focus:outline-none focus:border-brand-primary"
      />
      {requirement.dataType === "count" ? <span className="text-sm text-secondary-text">{Number(value) === 1 ? "defect" : "defects"}</span> : requirement.unitCode && <span className="text-sm text-secondary-text">{requirement.unitCode}</span>}
    </div>
  );

const Preview = ({ requirement, value }) => {
  if (requirement.dataType === "attribute") return value === null || value === undefined ? null : <ResultBadge result={value ? "pass" : "fail"} />;
  if (value === null || value === undefined || value === "") return null;
  if (requirement.dataType === "count") return /^\d{1,6}$/.test(String(value).trim()) ? <ResultBadge result={previewResult(requirement, value)} /> : <span className="text-xs text-error-color">Enter a whole number</span>;
  if (!isDecimal(value)) return <span className="text-xs text-error-color">Not a number</span>;
  return <ResultBadge result={previewResult(requirement, value)} />;
};

const GaugeSelect = ({ requirement, gauges, value, onChange }) => {
  const options = gauges
    .filter((g) => !requirement.gaugeType || g.type?.id === requirement.gaugeType.id || g.id === value)
    .map((g) => {
      const problem = gaugeProblem(g, requirement);
      return { id: g.id, name: `${g.assetNumber} · ${g.description}`, hint: problem ? `Not usable: ${problem}` : undefined };
    });
  return (
    <div className="w-104 max-w-full" role="group" aria-label={`Gauge for ${requirement.name}`}>
      <RHFComboBox
        value={value ?? null}
        onChange={(id) => onChange(id ?? null)}
        options={options}
        sort={false}
        placeholder={requirement.gaugeType ? `Choose a ${requirement.gaugeType.name}` : "No gauge"}
      />
    </div>
  );
};

/** One sampling occasion: a reading for each check measured now (others left empty), saved together. */
export const SampleEntry = ({ inspection, gauges, canOverride }) => {
  const mutation = useInspectionMutation();
  const applicable = inspection.requirements.filter((q) => q.applicable);
  // Default each gauge to the one last used for that check.
  const lastGauge = useMemo(() => {
    const map = {};
    for (const m of inspection.measurements) if (m.gauge) map[m.requirementId] = m.gauge.id;
    return map;
  }, [inspection.measurements]);
  const blank = () => Object.fromEntries(applicable.map((q) => [q.id, { value: q.dataType === "attribute" ? null : "", gaugeId: lastGauge[q.id] ?? null, override: "" }]));
  const [rows, setRows] = useState(blank);
  const [unitReference, setUnitReference] = useState("");
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const events = eventTriggers(inspection);
  const [mode, setMode] = useState("planned");
  const next = nextSample(inspection, now);
  const isEvent = events.includes(mode);
  // A planned sample lists exactly the checks the plan requires now; an event sample the checks planned for that event.
  const shown = isEvent ? applicable.filter((q) => q.sampling.some((s) => s.triggerType === mode)) : applicable.filter((q) => next?.requirementIds.includes(q.id));
  const nothingToDo = !isEvent && !next;
  const [problem, setProblem] = useState(null);
  const [newSubgroup, setNewSubgroup] = useState(false);
  // X-bar/R checks chart subgroups of n samples taken at one check; the database fills a subgroup before starting the next.
  const subgroupSize = Math.max(0, ...applicable.filter((q) => q.chartType === "xbar_r").map((q) => q.subgroupSize ?? 0));
  const lastSubgroup = [...inspection.samples].reverse().find((x) => !x.isRetest && x.subgroupNumber !== null)?.subgroupNumber ?? null;
  const inLastSubgroup = lastSubgroup === null ? 0 : inspection.samples.filter((x) => x.subgroupNumber === lastSubgroup).length;
  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const byGauge = Object.fromEntries(gauges.map((g) => [g.id, g]));
  const operations = [...new Set(shown.map((q) => q.operationCode))];

  const submit = (e) => {
    e.preventDefault();
    const readings = [];
    for (const q of shown) {
      const r = rows[q.id];
      const filled = q.dataType === "attribute" ? r.value !== null : String(r.value).trim() !== "";
      if (!filled) {
        if (isEvent) continue;
        return setProblem(`${q.name}: enter a reading — every check listed is part of this sample`);
      }
      if (q.dataType === "variable" && !isDecimal(r.value)) return setProblem(`${q.name}: enter a number, e.g. 25.05`);
      if (q.dataType === "count" && !/^\d{1,6}$/.test(String(r.value).trim())) return setProblem(`${q.name}: enter the number of defects found on this unit (0 if none)`);
      readings.push({
        requirementId: q.id,
        ...readingValue(q, r.value),
        ...(r.gaugeId ? { gaugeId: r.gaugeId } : {}),
        ...(r.override.trim() ? { gaugeOverrideReason: r.override.trim() } : {}),
      });
    }
    if (!readings.length) return setProblem("Enter at least one reading.");
    setProblem(null);
    mutation.mutate(
      { path: `/inspections/${inspection.id}/samples`, body: { unitReference, ...(isEvent ? { triggerType: mode } : {}), readings, ...(newSubgroup && subgroupSize ? { newSubgroup: true } : {}) } },
      {
        onSuccess: () => {
          setRows(blank());
          setUnitReference("");
          setNewSubgroup(false);
        },
      }
    );
  };

  return (
    <MenuCard
      as="form"
      onSubmit={submit}
      title={isEvent ? `Extra sample · ${TRIGGER_LABEL[mode]}` : next?.number ? `Sample ${next.number}` : next ? "Timed check" : "Sampling complete"}
      subtitle={isEvent ? "Only the checks the plan samples on this event." : next?.number ? `Part ${next.position} of the lot · ${TRIGGER_LABEL[next.trigger]}. Samples are recorded in order.` : next ? "Checks that are due again." : undefined}
      aria-label="New sample"
      bodyClassName="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Field label="Unit / serial" value={unitReference} onChange={(e) => setUnitReference(e.target.value)} maxLength={60} className="w-48" hint="Optional" />
        {events.length > 0 && (
          <SelectField
            label="Sample type"
            value={mode}
            onChange={setMode}
            options={[{ value: "planned", label: next ? "Next planned sample" : "Planned samples" }, ...events.map((t) => ({ value: t, label: `Extra · ${TRIGGER_LABEL[t]}` }))]}
            className="w-64"
          />
        )}
      </div>
      {nothingToDo && <p className="text-sm text-secondary-text">All planned samples are recorded and no timed check is due. Complete the inspection when you are done.</p>}
      {subgroupSize > 0 && (
        <label className="flex items-center gap-2 text-sm text-primary-text">
          <input type="checkbox" checked={newSubgroup || lastSubgroup === null || inLastSubgroup >= subgroupSize} disabled={lastSubgroup === null || inLastSubgroup >= subgroupSize} onChange={(e) => setNewSubgroup(e.target.checked)} />
          {lastSubgroup === null || inLastSubgroup >= subgroupSize
            ? `Starts subgroup ${(lastSubgroup ?? 0) + 1} (subgroups hold ${subgroupSize} samples for the control chart)`
            : `Start a new subgroup (this sample otherwise joins subgroup ${lastSubgroup}, sample ${inLastSubgroup + 1} of ${subgroupSize})`}
        </label>
      )}
      {operations.map((op) => (
        <fieldset key={op} className="flex flex-col gap-2">
          <legend className="mb-1 font-mono text-sm text-secondary-text">{op}</legend>
          {shown
            .filter((q) => q.operationCode === op)
            .map((q) => {
              const r = rows[q.id];
              const gauge = byGauge[r.gaugeId];
              const gProblem = gaugeProblem(gauge, q);
              return (
                <div key={q.id} className="grid grid-cols-1 items-center gap-2 rounded-xl border border-border-color p-3 md:grid-cols-[minmax(12rem,1fr)_auto_auto_6rem]">
                  <div className="min-w-0">
                    <div className="font-medium text-primary-text">
                      {q.charNumber && <span className="mr-1 text-secondary-text">#{q.charNumber}</span>}
                      {q.name}
                      {q.criticality === "critical" && <span className="ml-2 rounded-full bg-error-color/15 px-2 py-0.5 text-xs text-error-color">Critical</span>}
                    </div>
                    <div className="text-sm tabular-nums text-primary-text">{describeLimits(q)}</div>
                    {q.method && <div className="text-xs text-secondary-text">{q.method}</div>}
                  </div>
                  {usesGauge(q) ? (
                    <div className="flex flex-col gap-1">
                      <GaugeSelect requirement={q} gauges={gauges} value={r.gaugeId} onChange={(v) => setRow(q.id, { gaugeId: v })} />
                      {gProblem && (
                        <div className="flex flex-col gap-1 text-xs text-error-color">
                          <span className="flex items-center gap-1">
                            <CircleAlertIcon className="h-3.5 w-3.5" /> Gauge {gauge.assetNumber} is {gProblem}.
                          </span>
                          {canOverride ? (
                            <input
                              aria-label={`Override reason for ${q.name}`}
                              placeholder="Reason to use it anyway"
                              value={r.override}
                              onChange={(e) => setRow(q.id, { override: e.target.value })}
                              className="rounded-md border border-error-color/50 bg-text-input-color px-2 py-1 text-sm text-primary-text"
                            />
                          ) : (
                            <span>Choose another gauge or ask a supervisor.</span>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span />
                  )}
                  <ValueInput requirement={q} value={r.value} onChange={(v) => setRow(q.id, { value: v })} label={`${q.name} reading`} />
                  <div role="status" aria-live="polite" aria-label={`Result for ${q.name}`}>
                    <Preview requirement={q} value={r.value} />
                  </div>
                </div>
              );
            })}
        </fieldset>
      ))}
      {problem && (
        <p role="alert" className="text-sm text-error-color">
          {problem}
        </p>
      )}
      <FormError error={mutation.error} />
      <CTAButton buttonType="submit" type="main" size="lg" className="min-h-11 self-start" disabled={mutation.isPending || nothingToDo} loading={mutation.isPending}>
        {mutation.isPending ? "Saving…" : "Save sample"}
      </CTAButton>
    </MenuCard>
  );
};

/** The API fields for a typed-in value: pass/fail, a defect count or a measured value (kept as typed). */
const readingValue = (requirement, value) =>
  requirement.dataType === "attribute" ? { valuePass: value } : requirement.dataType === "count" ? { valueCount: Number(String(value).trim()) } : { valueNumeric: String(value).trim() };

const Reading = ({ m, requirement }) =>
  requirement.dataType === "attribute" ? <ResultBadge result={m.result} /> : (
    <span className="inline-flex items-center gap-1">
      <span className="tabular-nums">{requirement.dataType === "count" ? m.valueCount : m.valueNumeric}</span>
      <ResultBadge result={m.result} />
    </span>
  );

/** A reading's history (corrections with reasons, retests, gauge) and the actions allowed on it. */
export const ReadingDialog = ({ inspection, requirement, reading, gauges, canCorrect, canRecord, canOverride, onClose }) => {
  const mutation = useInspectionMutation();
  const [mode, setMode] = useState(null); // null | "correct" | "retest"
  const [value, setValue] = useState(requirement.dataType === "attribute" ? null : "");
  const [reason, setReason] = useState("");
  const [gaugeId, setGaugeId] = useState(reading.gauge?.id ?? null);
  const [override, setOverride] = useState("");
  const chain = [];
  for (let m = reading; m; m = inspection.measurements.find((x) => x.id === m.supersedesId)) chain.unshift(m);
  const retests = inspection.measurements.filter((x) => chain.some((c) => c.id === x.retestOfId));
  const open = inspection.status === "in_progress";
  const gProblem = gaugeProblem(gauges.find((g) => g.id === gaugeId), requirement);

  const submit = (e) => {
    e.preventDefault();
    const val = readingValue(requirement, value);
    const gauge = usesGauge(requirement) ? { gaugeId, ...(override.trim() ? { gaugeOverrideReason: override.trim() } : {}) } : {};
    mutation.mutate(
      mode === "correct"
        ? { path: `/inspection-measurements/${reading.id}/correction`, body: { ...val, ...gauge, reason } }
        : { path: `/inspections/${inspection.id}/samples`, body: { isRetest: true, triggerType: "manual", readings: [{ requirementId: requirement.id, ...val, ...gauge, retestOfId: reading.id }] } },
      { onSuccess: onClose }
    );
  };

  return (
    <Dialog title={`${requirement.name} · ${describeLimits(requirement)}`} onClose={onClose} width="max-w-xl">
      <div className="flex flex-col gap-3">
        <ol className="flex flex-col gap-2 text-sm" aria-label="Reading history">
          {chain.map((m) => (
            <li key={m.id} className={`rounded-lg border border-border-color p-2 ${m.supersededById ? "text-secondary-text" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={m.supersededById ? "line-through" : ""}>
                  <Reading m={m} requirement={requirement} />
                </span>
                <span className="text-xs text-secondary-text">
                  {m.measuredBy?.name ?? "—"} · {formatDateTime(m.measuredAt)}
                </span>
              </div>
              {m.gauge && (
                <div className="text-xs text-secondary-text">
                  Gauge {m.gauge.assetNumber} ({m.gauge.status.replace("_", " ")}
                  {m.gauge.nextDueOn ? `, due ${formatDate(m.gauge.nextDueOn)}` : ""}){!m.gauge.valid && ` — used with override: “${m.gaugeOverrideReason}”`}
                </div>
              )}
              {m.correctionReason && <div className="text-xs text-primary-text">Correction: “{m.correctionReason}”</div>}
            </li>
          ))}
        </ol>
        {retests.length > 0 && (
          <div className="text-sm">
            <span className="text-secondary-text">Retests: </span>
            {retests.map((t) => (
              <span key={t.id} className="mr-2">
                <Reading m={t} requirement={requirement} />
              </span>
            ))}
          </div>
        )}
        {!mode && (
          <div className="flex flex-wrap gap-2">
            {canCorrect && inspection.status !== "abandoned" && (
              <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setMode("correct")}>
                Correct this reading
              </CTAButton>
            )}
            {canRecord && open && reading.result === "fail" && (
              <CTAButton buttonType="button" type="main" size="lg" onClick={() => setMode("retest")}>
                Record a retest
              </CTAButton>
            )}
          </div>
        )}
        {mode && (
          <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-border-color p-3">
            <p className="text-sm text-primary-text">
              {mode === "correct"
                ? "The corrected value replaces this reading; the original is kept and shown struck through."
                : "The retest is recorded as a new sample linked to this failed reading, which stays on record."}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <ValueInput requirement={requirement} value={value} onChange={setValue} label={mode === "correct" ? "Corrected value" : "Retest value"} />
              <Preview requirement={requirement} value={value} />
              {usesGauge(requirement) && <GaugeSelect requirement={requirement} gauges={gauges} value={gaugeId} onChange={setGaugeId} />}
            </div>
            {gProblem &&
              (canOverride ? (
                <Field label={`Gauge is ${gProblem}: reason to use it anyway`} required value={override} onChange={(e) => setOverride(e.target.value)} maxLength={1000} />
              ) : (
                <p className="text-sm text-error-color">The gauge is {gProblem}; choose another or ask a supervisor.</p>
              ))}
            {mode === "correct" && <TextAreaField label="Reason for the correction" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} rows={2} />}
            <FormError error={mutation.error} />
            <div className="flex justify-end gap-2">
              <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setMode(null)}>
                Cancel
              </CTAButton>
              <CTAButton
                buttonType="submit"
                type="main" size="lg"
                disabled={mutation.isPending || value === null || value === "" || (mode === "correct" && !reason.trim())} loading={mutation.isPending}>
                {mutation.isPending ? "Saving…" : mode === "correct" ? "Save correction" : "Save retest"}
              </CTAButton>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
};

/** Readings by check (rows) and sample (columns); corrected readings show their latest value. */
export const ReadingsGrid = ({ inspection, onOpen }) => {
  const applicable = inspection.requirements.filter((q) => q.applicable);
  const current = currentReadings(inspection.measurements);
  if (!inspection.samples.length) return <p className="text-sm text-secondary-text">No samples yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-0 text-sm text-primary-text" aria-label="Readings">
        <thead>
          <tr>
            <th scope="col" className={`${th} sticky left-0 bg-secondary-bg`}>Check</th>
            {inspection.samples.map((s) => (
              <th key={s.id} scope="col" className={`${th} whitespace-nowrap text-right`} title={`${TRIGGER_LABEL[s.triggerType]} · ${formatDateTime(s.sampledAt)}`}>
                #{s.sampleNumber}
                {s.isRetest && <span className="ml-1 text-xs">(retest)</span>}
                {s.unitReference && <div className="text-xs">{s.unitReference}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {applicable.map((q) => (
            <tr key={q.id}>
              <th scope="row" className={`${td} sticky left-0 bg-secondary-bg text-left font-normal`}>
                <div className="font-medium">{q.name}</div>
                <div className="text-xs tabular-nums text-secondary-text">{describeLimits(q)}</div>
              </th>
              {inspection.samples.map((s) => {
                const m = current.find((x) => x.sampleId === s.id && x.requirementId === q.id);
                return (
                  <td key={s.id} className={`${td} text-right`}>
                    {m ? (
                      <button type="button" onClick={() => onOpen(q, m)} className="inline-flex flex-col items-end gap-0.5 rounded-md px-1 hover:bg-primary-text/5 cursor-pointer" aria-label={`${q.name}, sample ${s.sampleNumber}: details`}>
                        <Reading m={m} requirement={q} />
                        {(m.supersedesId || (m.gauge && !m.gauge.valid)) && (
                          <span className="flex items-center gap-1 text-xs text-secondary-text">
                            <HistoryIcon className="h-3 w-3" /> {m.supersedesId ? "corrected" : "gauge override"}
                          </span>
                        )}
                      </button>
                    ) : (
                      <span className="text-secondary-text">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** The samples the plan calls for, in order, with what is recorded so far. */
export const SamplePlan = ({ inspection }) => {
  const next = nextSample(inspection);
  const nameOf = (id) => inspection.requirements.find((q) => q.id === id)?.name ?? "";
  const taken = next?.plannedTaken ?? inspection.schedule.length;
  return (
    <MenuCard title="Sample plan" subtitle={`${Math.min(taken, inspection.schedule.length)} of ${inspection.schedule.length} planned samples recorded. Record them in order.`}>
      <ol className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm" aria-label="Planned samples">
        {inspection.schedule.map((s, i) => {
          const state = i < taken ? "done" : i === taken ? "next" : "later";
          const ids = state === "next" ? next.requirementIds : s.requirementIds;
          return (
            <li key={s.number} className={`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 ${state === "next" ? "bg-brand-primary/10" : ""} ${state === "later" ? "text-secondary-text" : "text-primary-text"}`}>
              <span className="w-24 font-medium tabular-nums">Sample {s.number}</span>
              <span className="w-28 text-xs text-secondary-text">Part {s.position} · {TRIGGER_LABEL[s.trigger]}</span>
              <span className="min-w-0 flex-1 truncate">{ids.map(nameOf).join(", ")}</span>
              <span className="text-xs">{state === "done" ? "Recorded" : state === "next" ? "Next" : ""}</span>
            </li>
          );
        })}
        {next?.kind === "timed" && (
          <li className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-color/15 px-2 py-1 text-primary-text">
            <span className="w-24 font-medium">Timed check</span>
            <span className="min-w-0 flex-1 truncate">{next.requirementIds.map(nameOf).join(", ")}</span>
            <span className="text-xs">Due</span>
          </li>
        )}
      </ol>
    </MenuCard>
  );
};

/** Complete or abandon a running inspection (abandoning asks for a reason). Shown to people who can record. */
export const RunControls = ({ inspection }) => {
  const mutation = useInspectionMutation();
  const [abandoning, setAbandoning] = useState(false);
  const [reason, setReason] = useState("");
  const plannedLeft = inspection.schedule.length - (nextSample(inspection)?.plannedTaken ?? inspection.schedule.length);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <CTAButton buttonType="button" type="main" size="lg" className="min-h-11" disabled={mutation.isPending || plannedLeft > 0} loading={mutation.isPending} onClick={() => mutation.mutate({ path: `/inspections/${inspection.id}/complete` })}>
          Complete inspection
        </CTAButton>
        {plannedLeft > 0 && <p className="self-center text-sm text-secondary-text">{plannedLeft} planned {plannedLeft === 1 ? "sample" : "samples"} still to record. Abandon the inspection to stop early.</p>}
        <CTAButton buttonType="button" type="neutral" size="md" className="min-h-11" onClick={() => setAbandoning(true)}>
          Abandon
        </CTAButton>
      </div>
      {!abandoning && <FormError error={mutation.error} />}
      {abandoning && (
        <Dialog title={`Abandon ${inspection.reference}?`} onClose={() => setAbandoning(false)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate({ path: `/inspections/${inspection.id}/abandon`, body: { reason } }, { onSuccess: () => setAbandoning(false) });
            }}>
            <p className="text-sm text-primary-text">Readings already taken are kept. No more can be added.</p>
            <TextAreaField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} rows={2} />
            <FormError error={mutation.error} />
            <div className="flex justify-end gap-2">
              <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setAbandoning(false)}>
                Cancel
              </CTAButton>
              <CTAButton buttonType="submit" type="danger" size="md" disabled={!reason.trim() || mutation.isPending} loading={mutation.isPending}>
                Abandon inspection
              </CTAButton>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
};
