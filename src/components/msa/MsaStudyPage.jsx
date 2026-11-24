import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import LoadingScreen from "../ui/LoadingScreen";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import ReasonDialog from "../ncr/ReasonDialog";
import { TextAreaField } from "../ncr/Pickers";
import { Card } from "../dashboard/DashboardParts";
import { describeApiError } from "../../lib/api-client";
import { useMsaAnalysis, useMsaMutation, useMsaStudy } from "../../hooks/useMsa";
import { usePermissions } from "../../hooks/useQmsApi";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { todayIso } from "../../lib/localDate";
import { CONCLUSIONS, conclusionLabel, fmt, msaPath, msaReportPath, progressWords, typeOf } from "../../lib/msa";
import { formatDay } from "../../lib/qualityAlerts";
import AnalysisView from "./AnalysisView";
import RunSheet from "./RunSheet";
import StudyDialog from "./StudyDialog";
import { Progress, StatusPill, ValidityPill, VerdictPill } from "./shared";

const Fact = ({ label, children }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-xs text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children || "—"}</dd>
  </div>
);

const limitsWords = (d, unit) => {
  const u = unit ? ` ${unit}` : "";
  if (d.lowerLimit == null && d.upperLimit == null) return "";
  return `${d.lowerLimit == null ? "no lower limit" : `${d.lowerLimit}${u}`} to ${d.upperLimit == null ? "no upper limit" : `${d.upperLimit}${u}`}`;
};

const CompleteDialog = ({ study, onClose }) => {
  const mutation = useMsaMutation();
  const [conclusion, setConclusion] = useState("accepted");
  const [note, setNote] = useState("");
  const [validUntil, setValidUntil] = useState(null);
  const [error, setError] = useState("");
  const submit = (e) => {
    e.preventDefault();
    setError("");
    mutation.mutate(
      { path: `/msa/studies/${study.id}/complete`, body: { conclusion, note: note.trim(), ...(validUntil ? { validUntil } : {}) } },
      { onSuccess: onClose, onError: (err) => setError(describeApiError(err)) }
    );
  };
  return (
    <Dialog title={`Complete ${study.reference}`} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <Callout tone="info">Completing works the result out from the readings stored now and freezes it with the study. Readings and design can no longer change; a repeat study starts again from the same design.</Callout>
        <ComboField label="Your conclusion" required value={conclusion} onChange={(v) => setConclusion(v ?? "accepted")} options={CONCLUSIONS} hint="Your judgement, which the numbers inform but do not decide." />
        <TextAreaField label="Why" required value={note} onChange={setNote} maxLength={2000} hint="For example: acceptable for the 0.1 mm tolerance; repeat after the next calibration." />
        <RHFDatePickerPopout label="Valid until" valueFormat="iso" clearable allowPast={false} minDate={todayIso(1)} value={validUntil} onChange={(v) => setValidUntil(v ?? null)} placeholder="12 months from today" hint="Leave empty for twelve months." />
        {error && <Callout tone="error" role="alert">{error}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Back
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={note.trim().length < 3} loading={mutation.isPending}>
            Complete the study
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const StartDialog = ({ study, onClose }) => {
  const mutation = useMsaMutation();
  const [error, setError] = useState("");
  const start = () => mutation.mutate({ path: `/msa/studies/${study.id}/start` }, { onSuccess: onClose, onError: (err) => setError(describeApiError(err)) });
  return (
    <Dialog title="Start collecting readings?" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          This makes the run sheet: every reading to take, in a random order for each appraiser. From then on the design (counts, appraisers, parts, limits) is locked.
        </p>
        {error && <Callout tone="error" role="alert">{error}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Not yet
          </CTAButton>
          <CTAButton buttonType="button" type="main" size="md" loading={mutation.isPending} onClick={start}>
            Start collecting
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** The study: its design, the run sheet while readings are taken, the analysis as it stands, and the frozen result once completed. */
const MsaStudyPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const query = useMsaStudy(id);
  const study = query.data;
  const analysis = useMsaAnalysis(id, { enabled: !!study && study.status !== "draft" && study.status !== "cancelled" });
  const mutation = useMsaMutation();
  const [dialog, setDialog] = useState(null);
  const [error, setError] = useState("");

  useBreadcrumbNames([
    { path: msaPath(id), label: study ? `${study.reference} · ${study.characteristicName}` : null },
    { path: "/Calibration/Gauge-RR", label: "Gauge R&R", to: "/Calibration/Gauge-RR" },
  ]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.isError) return <div className="p-4"><Callout tone="error" role="alert">{describeApiError(query.error)}</Callout></div>;

  const d = study.design;
  const type = typeOf(study.studyType);
  const draft = study.status === "draft";
  const collecting = study.status === "collecting";
  const completed = study.status === "completed";
  const cancelled = study.status === "cancelled";
  const manage = study.canManage;
  const record = study.canRecord;
  const missing = study.studyType === "attribute" && study.parts.some((p) => p.referenceDecision === null);
  const result = analysis.data;
  const repeat = () => {
    setError("");
    mutation.mutate({ path: `/msa/studies/${study.id}/repeat` }, { onSuccess: (s) => s?.id && navigate(msaPath(s.id)), onError: (err) => setError(describeApiError(err)) });
  };

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex flex-wrap items-center gap-2 text-2xl text-primary-text">
            {study.reference}
            <span className="text-secondary-text">·</span>
            <span className="min-w-0 break-words">{study.characteristicName}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={study.status} />
            {(completed || collecting) && <VerdictPill verdict={study.verdict} />}
            {completed && <ValidityPill validity={study.validity} validUntil={study.validUntil ? formatDay(study.validUntil) : null} />}
            <span className="text-sm text-secondary-text">{type.label}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {draft && manage && (
            <>
              <CTAButton buttonType="button" type="neutral" size="default" onClick={() => setDialog("design")}>
                Edit the design
              </CTAButton>
              <CTAButton buttonType="button" type="main" size="default" disabled={missing} title={missing ? "Every sample needs its reference decision first" : undefined} onClick={() => setDialog("start")}>
                Start collecting
              </CTAButton>
            </>
          )}
          {collecting && manage && (
            <CTAButton buttonType="button" type="main" size="default" disabled={!result?.complete} title={result?.complete ? undefined : "Every reading must be in first"} onClick={() => setDialog("complete")}>
              Complete the study
            </CTAButton>
          )}
          {(draft || collecting) && manage && (
            <CTAButton buttonType="button" type="danger" size="default" onClick={() => setDialog("cancel")}>
              Cancel the study
            </CTAButton>
          )}
          {completed && (
            <CTAButton to={msaReportPath(study.id)} type="secondary" size="default">
              Report
            </CTAButton>
          )}
          {completed && can("calibration.manage") && (
            <CTAButton buttonType="button" type="neutral" size="default" loading={mutation.isPending} onClick={repeat} title="A new draft with the same design and no readings">
              Repeat the study
            </CTAButton>
          )}
        </div>
      </div>

      {error && <Callout tone="error" role="alert">{error}</Callout>}
      {cancelled && <Callout tone="info" title="Cancelled">{study.cancelReason}</Callout>}
      {completed && study.validity?.state === "expired" && <Callout tone="warning" title="This study has expired">Repeat it to show the measurement system is still adequate.</Callout>}
      {completed && study.validity?.state === "expiring" && <Callout tone="warning" title="This study expires soon">{`It is valid for ${study.validity.daysLeft} more ${study.validity.daysLeft === 1 ? "day" : "days"}.`}</Callout>}

      <Card title="The study">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Gauge">
            {study.gauge ? (
              <Link to={`/Calibration/Gauges/${study.gauge.id}`} className="text-link-color hover:underline">
                {study.gauge.assetNumber} · {study.gauge.description}
              </Link>
            ) : null}
          </Fact>
          <Fact label="Part">{study.part ? `${study.part.partNumber}${study.part.name ? ` · ${study.part.name}` : ""}` : ""}</Fact>
          <Fact label="Measuring">{`${study.characteristicName}${study.unitCode ? ` (${study.unitCode})` : ""}`}</Fact>
          <Fact label="Limits">{limitsWords(d, study.unitCode)}</Fact>
          <Fact label="Nominal">{d.nominal == null ? "" : fmt(d.nominal, 6)}</Fact>
          {study.studyType === "type1" && <Fact label="Reference value">{d.referenceValue == null ? "" : fmt(d.referenceValue, 6)}</Fact>}
          <Fact label="Gauge resolution">{d.gaugeResolution == null ? "" : fmt(d.gaugeResolution, 6)}</Fact>
          <Fact label="Design">
            {study.studyType === "type1" ? `${study.trialCount} readings` : `${study.partCount} ${study.studyType === "attribute" ? "samples" : "parts"} × ${study.appraiserCount} appraisers × ${study.trialCount} trials`}
          </Fact>
          {study.studyType === "grr_crossed" && <Fact label="Method">{`${d.sigmaMultiplier} × standard deviation; interaction kept when p < ${d.interactionAlpha}`}</Fact>}
          {study.studyType === "type1" && <Fact label="Method">{`Cg uses ${d.kPercent}% of the tolerance and ${d.lMultiplier} standard deviations`}</Fact>}
          <Fact label="Appraisers">{study.appraisers.map((a) => a.name).join(", ")}</Fact>
          <Fact label="Planned by">{`${study.createdBy?.name ?? "—"} on ${formatDay(study.createdAt?.slice(0, 10))}`}</Fact>
          {study.startedAt && <Fact label="Started">{formatDay(study.startedAt.slice(0, 10))}</Fact>}
          {completed && <Fact label="Completed">{`${formatDay(study.completedAt?.slice(0, 10))}${study.completedBy?.name ? ` by ${study.completedBy.name}` : ""}`}</Fact>}
        </dl>
        {completed && (
          <div className="flex flex-col gap-1 border-t border-border-color pt-3 text-sm">
            <p>
              <span className="font-medium">Conclusion:</span> {conclusionLabel(study.conclusion)}
            </p>
            {study.conclusionNote && <p className="text-secondary-text">{study.conclusionNote}</p>}
            <p className="text-xs text-secondary-text">Worked out with algorithm {study.algorithmVersion} against criteria {study.criteriaId}, and frozen with the study.</p>
          </div>
        )}
      </Card>

      {draft && (
        <Callout tone="info" title="Still a draft">
          {missing
            ? "Every sample needs its reference decision. Open the design and set the right answer for each one."
            : "Check the design, then start collecting. The run sheet appears when you do."}
        </Callout>
      )}

      {collecting && (
        <Card title="Run sheet" subtitle={`${progressWords(study.progress)} entered. Enter each reading as you take it; the order is random for each appraiser.`} action={<Progress progress={study.progress} />}>
          <RunSheet study={study} canRecord={record} />
        </Card>
      )}

      {(collecting || completed) && (
        <Card title={completed ? "Result" : "Analysis so far"} subtitle={completed ? "The frozen result." : "Worked out from the readings stored now; it changes as more come in."}>
          {analysis.isLoading && <LoadingScreen size="sm" />}
          {analysis.isError && <Callout tone="error" role="alert">{describeApiError(analysis.error)}</Callout>}
          {result && !result.result && <Callout tone="info">{result.problem ?? "Not enough readings yet."}</Callout>}
          {result?.result && (
            <div className="flex flex-col gap-3">
              {!result.complete && result.problem && <Callout tone="info">{result.problem}</Callout>}
              <AnalysisView result={result.result} study={study} />
            </div>
          )}
        </Card>
      )}

      {dialog === "design" && <StudyDialog study={study} onClose={() => setDialog(null)} />}
      {dialog === "start" && <StartDialog study={study} onClose={() => setDialog(null)} />}
      {dialog === "complete" && <CompleteDialog study={study} onClose={() => setDialog(null)} />}
      {dialog === "cancel" && (
        <ReasonDialog
          title={`Cancel ${study.reference}?`}
          label="Why is it being cancelled?"
          confirmText="Cancel the study"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => mutation.mutate({ path: `/msa/studies/${study.id}/cancel`, body: { reason } }, { onSuccess: () => setDialog(null) })}
        />
      )}
    </div>
  );
};

export default MsaStudyPage;
