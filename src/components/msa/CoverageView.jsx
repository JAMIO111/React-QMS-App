import { useState } from "react";
import { Link } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import { describeApiError } from "../../lib/api-client";
import { useMsaCoverage } from "../../hooks/useMsa";
import { usePermissions } from "../../hooks/useQmsApi";
import { COVERAGE_FILTERS, COVERAGE_STATES, coverageOf, msaPath, studyDefaultsFor, typeOf, validityWords } from "../../lib/msa";
import { formatDay } from "../../lib/qualityAlerts";
import { Pill } from "./shared";
import StudyDialog from "./StudyDialog";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text whitespace-nowrap";
const td = "border-b border-border-color px-2 py-2 align-top";

export const CoveragePill = ({ state }) => {
  const s = coverageOf(state);
  return (
    <Pill tone={s.tone} title={s.hint}>
      {s.label}
    </Pill>
  );
};

/** What is known about the study behind a row, in words. */
const studyLine = (row) => {
  if (!row.study) return null;
  const until = row.study.validUntil;
  const expired = row.state === "expired";
  return `${typeOf(row.study.studyType).short} · completed ${row.study.completedAt ? formatDay(row.study.completedAt.slice(0, 10)) : "—"}${until ? ` · ${validityWords({ state: expired ? "expired" : "valid" }, formatDay(until))}` : ""}`;
};

/**
 * Coverage of Gauge R&R: every critical or major characteristic of a control plan in force, the gauge it was measured with in the last 12 months and the
 * state of the latest completed study for that pair. Information only; nothing here blocks recording. Rows that need a study offer to plan one with the
 * gauge, part and characteristic already chosen.
 */
const CoverageView = ({ toggle }) => {
  const { can } = usePermissions();
  const manage = can("calibration.manage");
  const [searchParams, setSearchParams] = useSearchParams();
  const state = searchParams.get("state") || "attention";
  const query = useMsaCoverage({ state });
  const [planning, setPlanning] = useState(null);
  const setState = (key) =>
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (key === "attention") params.delete("state");
      else params.set("state", key);
      return params;
    });
  const data = query.data;
  const counts = data?.counts ?? {};

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 pl-1">
        <h1 className="text-xl font-semibold text-primary-text">Gauge R&amp;R coverage</h1>
        {toggle}
      </div>
      <p className="max-w-3xl text-sm text-secondary-text">
        Critical and major characteristics of control plans in force, with the gauge each was measured with in the last 12 months and what the latest completed study says about that gauge. This is information only: it never stops anyone recording a reading.
      </p>
      {query.isLoading && <LoadingScreen />}
      {query.isError && <Callout tone="error" role="alert">{describeApiError(query.error)}</Callout>}
      {data && !data.available && <Callout tone="info">{data.reason}</Callout>}
      {data?.available && (
        <>
          <div role="group" aria-label="Filter by state" className="flex flex-wrap gap-2">
            {COVERAGE_FILTERS.map((f) => {
              const n = f.key === "attention" ? ["not_accepted", "expired", "no_study", "not_judged", "marginal"].reduce((a, k) => a + (counts[k] ?? 0), 0) : f.key === "all" ? COVERAGE_STATES.reduce((a, s) => a + (counts[s.value] ?? 0), 0) : counts[f.key] ?? 0;
              const on = f.key === state;
              return (
                <button key={f.key} type="button" aria-pressed={on} onClick={() => setState(f.key)} className={`min-h-9.5 cursor-pointer rounded-full border px-3 text-sm ${on ? "border-brand-primary bg-brand-primary text-white" : "border-border-color hover:bg-border-color/40"}`}>
                  {f.label} <span className="tabular-nums opacity-80">{n}</span>
                </button>
              );
            })}
          </div>
          {data.rows.length === 0 ? (
            <p className="text-sm italic text-secondary-text">{state === "attention" ? "Nothing needs attention: every characteristic measured with a gauge has a valid, acceptable study." : "Nothing in this state."}</p>
          ) : (
            <div className="min-w-0 overflow-x-auto rounded-xl border border-border-color">
              <table className="w-full min-w-[900px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Gauge R&R coverage">
                <thead>
                  <tr>
                    <th scope="col" className={th}>Characteristic</th>
                    <th scope="col" className={th}>Plan</th>
                    <th scope="col" className={th}>Gauge</th>
                    <th scope="col" className={th}>Readings (12 months)</th>
                    <th scope="col" className={th}>State</th>
                    <th scope="col" className={th}>Latest study</th>
                    <th scope="col" className={th}>
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={`${r.plan.id}:${r.characteristic.operationCode}:${r.characteristic.key}:${r.gauge?.id ?? "-"}`}>
                      <td className={td}>
                        <div className="font-medium">
                          {r.characteristic.charNumber && <span className="mr-1 text-secondary-text">#{r.characteristic.charNumber}</span>}
                          {r.characteristic.name}
                        </div>
                        <div className="text-xs text-secondary-text">
                          {r.characteristic.operationCode} · {r.characteristic.criticality}
                        </div>
                      </td>
                      <td className={td}>
                        <Link to={`/Process-Control/Plans/${r.plan.id}/revisions/${r.plan.revisionId}`} className="text-link-color hover:underline">
                          {r.plan.code}
                        </Link>
                        <div className="text-xs text-secondary-text">rev {r.plan.revisionCode}</div>
                      </td>
                      <td className={td}>
                        {r.gauge ? (
                          <>
                            <Link to={`/Calibration/Gauges/${r.gauge.id}`} className="text-link-color hover:underline">
                              {r.gauge.assetNumber}
                            </Link>
                            <div className="text-xs text-secondary-text">{r.gauge.description}</div>
                          </>
                        ) : (
                          <span className="text-secondary-text">None recorded</span>
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>{r.gauge ? r.readings : "—"}</td>
                      <td className={td}>
                        <CoveragePill state={r.state} />
                      </td>
                      <td className={td}>
                        {r.study ? (
                          <>
                            <Link to={msaPath(r.study.id)} className="text-link-color hover:underline">
                              {r.study.reference}
                            </Link>
                            <div className="text-xs text-secondary-text">{studyLine(r)}</div>
                          </>
                        ) : (
                          <span className="text-secondary-text">—</span>
                        )}
                      </td>
                      <td className={td}>
                        {manage && r.gauge && r.state !== "acceptable" && r.state !== "no_readings" && (
                          <CTAButton buttonType="button" type="secondary" size="default" onClick={() => setPlanning(r)} aria-label={`Plan a study for ${r.characteristic.name} on ${r.gauge.assetNumber}`}>
                            Plan a study
                          </CTAButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.truncated && <p className="text-xs text-secondary-text">Only the first rows are shown. Narrow the list with a state above.</p>}
        </>
      )}
      {planning && <StudyDialog defaults={studyDefaultsFor(planning)} onClose={() => setPlanning(null)} />}
    </div>
  );
};

export default CoverageView;
