import { useState } from "react";
import { Link } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import { describeApiError } from "../../lib/api-client";
import { useGaugeMsa } from "../../hooks/useMsa";
import { usePermissions } from "../../hooks/useQmsApi";
import { msaPath, typeOf } from "../../lib/msa";
import { formatDay } from "../../lib/qualityAlerts";
import { headlineWords } from "./msaColumns";
import StudyDialog from "./StudyDialog";
import { StatusPill, ValidityPill, VerdictPill } from "./shared";

const Line = ({ study }) => (
  <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-color px-3 py-2">
    <div className="flex min-w-0 flex-col">
      <Link to={msaPath(study.id)} className="font-medium text-link-color hover:underline">
        {study.reference} · {study.characteristicName}
      </Link>
      <span className="text-xs text-secondary-text">
        {typeOf(study.studyType).short}
        {study.part ? ` on ${study.part.partNumber}` : ""}
        {study.completedAt ? ` · completed ${formatDay(study.completedAt.slice(0, 10))}` : ""}
        {headlineWords(study) ? ` · ${headlineWords(study)}` : ""}
      </span>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {study.status === "completed" ? (
        <>
          <VerdictPill verdict={study.verdict} />
          <ValidityPill validity={study.validity} validUntil={study.validUntil ? formatDay(study.validUntil) : null} />
        </>
      ) : (
        <StatusPill status={study.status} />
      )}
    </div>
  </li>
);

/**
 * What is known about how well this gauge measures: the latest completed study for each characteristic (and how long it stays valid), the studies still
 * being worked on, and the earlier ones. Information only: a poor result never changes the gauge.
 */
const GaugeStudies = ({ gauge }) => {
  const { can } = usePermissions();
  const query = useGaugeMsa(gauge.id);
  const [planning, setPlanning] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  if (query.isLoading) return <LoadingScreen size="sm" />;
  if (query.isError) return <Callout tone="error" role="alert">{describeApiError(query.error)}</Callout>;
  const { current, open, earlier } = query.data;
  const none = current.length + open.length + earlier.length === 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm text-secondary-text">
          Gauge R&R, bias and agreement studies that show how much of what this gauge reads is the gauge itself. They never change the gauge's status.
        </p>
        {can("calibration.manage") && (
          <CTAButton buttonType="button" type="secondary" size="default" onClick={() => setPlanning(true)}>
            Plan a study
          </CTAButton>
        )}
      </div>
      {none && <p className="text-sm italic text-secondary-text">No studies yet.</p>}
      {current.length > 0 && (
        <section aria-label="Current studies" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary-text">Current</h3>
          <ul className="flex flex-col gap-2">{current.map((s) => <Line key={s.id} study={s} />)}</ul>
        </section>
      )}
      {open.length > 0 && (
        <section aria-label="Studies in progress" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary-text">In progress</h3>
          <ul className="flex flex-col gap-2">{open.map((s) => <Line key={s.id} study={s} />)}</ul>
        </section>
      )}
      {earlier.length > 0 && (
        <div className="flex flex-col gap-2">
          <button type="button" className="w-fit cursor-pointer text-sm text-link-color hover:underline" aria-expanded={showEarlier} onClick={() => setShowEarlier((v) => !v)}>
            {showEarlier ? "Hide earlier studies" : `Show ${earlier.length} earlier ${earlier.length === 1 ? "study" : "studies"}`}
          </button>
          {showEarlier && <ul className="flex flex-col gap-2">{earlier.map((s) => <Line key={s.id} study={s} />)}</ul>}
        </div>
      )}
      <Link to={`/Calibration/Gauge-RR?gauge=${gauge.id}`} className="w-fit text-sm text-link-color hover:underline">
        All studies of this gauge
      </Link>
      {planning && <StudyDialog defaultGauge={gauge} onClose={() => setPlanning(false)} />}
    </div>
  );
};

export default GaugeStudies;
