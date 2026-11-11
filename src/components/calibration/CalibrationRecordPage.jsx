import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlignCenterIcon,
  ArrowLeftIcon,
  CheckIcon,
  ClipboardListIcon,
  DropletsIcon,
  FactoryIcon,
  FlaskConicalIcon,
  HashIcon,
  RotateCcwIcon,
  SaveIcon,
  ThermometerIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
  UsersIcon,
  XIcon,
} from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useCalibration, useCalibrationAttachments, useCalibrationMutation, useGauge, useGaugeCharacteristics } from "../../hooks/useCalibration";
import { useMe, usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { OUTCOMES, shouldPromptForStatus, statusAfterCalibration, statusOf, formatInterval, formatNumber, inTolerance, outcomeFromReadings, outcomeOf } from "../../lib/calibration";
import { formatDate, ncrPath } from "../../lib/ncr";
import GaugeUsage from "../inspection/GaugeUsage";
import { PartyPicker } from "../ncr/Pickers";
import ReasonDialog from "../ncr/ReasonDialog";
import GaugeStatusPrompt from "./GaugeStatusPrompt";
import { AttachmentDrop } from "../ui/FileDrop";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import RHFTextArea from "../ui/RHFTextArea";
import TextInput from "../ui/TextInput";
import PeoplePicker from "./PeoplePicker";
import { GaugeStatusPill, OutcomePill } from "./Pills";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import SlidingToggle from "../ui/SlidingToggle";
import Callout from "../ui/Callout";
import { todayIso } from "@/lib/localDate";

const today = () => todayIso();
const str = (v) => (v === null || v === undefined ? "" : String(v));
const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
const isNum = (v) => v === "" || v === null || v === undefined || !Number.isNaN(Number(v));
/** Pass / Fail buttons for a check; pressing the chosen one again clears it (as left only). */
const PassFail = ({ label, value, onChange, disabled, allowClear }) => (
  <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-border-color bg-primary-bg p-0.5">
    {[
      [true, "Pass", "bg-success-color text-white"],
      [false, "Fail", "bg-error-color text-white"],
    ].map(([v, text, on]) => (
      <button key={text} type="button" role="radio" aria-checked={value === v} disabled={disabled}
        onClick={() => onChange(value === v && allowClear ? null : v)}
        className={`rounded-md px-2.5 py-0.5 text-xs cursor-pointer disabled:cursor-default ${value === v ? on : "text-primary-text hover:bg-border-color/50"}`}>
        {text}
      </button>
    ))}
  </div>
);

/** A check's as-left result is offered once it failed as found (or already has one). */
const asLeftOffered = (r) => r.input.asFoundPass === false || r.input.asLeftPass != null;

const readingInput = "w-28 rounded-lg border border-border-color bg-text-input-color px-2 py-1 text-right text-sm text-primary-text focus:outline-none focus:border-brand-primary disabled:opacity-60";

const Card = ({ title, subtitle, children, action }) => (
  <section aria-label={title} className="flex flex-col gap-4 rounded-2xl bg-secondary-bg p-6 shadow-lg shadow-shadow-color">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="text-xl text-primary-text">{title}</h2>
        {subtitle && <p className="text-sm text-secondary-text">{subtitle}</p>}
      </div>
      {action}
    </div>
    {children}
  </section>
);

const Verdict = ({ ok }) =>
  ok === undefined || ok === null ? (
    <span className="inline-block w-12 text-xs text-secondary-text">—</span>
  ) : ok ? (
    <span className="inline-flex w-12 items-center gap-1 text-xs font-medium text-success-color"><CheckIcon aria-hidden="true" /> In</span>
  ) : (
    <span className="inline-flex w-12 items-center gap-1 text-xs font-medium text-error-color"><XIcon aria-hidden="true" /> Out</span>
  );

const fieldsOf = (c) => ({
  calibratedOn: c.calibratedOn,
  performedBy: c.performedBy,
  technicianId: c.technician?.id ?? null,
  supplierId: c.supplier?.id ?? null,
  certificateNumber: str(c.certificateNumber),
  procedureRef: str(c.procedureRef),
  referenceStandards: str(c.referenceStandards),
  temperatureC: str(c.temperatureC),
  humidityPct: str(c.humidityPct),
  outcome: c.outcome,
  nextDueOn: c.nextDueOn,
  notes: str(c.notes),
});
const toBody = (f) => ({
  calibratedOn: f.calibratedOn,
  performedBy: f.performedBy,
  technicianId: f.performedBy === "internal" ? f.technicianId : null,
  supplierId: f.performedBy === "external" ? f.supplierId : null,
  certificateNumber: f.certificateNumber.trim() || null,
  procedureRef: f.procedureRef.trim() || null,
  referenceStandards: f.referenceStandards.trim() || null,
  temperatureC: num(f.temperatureC),
  humidityPct: num(f.humidityPct),
  nextDueOn: f.nextDueOn,
  notes: f.notes.trim() || null,
});

/**
 * Record a calibration of a gauge, or view and correct one
 * (/Calibration/Gauges/:gaugeId/calibrations/new and …/:calibrationId): details, a reading per
 * characteristic judged against its limits as you type, the outcome, certificates and Raise NC.
 */
const CalibrationRecordPage = () => {
  const { gaugeId, calibrationId } = useParams();
  const isNew = calibrationId === "new";
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const me = useMe();
  const gauge = useGauge(gaugeId);
  const record = useCalibration(isNew ? null : calibrationId);
  const characteristics = useGaugeCharacteristics(gaugeId);
  const attachments = useCalibrationAttachments(isNew ? null : calibrationId);
  const mutation = useCalibrationMutation();
  const [dialog, setDialog] = useState(null); // "delete"
  const [statusPrompt, setStatusPrompt] = useState(null); // the calibration just recorded

  // Depend on values, not objects, so a refetch does not wipe what is being typed.
  const defaultSource = gauge.data?.calibrationSource ?? "internal";
  const myId = me.data?.profile?.id ?? null;
  const defaultSupplier = gauge.data?.supplier?.id ?? null;
  const blank = useMemo(
    () => ({
      calibratedOn: today(),
      performedBy: defaultSource,
      technicianId: myId,
      supplierId: defaultSupplier,
      certificateNumber: "",
      procedureRef: "",
      referenceStandards: "",
      temperatureC: "",
      humidityPct: "",
      outcome: null,
      nextDueOn: null,
      notes: "",
    }),
    [defaultSource, myId, defaultSupplier]
  );
  const original = useMemo(() => (record.data ? fieldsOf(record.data) : blank), [record.data, blank]);
  const originalReadings = useMemo(
    () => Object.fromEntries((record.data?.readings ?? []).filter((r) => r.characteristicId).map((r) => [r.characteristicId, { asFound: str(r.asFound), asLeft: str(r.asLeft), asFoundPass: r.asFoundPass ?? null, asLeftPass: r.asLeftPass ?? null, notes: str(r.notes) }])),
    [record.data]
  );
  const [form, setForm] = useState(original);
  const [readings, setReadings] = useState(originalReadings);
  useEffect(() => setForm(original), [original]);
  useEffect(() => setReadings(originalReadings), [originalReadings]);

  // Rows: the saved readings (with the limits as they were), then active characteristics not yet read.
  const rows = useMemo(() => {
    const saved = (record.data?.readings ?? []).map((r) => ({ ...r, key: r.characteristicId ?? r.id, saved: true }));
    const have = new Set(saved.map((r) => r.characteristicId));
    const fresh = (characteristics.data ?? []).filter((c) => !have.has(c.id)).map((c) => ({ ...c, characteristicId: c.id, key: c.id, saved: false }));
    return [...saved, ...fresh];
  }, [record.data, characteristics.data]);

  const c = record.data;
  const g = gauge.data;
  const locked = !!c?.deletedAt || !!g?.deletedAt;
  const canEdit = can("calibration.record") && !locked;
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }));
  const setReading = (id, k) => (e) =>
    setReadings((r) => ({ ...r, [id]: { asFound: "", asLeft: "", asFoundPass: null, asLeftPass: null, notes: "", ...r[id], [k]: e?.target ? e.target.value : e } }));

  const judged = rows.map((row) => {
    const v = readings[row.key] ?? {};
    if (row.kind === "attribute") return { ...row, input: v, asFoundOk: v.asFoundPass ?? undefined, asLeftOk: v.asLeftPass ?? undefined };
    return { ...row, input: v, asFoundOk: inTolerance(v.asFound, row), asLeftOk: inTolerance(v.asLeft, row) };
  });
  const isEntered = (r) => (r.kind === "attribute" ? r.input.asFoundPass === true || r.input.asFoundPass === false : r.input.asFound !== undefined && r.input.asFound !== "");
  const entered = judged.filter(isEntered);
  /** API reading: a value for a measured characteristic, pass/fail for a check. */
  const toReading = (r) =>
    r.kind === "attribute"
      ? { characteristicId: r.characteristicId, asFoundPass: r.input.asFoundPass, asLeftPass: r.input.asLeftPass ?? null, notes: (r.input.notes ?? "").trim() || null }
      : { characteristicId: r.characteristicId, asFound: Number(r.input.asFound), asLeft: num(r.input.asLeft), notes: (r.input.notes ?? "").trim() || null };
  const snapshot = (v) => JSON.stringify({ a: v?.asFound ?? "", l: v?.asLeft ?? "", fp: v?.asFoundPass ?? null, lp: v?.asLeftPass ?? null, n: v?.notes ?? "" });
  const liveOutcome = outcomeFromReadings(entered);
  const outcome = liveOutcome ?? form.outcome;
  const variables = judged.filter((r) => r.kind !== "attribute");
  const readingsValid =
    variables.every((r) => isNum(r.input.asFound) && isNum(r.input.asLeft)) &&
    !variables.some((r) => (r.input.asLeft ?? "") !== "" && (r.input.asFound ?? "") === "") &&
    !judged.some((r) => r.kind === "attribute" && r.input.asLeftPass != null && r.input.asFoundPass == null);
  const valid = form.calibratedOn && readingsValid && isNum(form.temperatureC) && isNum(form.humidityPct) && (entered.length > 0 || form.outcome);

  const body = toBody(form);
  const changedReadings = entered.filter((r) => snapshot(r.input) !== snapshot(originalReadings[r.key])).map(toReading);
  const originalBody = toBody(original);
  const changedFields = Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(originalBody[k])));
  if (!liveOutcome && form.outcome !== original.outcome) changedFields.outcome = form.outcome;
  const dirty = !isNew && (Object.keys(changedFields).length > 0 || changedReadings.length > 0);

  const goToRecord = (created) => navigate(`/Calibration/Gauges/${gaugeId}/calibrations/${created.id}`, { replace: true });
  const applyGaugeStatus = (created, status, statusReason) => {
    setStatusPrompt(null);
    // The gauge shows the new status at once and goes back if the save fails.
    if (status !== statusAfterCalibration(g.status, created.outcome)) {
      mutation.mutate(
        { path: `/gauges/${gaugeId}`, method: "PATCH", body: { status, statusReason } },
        {
          onSuccess: () => showToast({ type: "success", title: "Gauge status updated", message: `${g.assetNumber} is now ${statusOf(status).label.toLowerCase()}.` }),
          onError: (err) => showToast({ type: "error", title: "Gauge status not updated", message: describeApiError(err) }),
        }
      );
    }
    goToRecord(created);
  };

  const save = () => {
    if (!valid) return;
    if (isNew) {
      const readingsBody = entered.map(toReading);
      mutation.mutate(
        { path: `/gauges/${gaugeId}/calibrations`, body: { ...body, ...(readingsBody.length ? { readings: readingsBody } : { outcome: form.outcome }) } },
        {
          onSuccess: (created) => {
            const o = outcomeOf(created.outcome);
            showToast({
              type: created.outcome === "fail" ? "error" : "success",
              title: `Calibration ${created.reference} recorded`,
              message: created.outcome === "fail" ? `Result: fail. ${g.assetNumber} is now quarantined.` : `Result: ${o.label.toLowerCase()}. Next due ${formatDate(created.nextDueOn)}.`,
            });
            // A gauge manager may set the gauge's status to follow the result before moving on.
            if (can("calibration.manage") && g && shouldPromptForStatus(g.status, created.outcome)) setStatusPrompt(created);
            else goToRecord(created);
          },
        }
      );
    } else {
      mutation.mutate(
        { path: `/calibrations/${c.id}`, method: "PATCH", body: { ...changedFields, ...(changedReadings.length ? { readings: changedReadings } : {}) } },
        { onSuccess: () => showToast({ type: "success", title: "Saved", message: "Changes saved." }) }
      );
    }
  };
  const raiseNcr = () =>
    mutation.mutate(
      { path: `/calibrations/${c.id}/raise-ncr` },
      {
        onSuccess: (ncr) => {
          showToast({ type: "success", title: "NC raised", message: `${ncr.reference} was raised as a draft internal NC.` });
          navigate(ncrPath(ncr.id));
        },
      }
    );
  const restore = () => mutation.mutate({ path: `/calibrations/${c.id}/restore` }, { onSuccess: () => showToast({ type: "success", title: "Restored", message: `${c.reference} was restored.` }) });

  if (gauge.isLoading || (!isNew && record.isLoading)) return <LoadingScreen />;
  const loadError = gauge.error ?? record.error;
  if (loadError) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Link to="/Calibration/Gauges" className="text-link-color hover:underline">← Gauge register</Link>
        <Callout tone="error" role="alert">{describeApiError(loadError)}</Callout>
      </div>
    );
  }
  if (isNew && !can("calibration.record")) {
    return <Callout tone="error" role="alert">You do not have permission to record calibrations.</Callout>;
  }

  const text = (name, label, props = {}) => <TextInput label={label} value={form[name] ?? ""} onChange={set(name)} disabled={!canEdit} placeholder="—" {...props} />;
  const outOfTolerance = c && c.outcome !== "pass";

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 grow flex-col overflow-clip bg-primary-bg">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-color bg-primary-bg px-5 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3 py-2">
          <Link to={`/Calibration/Gauges/${gaugeId}`} className="flex items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon className="h-4 w-4" /> {g.assetNumber}
          </Link>
          <h1 className="text-xl font-semibold text-primary-text">{isNew ? "Record calibration" : `Calibration ${c.reference}`}</h1>
          {outcome && <OutcomePill outcome={outcome} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isNew && outOfTolerance && !c.nonconformance && !c.deletedAt && can("ncr.create") && can("calibration.record") && (
            <CTAButton buttonType="button" onClick={raiseNcr} disabled={mutation.isPending || dirty} loading={mutation.isPending} type="danger" size="default" className="px-3" title={dirty ? "Save your changes first" : "Raise a draft internal NC for this calibration"}>
              <TriangleAlertIcon className="h-4 w-4" /> Raise NC
            </CTAButton>
          )}
          {!isNew && c.nonconformance && (
            <CTAButton to={ncrPath(c.nonconformance.id)} type="neutral" size="default" className="px-3">
              <TriangleAlertIcon className="h-4 w-4" /> {c.nonconformance.reference}
            </CTAButton>
          )}
          {/* Always shown to editors (switched off until something changed), so the first keystroke does not move the buttons. */}
          {canEdit && (
            <CTAButton buttonType="button" onClick={() => { setForm(original); setReadings(originalReadings); }} disabled={!dirty} type="neutral" size="default" className="px-3">
              <Undo2Icon className="h-4 w-4" /> Discard changes
            </CTAButton>
          )}
          {canEdit && (
            <CTAButton buttonType="button" onClick={save} disabled={mutation.isPending || !valid || (!isNew && !dirty)} loading={mutation.isPending} type="success" size="default" className="px-3">
              <SaveIcon className="h-4 w-4" /> {mutation.isPending ? "Saving…" : isNew ? "Save calibration" : "Save changes"}
            </CTAButton>
          )}
          {!isNew && can("calibration.record") && !c.deletedAt && !g.deletedAt && (
            <CTAButton buttonType="button" onClick={() => { mutation.reset(); setDialog("delete"); }} type="danger" size="default" className="px-3">
              <Trash2Icon className="h-4 w-4" /> Delete
            </CTAButton>
          )}
        </div>
      </div>

      <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border border-border-color bg-secondary-bg px-4 py-3 text-sm">
          <span className="font-semibold text-primary-text">{g.assetNumber} · {g.description}</span>
          <GaugeStatusPill status={g.status} />
          <span className="text-secondary-text">Interval {formatInterval(g.intervalValue, g.intervalUnit)}</span>
          <span className="text-secondary-text">{g.type?.name ?? "No type"}</span>
          {g.serialNumber && <span className="text-secondary-text">S/N {g.serialNumber}</span>}
        </div>
        {c?.deletedAt && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
            Deleted {formatDate(c.deletedAt)} by {c.deletedBy?.name ?? "—"}: “{c.deleteReason}”. It no longer counts towards the gauge's dates.
            {can("calibration.record") && !g.deletedAt && (
              <CTAButton buttonType="button" onClick={restore} disabled={mutation.isPending} loading={mutation.isPending} type="neutral" size="default" className="px-3">
                <RotateCcwIcon className="h-4 w-4" /> Restore
              </CTAButton>
            )}
          </div>
        )}
        {g.deletedAt && <Callout tone="error" role="status">This gauge is deleted; its records are read-only.</Callout>}
        {mutation.error && !dialog && <Callout tone="error" role="alert">{describeApiError(mutation.error)}</Callout>}

        <Card title="Readings" subtitle="As found (before any adjustment) and, if adjusted or reworked, as left. Limits include the tolerance; checks are pass or fail.">
          {characteristics.isLoading ? (
            <LoadingScreen size="sm" />
          ) : rows.length === 0 ? (
            <p className="rounded-lg border-2 border-dashed border-border-dark-color p-4 text-center text-sm text-secondary-text">
              This gauge has no characteristics. Choose the outcome below, or{" "}
              <Link to={`/Calibration/Gauges/${gaugeId}`} className="text-link-color hover:underline">add characteristics to the gauge</Link>.
            </p>
          ) : (
            <div className="overflow-x-auto">
              {/* Fixed column widths: typing a reading or choosing pass / fail must never move the columns or the rows. */}
              <table className="w-full min-w-[900px] table-fixed text-left text-sm" aria-label="Readings">
                <colgroup>
                  <col />
                  <col className="w-44" />
                  <col className="w-32" />
                  <col className="w-16" />
                  <col className="w-32" />
                  <col className="w-16" />
                  <col className="w-56" />
                </colgroup>
                <thead className="text-secondary-text">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Characteristic</th>
                    <th className="py-1 pr-2 font-medium">Limits</th>
                    <th className="py-1 pr-2 text-right font-medium">As found</th>
                    <th className="py-1 pr-2 font-medium"><span className="sr-only">As found result</span></th>
                    <th className="py-1 pr-2 text-right font-medium">As left</th>
                    <th className="py-1 pr-2 font-medium"><span className="sr-only">As left result</span></th>
                    <th className="py-1 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="text-primary-text">
                  {judged.map((r) => (
                    <tr key={r.key} className={`border-t border-border-color ${r.asFoundOk === false && !r.asLeftOk ? "bg-error-color/5" : ""}`}>
                      <td className="py-1.5 pr-2">
                        {r.name}
                        {r.method && <span className="block text-xs text-secondary-text">{r.method}</span>}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-2 text-secondary-text">
                        {r.kind === "attribute" ? "Pass / fail" : `${formatNumber(r.lower)} to ${formatNumber(r.upper)} ${r.unitCode}`}
                      </td>
                      {r.kind === "attribute" ? (
                        <>
                          <td className="py-1.5 pr-2 text-right">
                            <PassFail label={`${r.name} as found`} value={r.input.asFoundPass ?? null} onChange={setReading(r.key, "asFoundPass")} disabled={!canEdit} />
                          </td>
                          <td className="py-1.5 pr-2"><Verdict ok={r.asFoundOk} /></td>
                          <td className="py-1.5 pr-2 text-right">
                            {/* Always there, so the row keeps its size; shown once the check failed as found (or already has an as-left result). */}
                            <span className={asLeftOffered(r) ? "" : "invisible"} aria-hidden={asLeftOffered(r) ? undefined : true}>
                              <PassFail label={`${r.name} as left`} value={r.input.asLeftPass ?? null} onChange={setReading(r.key, "asLeftPass")} disabled={!canEdit || !asLeftOffered(r)} allowClear />
                            </span>
                          </td>
                          <td className="py-1.5 pr-2"><Verdict ok={r.asLeftOk} /></td>
                        </>
                      ) : (
                      <>
                      <td className="py-1.5 pr-2 text-right">
                        <input aria-label={`${r.name} as found`} inputMode="decimal" className={readingInput} value={r.input.asFound ?? ""} onChange={setReading(r.key, "asFound")} disabled={!canEdit}
                          aria-invalid={!isNum(r.input.asFound) || undefined} />
                      </td>
                      <td className="py-1.5 pr-2"><Verdict ok={r.asFoundOk} /></td>
                      <td className="py-1.5 pr-2 text-right">
                        <input aria-label={`${r.name} as left`} inputMode="decimal" className={readingInput} value={r.input.asLeft ?? ""} onChange={setReading(r.key, "asLeft")} disabled={!canEdit}
                          placeholder={r.asFoundOk === false ? "After adjustment" : ""} aria-invalid={!isNum(r.input.asLeft) || undefined} />
                      </td>
                      <td className="py-1.5 pr-2"><Verdict ok={r.asLeftOk} /></td>
                      </>
                      )}
                      <td className="py-1.5">
                        <input aria-label={`${r.name} notes`} className="w-full rounded-lg border border-border-color bg-text-input-color px-2 py-1 text-sm focus:outline-none focus:border-brand-primary disabled:opacity-60"
                          value={r.input.notes ?? ""} onChange={setReading(r.key, "notes")} disabled={!canEdit} maxLength={500} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex min-h-12 flex-wrap items-center gap-3 border-t border-border-color pt-3 text-sm">
            <span className="text-secondary-text">Outcome</span>
            {liveOutcome ? (
              <>
                <OutcomePill outcome={liveOutcome} />
                <span className="text-secondary-text">
                  {outcomeOf(liveOutcome).help}. Worked out from the readings
                  {entered.length < judged.length ? ` (${judged.length - entered.length} of ${judged.length} not recorded).` : "."}
                </span>
              </>
            ) : (
              <SlidingToggle ariaLabel="Outcome" mode="radio" options={OUTCOMES.map((o) => ({ value: o.key, label: o.label, title: o.help, disabled: !canEdit }))} value={form.outcome} onChange={set("outcome")} />
            )}
            {outcome === "fail" && isNew && <span className="text-error-color">Saving quarantines {g.assetNumber}.</span>}
          </div>
        </Card>

        <Card title="Calibration details">
          <div className="grid grid-cols-1 items-start gap-x-8 gap-y-4 lg:grid-cols-2">
            <RHFDatePickerPopout label="Calibrated on" required valueFormat="iso" value={form.calibratedOn} onChange={set("calibratedOn")} maxDate={new Date()} disabled={!canEdit} />
            <RHFComboBox label="Performed" icon={FactoryIcon} sort={false} clearable={false} value={form.performedBy} onChange={set("performedBy")} disabled={!canEdit}
              options={[{ id: "internal", name: "In-house" }, { id: "external", name: "External (calibration supplier)" }]} />
            {form.performedBy === "internal" ? (
              <PeoplePicker label="Technician" icon={UsersIcon} value={form.technicianId} onChange={set("technicianId")} current={c?.technician} disabled={!canEdit} placeholder="Who calibrated it" />
            ) : (
              <PartyPicker kind="suppliers" label="Calibration supplier" icon={UsersIcon} value={form.supplierId} onChange={(id) => set("supplierId")(id)} current={c?.supplier ?? g.supplier} disabled={!canEdit} />
            )}
            {text("certificateNumber", "Certificate number", { maxLength: 100, icon: HashIcon })}
            {text("procedureRef", "Procedure", { maxLength: 200, icon: ClipboardListIcon, placeholder: "e.g. WI-CAL-004" })}
            {text("referenceStandards", "Reference standards used", { maxLength: 1000, icon: FlaskConicalIcon, placeholder: "e.g. Gauge block set GB-01 (cert 1234)" })}
            <div className="flex w-full items-start gap-4">
              {text("temperatureC", "Temperature (°C)", { inputMode: "decimal", icon: ThermometerIcon, error: isNum(form.temperatureC) ? undefined : "Enter a number" })}
              {text("humidityPct", "Humidity (%)", { inputMode: "decimal", icon: DropletsIcon, error: isNum(form.humidityPct) ? undefined : "Enter a number" })}
            </div>
            <RHFDatePickerPopout label="Next due" valueFormat="iso" clearable value={form.nextDueOn} onChange={set("nextDueOn")} minDate={form.calibratedOn ? new Date(form.calibratedOn) : undefined} disabled={!canEdit}
              hint={`Leave empty for ${formatInterval(g.intervalValue, g.intervalUnit)} after the calibration date`} />
            <div className="lg:col-span-2">
              <RHFTextArea label="Notes" icon={AlignCenterIcon} value={form.notes} onChange={set("notes")} disabled={!canEdit} max={5000} rows={3} placeholder="Adjustments made, observations" />
            </div>
          </div>
        </Card>

        {!isNew && outOfTolerance && can("inspection.read") && can("calibration.read") && (
          <Card title="Measurements made with this gauge" subtitle="Impact assessment: in-process inspections that used the gauge since its previous calibration">
            <GaugeUsage calibrationId={c.id} />
          </Card>
        )}

        {!isNew && (
          <Card title="Certificates">
            <AttachmentDrop
              recordId={c.id}
              bucket="calibration-files"
              folder="calibration"
              attachments={attachments}
              mutation={mutation}
              attachUrl={`/calibrations/${c.id}/attachments`}
              itemBase="/calibration-attachments"
              title="Certificates and files"
              subtitle="Calibration certificates, photos and supporting documents."
              canEdit={canEdit}
            />
            <p className="pl-1 text-sm italic text-secondary-text">
              {c.reference} recorded by {c.createdBy?.name ?? "Unknown"} on {new Date(c.createdAt).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}.
            </p>
          </Card>
        )}
        {isNew && <p className="text-sm text-secondary-text">Certificates can be attached once the calibration is saved.</p>}
      </div>

      {statusPrompt && (
        <GaugeStatusPrompt gauge={g} calibration={statusPrompt} onSkip={() => { const c2 = statusPrompt; setStatusPrompt(null); goToRecord(c2); }} onApply={(status, reason) => applyGaugeStatus(statusPrompt, status, reason)} />
      )}
      {dialog === "delete" && (
        <ReasonDialog
          title={`Delete ${c.reference}?`}
          label="Reason for deleting (kept for the record; can be restored)"
          confirmText="Delete"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onConfirm={(reason) =>
            mutation.mutate(
              { path: `/calibrations/${c.id}/delete`, body: { reason } },
              {
                onSuccess: () => {
                  setDialog(null);
                  showToast({ type: "success", title: "Deleted", message: `${c.reference} was deleted. The gauge's dates follow its previous calibration.` });
                },
              }
            )
          }
        />
      )}
    </div>
  );
};

export default CalibrationRecordPage;
