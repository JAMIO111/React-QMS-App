import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import { ArrowLeftIcon, CircleCheckIcon, TriangleAlertIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useGauges } from "../../hooks/useCalibration";
import { useImportMutation, useInspectionImport, useMatchFeature } from "../../hooks/useMeasurementImports";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { EVENT_TRIGGERS, TRIGGER_LABEL } from "../../lib/inspection";
import {
  APPLY_MODE_HINT,
  APPLY_MODES,
  checkLabel,
  converted,
  importBlockers,
  limitsWords,
  MATCH_KIND,
  rowValueWords,
} from "../../lib/measurementImports";
import { formatDateTime } from "../../lib/processControl";
import { TextAreaField } from "../master-data/shared";
import { ResultBadge } from "../inspection/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ImportStatusPill } from "./ImportFromFile";

const th = "border-b border-border-color px-2 py-2 text-left text-xs font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top text-sm";

const HEADER_WORDS = { partNumber: "Part number", serial: "Serial", workOrder: "Work order", lot: "Lot", program: "Program", operator: "Operator", measuredAt: "Measured" };

const Figure = ({ label, value, tone }) => (
  <div className="flex min-w-24 flex-col rounded-lg border border-border-color px-3 py-2">
    <span className={`text-xl font-semibold tabular-nums ${tone === "error" ? "text-error-color" : tone === "warning" ? "text-warning-color" : "text-primary-text"}`}>{value}</span>
    <span className="text-xs text-secondary-text">{label}</span>
  </div>
);

/** One part of the file: each feature, the check it is matched to (changeable while a preview), what it will record and anything to look at. */
const UnitTable = ({ detail, unit, editable, remember }) => {
  const match = useMatchFeature(detail.id);
  const { showToast } = useToast();
  const checks = detail.checks.filter((c) => c.applicable);
  const byId = new Map(detail.checks.map((c) => [c.id, c]));
  const options = checks.map((c) => ({ value: c.id, label: checkLabel(c), hint: limitsWords(c.lowerLimit, c.upperLimit, c.unit) }));
  const rows = [...unit.rows].sort((a, b) => Number(!a.requirementId) - Number(!b.requirementId) || a.position - b.position);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-separate border-spacing-0" aria-label={`Features of part ${unit.position}`}>
        <thead>
          <tr>
            <th scope="col" className={th}>Feature in the file</th>
            <th scope="col" className={`${th} w-72`}>Check</th>
            <th scope="col" className={th}>Value</th>
            <th scope="col" className={th}>Our limits</th>
            <th scope="col" className={th}>The file&apos;s limits</th>
            <th scope="col" className={th}>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const check = r.requirementId ? byId.get(r.requirementId) : null;
            return (
              <tr key={r.id} className={r.requirementId ? "" : "opacity-70"}>
                <td className={td}>
                  <div className="font-medium text-primary-text">{r.featureName}</div>
                  <div className="text-xs text-secondary-text">{r.charNumber ? `Balloon ${r.charNumber} · ` : ""}{MATCH_KIND[r.matchKind]}</div>
                </td>
                <td className={td}>
                  {editable ? (
                    <ComboField
                      ariaLabel={`Check for ${r.featureName}`}
                      value={r.requirementId}
                      onChange={(requirementId) =>
                        match.mutate(
                          { rowId: r.id, requirementId, remember },
                          { onError: (e) => showToast({ type: "error", title: "Not matched", message: describeApiError(e) }) },
                        )
                      }
                      options={options}
                      placeholder="Not matched"
                    />
                  ) : (
                    <span className="text-primary-text">{check ? checkLabel(check) : "Not matched"}</span>
                  )}
                </td>
                <td className={`${td} tabular-nums`}>
                  <div className="text-primary-text">{rowValueWords(r, check)}</div>
                  {converted(r, check) && <div className="text-xs text-secondary-text">{r.readValue} {r.unitRead} in the file</div>}
                </td>
                <td className={`${td} tabular-nums text-primary-text`}>{check ? limitsWords(check.lowerLimit, check.upperLimit, check.unit) : "—"}</td>
                <td className={`${td} tabular-nums`}>
                  <span className={r.mismatch ? "font-medium text-warning-color" : "text-secondary-text"}>{limitsWords(r.fileLower, r.fileUpper, check?.unit)}</span>
                  {r.mismatch && (
                    <div className="flex items-center gap-1 text-xs text-warning-color">
                      <TriangleAlertIcon className="h-3 w-3" /> Differs from the control plan
                    </div>
                  )}
                </td>
                <td className={td}>
                  {r.problem ? <span className="text-xs text-error-color">{r.problem}</span> : <ResultBadge result={r.expectedResult} />}
                  {r.measurementId && <div className="mt-1 text-xs text-secondary-text">Recorded</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

/** Record the preview: how (new readings, retest, correction), the gauge, and anything the server needs. */
const ApplyCard = ({ detail, back }) => {
  const mutation = useImportMutation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { can } = usePermissions();
  const gauges = useGauges({ pageSize: 200, sort: "assetNumber" });
  const [mode, setMode] = useState("new");
  const [reason, setReason] = useState("");
  const [gaugeId, setGaugeId] = useState(detail.gauge?.id ?? null);
  const [trigger, setTrigger] = useState(null);
  const [override, setOverride] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const blockers = importBlockers(detail);
  const needsReason = mode === "correct";
  const ready = blockers.length === 0 && (!needsReason || reason.trim().length >= 3);

  const apply = () =>
    mutation.mutate(
      {
        action: "apply",
        id: detail.id,
        body: {
          mode,
          reason: needsReason ? reason.trim() : undefined,
          gaugeId: gaugeId ?? null,
          gaugeOverrideReason: override.trim() || undefined,
          triggerType: mode === "new" && trigger ? trigger : undefined,
        },
      },
      {
        onSuccess: (d) => {
          showToast({ type: "success", title: "Readings recorded", message: `${d.counts.toRecord} reading${d.counts.toRecord === 1 ? "" : "s"} from ${d.fileName}` });
          navigate(back || `/Inspections/${detail.inspection.id}`);
        },
      },
    );

  return (
    <MenuCard title="Record these readings" subtitle="Everything is recorded together, or nothing is. Fortress's limits decide pass or fail.">
      <div className="flex flex-col gap-4">
        {blockers.length > 0 && (
          <Callout tone="warning" title="Still needed">
            <ul className="list-disc pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          </Callout>
        )}
        <div className="flex flex-col gap-1">
          <SlidingToggle ariaLabel="How to record" options={APPLY_MODES.map((m) => ({ ...m, disabled: m.value === "correct" && !can("inspection.correct") }))} value={mode} onChange={setMode} />
          <p className="text-xs text-secondary-text">{APPLY_MODE_HINT[mode]}</p>
        </div>
        {needsReason && <TextAreaField label="Why are the readings being corrected?" required value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />}
        <div className="grid gap-3 md:grid-cols-2">
          <ComboField
            label="Gauge used"
            value={gaugeId}
            onChange={setGaugeId}
            options={(gauges.data?.data ?? []).map((g) => ({ value: g.id, label: g.assetNumber, hint: g.description }))}
          />
          {mode === "new" && (
            <ComboField
              label="Why the sample was taken"
              value={trigger}
              onChange={setTrigger}
              placeholder="The next sample of the plan"
              options={EVENT_TRIGGERS.map((t) => ({ value: t, label: TRIGGER_LABEL[t] }))}
              hint="Leave empty for the next sample the plan asks for; choose an event for an extra one."
            />
          )}
        </div>
        {can("inspection.override_gauge") && (
          <Field label="Reason for using a gauge that is overdue or not the required type" value={override} onChange={(e) => setOverride(e.target.value)} hint="Only when the gauge is not valid; it is kept on every reading." />
        )}
        {mutation.error && <Callout tone="error" role="alert">{describeApiError(mutation.error)}</Callout>}
        <div className="flex flex-wrap justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={() => setDiscarding(true)} disabled={mutation.isPending}>Discard</CTAButton>
          <CTAButton type="main" size="lg" icon={CircleCheckIcon} onClick={apply} disabled={!ready} loading={mutation.isPending} loadingText="Recording…">
            Record {detail.counts.toRecord} reading{detail.counts.toRecord === 1 ? "" : "s"}
          </CTAButton>
        </div>
      </div>
      {discarding && <DiscardDialog detail={detail} onClose={() => setDiscarding(false)} />}
    </MenuCard>
  );
};

const DiscardDialog = ({ detail, onClose }) => {
  const mutation = useImportMutation();
  const [reason, setReason] = useState("");
  return (
    <Dialog title={`Discard ${detail.reference}?`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-primary-text">Nothing from this file is recorded. The file and what was read from it are kept.</p>
        <TextAreaField label="Why (optional)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        {mutation.error && <Callout tone="error" role="alert">{describeApiError(mutation.error)}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Keep it</CTAButton>
          <CTAButton type="danger" size="md" loading={mutation.isPending} onClick={() => mutation.mutate({ action: "discard", id: detail.id, reason: reason.trim() }, { onSuccess: onClose })}>
            Discard
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** A measurement file read into an inspection: what was read, how each feature is matched, and recording it (CM4). */
const ImportPreviewPage = () => {
  const { inspectionId, importId } = useParams();
  const [params] = useSearchParams();
  const back = params.get("back");
  const { can } = usePermissions();
  const { data: detail, isLoading, error } = useInspectionImport(importId);
  const confirm = useImportMutation();
  const [remember, setRemember] = useState(true);
  const editable = detail?.status === "previewed" && detail.canRecord && !detail.expired;
  const header = Object.entries(detail?.header ?? {}).filter(([k, v]) => HEADER_WORDS[k] && v);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to={back || `/Inspections/${inspectionId}`} className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> {detail ? detail.inspection.reference : "Inspection"}
      </Link>
      {isLoading && <LoadingScreen />}
      {error && <Callout tone="error" role="alert">{describeApiError(error)}</Callout>}
      {detail && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-primary-text">{detail.reference}</h1>
            <ImportStatusPill status={detail.status} />
            <span className="text-sm text-secondary-text">
              {detail.fileName} · {detail.profile ? `${detail.profile.name} (version ${detail.profile.version})` : detail.format === "qif" ? "QIF file" : "read without a profile"} · {formatDateTime(detail.createdAt)}
              {detail.createdBy ? ` · ${detail.createdBy}` : ""}
            </span>
          </div>

          {detail.status === "applied" && <Callout tone="success" title="Recorded">These readings are on the inspection{detail.applyMode && detail.applyMode !== "new" ? ` (${detail.applyMode === "retest" ? "as retests" : "as corrections"})` : ""}.</Callout>}
          {detail.status === "discarded" && <Callout tone="info" title="Discarded">Nothing from this file was recorded.{detail.discardReason ? ` “${detail.discardReason}”` : ""}</Callout>}
          {detail.expired && <Callout tone="warning">This preview is over a day old and can no longer be recorded. Upload the file again.</Callout>}

          <div className="flex flex-wrap gap-2" aria-label="What was read">
            <Figure label={detail.counts.parts === 1 ? "part" : "parts"} value={detail.counts.parts} />
            <Figure label="features read" value={detail.counts.features} />
            <Figure label="to record" value={detail.counts.toRecord} />
            <Figure label="not matched" value={detail.counts.unmatched} />
            <Figure label="out of tolerance" value={detail.counts.failures} tone={detail.counts.failures ? "error" : undefined} />
            <Figure label="differ from the plan" value={detail.counts.mismatches} tone={detail.counts.mismatches ? "warning" : undefined} />
            {detail.counts.problems > 0 && <Figure label="cannot be recorded" value={detail.counts.problems} tone="error" />}
          </div>

          {(header.length > 0 || detail.gauge) && (
            <MenuCard title="From the file" subtitle={`Checked against ${detail.inspection.reference} for ${detail.inspection.partNumber}.`}>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
                {header.map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-secondary-text">{HEADER_WORDS[k]}</dt>
                    <dd className="truncate text-primary-text">{String(v)}</dd>
                  </div>
                ))}
                <div className="min-w-0">
                  <dt className="text-secondary-text">Gauge</dt>
                  <dd className="truncate text-primary-text">{detail.gauge?.assetNumber ?? "None chosen"}</dd>
                </div>
              </dl>
            </MenuCard>
          )}

          {detail.warnings.map((w, i) => (
            <Callout key={i} tone="warning">{w.message}</Callout>
          ))}

          {detail.counts.mismatches > 0 && detail.status === "previewed" && (
            detail.mismatchesConfirmedAt ? (
              <Callout tone="success">The differences from the control plan were checked by {detail.mismatchesConfirmedBy ?? "someone"} on {formatDateTime(detail.mismatchesConfirmedAt)}.</Callout>
            ) : (
              <Callout
                tone="warning"
                title={`${detail.counts.mismatches} feature${detail.counts.mismatches === 1 ? "" : "s"} differ from the control plan`}
                action={editable ? (
                  <CTAButton type="secondary" size="md" loading={confirm.isPending} onClick={() => confirm.mutate({ action: "confirm", id: detail.id })}>I have checked them</CTAButton>
                ) : null}>
                The file&apos;s nominal or limits are not the plan&apos;s. That often means the wrong CMM program or an old drawing. Our limits decide pass or fail either way.
              </Callout>
            )
          )}

          {editable && (
            <label className="flex w-fit items-center gap-2 text-sm text-primary-text">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4" />
              Remember the matches I make for {detail.inspection.partNumber}
            </label>
          )}

          {detail.units.map((u) => (
            <MenuCard key={u.id} title={`Part ${u.position}${u.unitReference ? ` · ${u.unitReference}` : ""}`}>
              <UnitTable detail={detail} unit={u} editable={editable} remember={remember} />
            </MenuCard>
          ))}

          {editable && can("inspection.record") && <ApplyCard detail={detail} back={back} />}
        </>
      )}
    </div>
  );
};

export default ImportPreviewPage;
