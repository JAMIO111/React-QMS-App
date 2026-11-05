import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, CircleAlertIcon, HistoryIcon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { usePermissions } from "../../hooks/useQmsApi";
import { useGauges } from "../../hooks/useCalibration";
import { useInspection, useInspectionMutation } from "../../hooks/useInspection";
import { describeLimits, dueChecks, isDecimal, previewResult, TRIGGER_LABEL } from "../../lib/inspection";
import { formatDate, formatDateTime } from "../../lib/processControl";
import { buttonClass, ErrorNotice, FormError, SelectField, TextAreaField } from "../master-data/shared";
import { ResultBadge, StatusPill } from "./shared";

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
    <input
      aria-label={label}
      inputMode="decimal"
      autoComplete="off"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-11 w-32 rounded-lg border border-border-color bg-text-input-color px-3 text-right text-lg tabular-nums text-primary-text focus:outline-none focus:border-brand-primary"
    />
  );

const Preview = ({ requirement, value }) => {
  if (requirement.dataType === "attribute") return value === null || value === undefined ? null : <ResultBadge result={value ? "pass" : "fail"} />;
  if (value === null || value === undefined || value === "") return null;
  if (!isDecimal(value)) return <span className="text-xs text-error-color">Not a number</span>;
  return <ResultBadge result={previewResult(requirement, value)} />;
};

const GaugeSelect = ({ requirement, gauges, value, onChange }) => (
  <select
    aria-label={`Gauge for ${requirement.name}`}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value || null)}
    className="min-h-11 w-52 rounded-lg border border-border-color bg-text-input-color px-2 text-sm text-primary-text focus:outline-none focus:border-brand-primary">
    <option value="">{requirement.gaugeType ? `Choose a ${requirement.gaugeType.name}` : "No gauge"}</option>
    {gauges
      .filter((g) => !requirement.gaugeType || g.type?.id === requirement.gaugeType.id || g.id === value)
      .map((g) => {
        const problem = gaugeProblem(g, requirement);
        return (
          <option key={g.id} value={g.id}>
            {g.assetNumber} · {g.description}
            {problem ? ` (${problem})` : ""}
          </option>
        );
      })}
  </select>
);

/** One sampling occasion: a reading for each check measured now (others left empty), saved together. */
const SampleEntry = ({ inspection, gauges, canOverride }) => {
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
  const [triggerType, setTriggerType] = useState(inspection.samples.length ? "every_n_minutes" : inspection.triggerType);
  const [problem, setProblem] = useState(null);
  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const byGauge = Object.fromEntries(gauges.map((g) => [g.id, g]));
  const operations = [...new Set(applicable.map((q) => q.operationCode))];

  const submit = (e) => {
    e.preventDefault();
    const readings = [];
    for (const q of applicable) {
      const r = rows[q.id];
      const filled = q.dataType === "attribute" ? r.value !== null : String(r.value).trim() !== "";
      if (!filled) continue;
      if (q.dataType === "variable" && !isDecimal(r.value)) return setProblem(`${q.name}: enter a number, e.g. 25.05`);
      readings.push({
        requirementId: q.id,
        ...(q.dataType === "attribute" ? { valuePass: r.value } : { valueNumeric: String(r.value).trim() }),
        ...(r.gaugeId ? { gaugeId: r.gaugeId } : {}),
        ...(r.override.trim() ? { gaugeOverrideReason: r.override.trim() } : {}),
      });
    }
    if (!readings.length) return setProblem("Enter at least one reading.");
    setProblem(null);
    mutation.mutate(
      { path: `/inspections/${inspection.id}/samples`, body: { unitReference, triggerType, readings } },
      {
        onSuccess: () => {
          setRows(blank());
          setUnitReference("");
        },
      }
    );
  };

  return (
    <MenuCard as="form" onSubmit={submit} title={`Sample ${inspection.samples.length + 1}`} subtitle="Leave a check empty if it is not measured this time." aria-label="New sample" bodyClassName="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Field label="Unit / serial" value={unitReference} onChange={(e) => setUnitReference(e.target.value)} maxLength={60} className="w-48" hint="Optional" />
        <SelectField
          label="Trigger"
          required
          value={triggerType}
          onChange={setTriggerType}
          options={Object.entries(TRIGGER_LABEL).map(([value, label]) => ({ value, label }))}
          className="w-52"
        />
      </div>
      {operations.map((op) => (
        <fieldset key={op} className="flex flex-col gap-2">
          <legend className="mb-1 font-mono text-sm text-secondary-text">{op}</legend>
          {applicable
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
                  {q.dataType === "variable" ? (
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
                              className="rounded-md border border-error-color/50 bg-text-input-color px-2 py-1 text-primary-text"
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
      <button type="submit" className={`${buttonClass.primary} min-h-11 self-start`} disabled={mutation.isPending}>
        {mutation.isPending ? "Saving…" : "Save sample"}
      </button>
    </MenuCard>
  );
};

const Reading = ({ m, requirement }) =>
  requirement.dataType === "attribute" ? <ResultBadge result={m.result} /> : (
    <span className="inline-flex items-center gap-1">
      <span className="tabular-nums">{m.valueNumeric}</span>
      <ResultBadge result={m.result} />
    </span>
  );

/** A reading's history (corrections with reasons, retests, gauge) and the actions allowed on it. */
const ReadingDialog = ({ inspection, requirement, reading, gauges, canCorrect, canRecord, canOverride, onClose }) => {
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
    const val = requirement.dataType === "attribute" ? { valuePass: value } : { valueNumeric: String(value).trim() };
    const gauge = requirement.dataType === "variable" ? { gaugeId, ...(override.trim() ? { gaugeOverrideReason: override.trim() } : {}) } : {};
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
              <button type="button" className={buttonClass.neutral} onClick={() => setMode("correct")}>
                Correct this reading
              </button>
            )}
            {canRecord && open && reading.result === "fail" && (
              <button type="button" className={buttonClass.primary} onClick={() => setMode("retest")}>
                Record a retest
              </button>
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
              {requirement.dataType === "variable" && <GaugeSelect requirement={requirement} gauges={gauges} value={gaugeId} onChange={setGaugeId} />}
            </div>
            {gProblem &&
              (canOverride ? (
                <Field label={`Gauge is ${gProblem}: reason to use it anyway`} value={override} onChange={(e) => setOverride(e.target.value)} maxLength={1000} />
              ) : (
                <p className="text-sm text-error-color">The gauge is {gProblem}; choose another or ask a supervisor.</p>
              ))}
            {mode === "correct" && <TextAreaField label="Reason for the correction" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} rows={2} />}
            <FormError error={mutation.error} />
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonClass.neutral} onClick={() => setMode(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className={buttonClass.primary}
                disabled={mutation.isPending || value === null || value === "" || (mode === "correct" && !reason.trim())}>
                {mutation.isPending ? "Saving…" : mode === "correct" ? "Save correction" : "Save retest"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
};

/** Readings by check (rows) and sample (columns); corrected readings show their latest value. */
const ReadingsGrid = ({ inspection, onOpen }) => {
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
              <th key={s.id} scope="col" className={`${th} whitespace-nowrap text-center`} title={`${TRIGGER_LABEL[s.triggerType]} · ${formatDateTime(s.sampledAt)}`}>
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
                  <td key={s.id} className={`${td} text-center`}>
                    {m ? (
                      <button type="button" onClick={() => onOpen(q, m)} className="inline-flex flex-col items-center gap-0.5 rounded-md px-1 hover:bg-primary-text/5 cursor-pointer" aria-label={`${q.name}, sample ${s.sampleNumber}: details`}>
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

const DueChecks = ({ inspection }) => {
  const rows = dueChecks(inspection).filter((r) => r.reasons.length);
  if (!rows.length) return null;
  return (
    <MenuCard title="Checks due" subtitle="From the sampling rules. Part counts and events (tool change, set-up, shift) are for you to judge.">
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map(({ requirement, reasons }) => (
          <li key={requirement.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-primary-text">{requirement.name}</span>
            {reasons.map((r, i) => (
              <span
                key={i}
                className={`rounded-full px-2 py-0.5 text-xs ${r.kind === "overdue" ? "bg-error-color/15 text-error-color" : r.kind === "due" ? "bg-warning-color/15 text-primary-text" : "bg-border-color text-secondary-text"}`}>
                {r.kind === "overdue" ? "Overdue · " : r.kind === "due" ? "Due · " : ""}
                {r.text}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </MenuCard>
  );
};

/** One in-process inspection: context, due checks, sample entry, readings, completion. */
const InspectionPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const { data: inspection, isLoading, error } = useInspection(id);
  const gaugesQuery = useGauges({ pageSize: 200, sort: "assetNumber" });
  const gauges = gaugesQuery.data?.data ?? [];
  const mutation = useInspectionMutation();
  const [opened, setOpened] = useState(null); // { requirement, reading }
  const [abandoning, setAbandoning] = useState(false);
  const [reason, setReason] = useState("");
  const open = inspection?.status === "in_progress";
  const canRecord = can("inspection.record");
  const notApplicable = inspection?.requirements.filter((q) => !q.applicable) ?? [];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to="/Inspections" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Inspections
      </Link>
      {isLoading && <p className="text-secondary-text">Loading inspection…</p>}
      {error && <ErrorNotice error={error} />}
      {inspection && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-primary-text">{inspection.reference}</h1>
            <StatusPill status={inspection.status} />
            {inspection.result && <ResultBadge result={inspection.result} size="lg" />}
            {open && inspection.failures > 0 && <span className="text-sm text-error-color">{inspection.failures} failed reading{inspection.failures > 1 ? "s" : ""} so far</span>}
          </div>
          <MenuCard title="Context" subtitle="Frozen when the inspection started; later plan or part changes do not alter it.">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
              {[
                ["Part", `${inspection.part.partNumber} · ${inspection.part.name}`],
                ["Part revision", inspection.partRevision],
                ["Control plan", <Link key="p" to={`/Process-Control/Plans/${inspection.plan.id}`} className="text-link-color hover:underline">{`${inspection.plan.planCode} rev ${inspection.plan.revisionCode}`}</Link>],
                ["Operation", inspection.operationCode ?? "All"],
                ["Site", inspection.site.name],
                ["Machine", inspection.machine ? `${inspection.machine.code} · ${inspection.machine.name}` : "—"],
                ["Work order", inspection.workOrder ?? "—"],
                ["Lot / serial", [inspection.lot, inspection.serial].filter(Boolean).join(" · ") || "—"],
                ["Trigger", TRIGGER_LABEL[inspection.triggerType]],
                ["Operator", inspection.startedBy?.name ?? "—"],
                ["Started", formatDateTime(inspection.startedAt)],
                [inspection.status === "abandoned" ? "Abandoned" : "Completed", inspection.completedAt ? `${formatDateTime(inspection.completedAt)} · ${inspection.completedBy?.name ?? ""}` : "—"],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-secondary-text">{k}</dt>
                  <dd className="truncate text-primary-text">{v}</dd>
                </div>
              ))}
            </dl>
            {inspection.abandonReason && <p className="mt-2 text-sm text-primary-text">Reason: “{inspection.abandonReason}”</p>}
          </MenuCard>

          {open && <DueChecks inspection={inspection} />}
          {open && canRecord && <SampleEntry key={inspection.samples.length} inspection={inspection} gauges={gauges} canOverride={can("inspection.override_gauge")} />}

          <MenuCard title="Readings" subtitle="Select a reading for its history, a correction or a retest.">
            <ReadingsGrid inspection={inspection} onOpen={(requirement, reading) => setOpened({ requirement, reading })} />
          </MenuCard>

          {notApplicable.length > 0 && (
            <MenuCard title="Not applicable to this part" subtitle="Listed with the rule that excludes them.">
              <ul className="text-sm text-secondary-text">
                {notApplicable.map((q) => (
                  <li key={q.id}>
                    {q.name} — {q.applicability}
                  </li>
                ))}
              </ul>
            </MenuCard>
          )}

          {open && canRecord && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={`${buttonClass.primary} min-h-11`} disabled={mutation.isPending} onClick={() => mutation.mutate({ path: `/inspections/${inspection.id}/complete` })}>
                Complete inspection
              </button>
              <button type="button" className={`${buttonClass.neutral} min-h-11`} onClick={() => setAbandoning(true)}>
                Abandon
              </button>
            </div>
          )}
          {!abandoning && <FormError error={mutation.error} />}

          {opened && (
            <ReadingDialog
              inspection={inspection}
              requirement={opened.requirement}
              reading={inspection.measurements.find((m) => m.id === opened.reading.id) ?? opened.reading}
              gauges={gauges}
              canCorrect={can("inspection.correct")}
              canRecord={canRecord}
              canOverride={can("inspection.override_gauge")}
              onClose={() => setOpened(null)}
            />
          )}
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
                  <button type="button" className={buttonClass.neutral} onClick={() => setAbandoning(false)}>
                    Cancel
                  </button>
                  <button type="submit" className={buttonClass.danger} disabled={!reason.trim() || mutation.isPending}>
                    Abandon inspection
                  </button>
                </div>
              </form>
            </Dialog>
          )}
        </>
      )}
    </div>
  );
};

export default InspectionPage;
