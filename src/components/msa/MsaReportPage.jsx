import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import { describeApiError } from "../../lib/api-client";
import { useMsaReport } from "../../hooks/useMsa";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { COMPONENT_LABEL, bandWords, cellKey, cellMap, conclusionLabel, fmt, fmtPct, fmtRate, msaPath, msaReportPath, typeOf, validityWords } from "../../lib/msa";
import { formatDay } from "../../lib/qualityAlerts";

const Section = ({ title, children }) => (
  <section className="break-inside-avoid-page flex flex-col gap-2 border-t border-gray-300 pt-3" aria-label={title}>
    <h2 className="text-base font-semibold">{title}</h2>
    {children}
  </section>
);
const Row = ({ label, children }) => (
  <tr className="border-b border-gray-200">
    <th scope="row" className="w-1/3 py-1 pr-2 text-left font-normal text-gray-600">{label}</th>
    <td className="py-1">{children || "—"}</td>
  </tr>
);

const Variation = ({ result }) => (
  <table className="w-full text-left text-sm">
    <thead>
      <tr className="border-b border-gray-300">
        <th className="py-1 pr-2">Source</th>
        <th className="pr-2 text-right">Std dev</th>
        <th className="pr-2 text-right">Study variation</th>
        <th className="pr-2 text-right">% contribution</th>
        <th className="pr-2 text-right">% study variation</th>
        <th className="text-right">% tolerance</th>
      </tr>
    </thead>
    <tbody>
      {result.variation.map((v) => (
        <tr key={v.name} className="border-b border-gray-200">
          <td className="py-1 pr-2">{COMPONENT_LABEL[v.name] ?? v.name}</td>
          <td className="pr-2 text-right tabular-nums">{fmt(v.sd, 5)}</td>
          <td className="pr-2 text-right tabular-nums">{fmt(v.studyVariation, 5)}</td>
          <td className="pr-2 text-right tabular-nums">{fmtPct(v.pctContribution)}</td>
          <td className="pr-2 text-right tabular-nums">{fmtPct(v.pctStudyVar)}</td>
          <td className="text-right tabular-nums">{v.pctTolerance === null ? "—" : fmtPct(v.pctTolerance)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const Readings = ({ study }) => {
  const cells = cellMap(study.cells);
  const attribute = study.studyType === "attribute";
  const trials = Array.from({ length: study.trialCount }, (_, i) => i + 1);
  const show = (c) => (!c ? "" : attribute ? (c.decision ? "A" : "R") : c.value);
  if (study.studyType === "type1") {
    return (
      <p className="break-words font-mono text-sm tabular-nums">{trials.map((t) => cells[cellKey(1, 1, t)]?.value).join("  ")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {study.appraisers.map((a) => (
        <div key={a.position} className="break-inside-avoid-page">
          <h3 className="text-sm font-medium">{a.name}</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-300 text-left">
                <th className="py-1 pr-2">{attribute ? "Sample" : "Part"}</th>
                {trials.map((t) => (
                  <th key={t} className="pr-2 text-right">Trial {t}</th>
                ))}
                {attribute && <th className="text-right">Reference</th>}
              </tr>
            </thead>
            <tbody>
              {study.parts.map((p) => (
                <tr key={p.position} className="border-b border-gray-200">
                  <td className="py-0.5 pr-2">{p.label}</td>
                  {trials.map((t) => (
                    <td key={t} className="pr-2 text-right font-mono tabular-nums">{show(cells[cellKey(a.position, p.position, t)])}</td>
                  ))}
                  {attribute && <td className="text-right">{p.referenceDecision ? "A" : "R"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {attribute && <p className="text-xs text-gray-600">A = accept, R = reject.</p>}
    </div>
  );
};

const Summary = ({ result }) => {
  if (result.studyType === "grr_crossed") return <Variation result={result} />;
  if (result.studyType === "type1") {
    return (
      <table className="w-full text-sm">
        <tbody>
          <Row label="Cg and Cgk">{`${fmt(result.cg, 2)} and ${fmt(result.cgk, 2)}`}</Row>
          <Row label="Bias">{`${fmt(result.bias, 5)} (p = ${fmt(result.biasP, 4)})`}</Row>
          <Row label="Mean and standard deviation">{`${fmt(result.mean, 5)} and ${fmt(result.sd, 5)}`}</Row>
          <Row label="Repeatability, % of tolerance">{fmtPct(result.pctRepeatability)}</Row>
          <Row label="Repeatability and bias, % of tolerance">{fmtPct(result.pctRepeatabilityAndBias)}</Row>
        </tbody>
      </table>
    );
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-gray-300">
          <th className="py-1 pr-2">Appraiser</th>
          <th className="pr-2 text-right">Within</th>
          <th className="pr-2 text-right">With standard</th>
          <th className="pr-2 text-right">Effectiveness</th>
          <th className="pr-2 text-right">Miss rate</th>
          <th className="pr-2 text-right">False alarm</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {result.appraisers.map((a) => (
          <tr key={a.appraiser} className="border-b border-gray-200">
            <td className="py-1 pr-2">{a.appraiser}</td>
            <td className="pr-2 text-right tabular-nums">{fmtRate(a.within.rate, 0)}</td>
            <td className="pr-2 text-right tabular-nums">{fmtRate(a.vsStandard.rate, 0)}</td>
            <td className="pr-2 text-right tabular-nums">{fmtRate(a.effectiveness, 0)}</td>
            <td className="pr-2 text-right tabular-nums">{fmtRate(a.missRate, 0)}</td>
            <td className="pr-2 text-right tabular-nums">{fmtRate(a.falseAlarmRate, 0)}</td>
            <td>{bandWords(a.verdict)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** A completed study as one printable document (`/Calibration/Gauge-RR/:id/report`). Print or "Save as PDF" from the browser: only the report is printed. */
const MsaReportPage = () => {
  const { id } = useParams();
  const query = useMsaReport(id);
  useBreadcrumbNames([
    { path: msaReportPath(id), label: "Report" },
    { path: msaPath(id), label: query.data ? `${query.data.study.reference} · ${query.data.study.characteristicName}` : null },
    { path: "/Calibration/Gauge-RR", label: "Gauge R&R", to: "/Calibration/Gauge-RR" },
  ]);
  if (query.isLoading) return <p className="p-4 text-sm text-secondary-text">Loading…</p>;
  if (query.isError) return <div className="p-4"><Callout tone="error" role="alert">{describeApiError(query.error)}</Callout></div>;
  const { study, result, dataHash, dataMatchesResult } = query.data;
  const d = study.design;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 overflow-y-auto p-4">
      <style>{"@media print { body * { visibility: hidden !important; } #msa-report, #msa-report * { visibility: visible !important; } #msa-report { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; box-shadow: none; } }"}</style>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={msaPath(study.id)} className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
          <ArrowLeftIcon className="h-4 w-4" /> Back to the study
        </Link>
        <CTAButton buttonType="button" type="secondary" size="md" onClick={() => window.print()}>
          Print or save as PDF
        </CTAButton>
      </div>
      {!dataMatchesResult && <Callout tone="error" role="alert" title="The stored readings no longer match the frozen result">Something changed the readings after the study was completed. Do not rely on this result until it has been looked into.</Callout>}

      <article id="msa-report" className="mx-auto flex w-full max-w-4xl flex-col gap-3 rounded-lg bg-white p-6 text-sm text-gray-900 shadow">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{typeOf(study.studyType).label}: {study.reference}</h1>
          <p className="text-gray-600">{study.characteristicName}{study.part ? ` on ${study.part.partNumber}` : ""}, measured with {study.gauge?.assetNumber} ({study.gauge?.description})</p>
        </header>

        <Section title="The study">
          <table className="w-full text-sm"><tbody>
            <Row label="Limits">{d.lowerLimit == null && d.upperLimit == null ? "" : `${d.lowerLimit ?? "—"} to ${d.upperLimit ?? "—"}${study.unitCode ? ` ${study.unitCode}` : ""}`}</Row>
            <Row label="Design">{study.studyType === "type1" ? `${study.trialCount} readings of one part` : `${study.partCount} ${study.studyType === "attribute" ? "samples" : "parts"} × ${study.appraiserCount} appraisers × ${study.trialCount} trials`}</Row>
            <Row label="Appraisers">{study.appraisers.map((a) => a.name).join(", ")}</Row>
            <Row label="Completed">{`${formatDay(study.completedAt?.slice(0, 10))}${study.completedBy?.name ? ` by ${study.completedBy.name}` : ""}`}</Row>
            <Row label="Valid">{validityWords(study.validity, study.validUntil ? formatDay(study.validUntil) : null)}</Row>
          </tbody></table>
        </Section>

        <Section title="Conclusion">
          <p className="font-medium">{conclusionLabel(study.conclusion)}</p>
          {study.conclusionNote && <p>{study.conclusionNote}</p>}
        </Section>

        {result && (
          <Section title="Result">
            <p>
              <span className="font-medium">Measurement system:</span> {bandWords(result.verdict?.band ?? null)}
            </p>
            {result.verdict?.reasons?.length > 0 && (
              <ul className="list-disc pl-5">
                {result.verdict.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            )}
            <Summary result={result} />
            {result.studyType === "grr_crossed" && <p>Distinct categories: {result.ndc ?? "—"} (5 or more is needed).</p>}
            {result.warnings?.length > 0 && (
              <ul className="list-disc pl-5 text-gray-700">
                {result.warnings.map((w) => <li key={w.code}>{w.text}</li>)}
              </ul>
            )}
          </Section>
        )}

        <Section title="Readings">
          <Readings study={study} />
        </Section>

        <footer className="border-t border-gray-300 pt-2 text-xs text-gray-600">
          <p>Worked out with algorithm {study.algorithmVersion} against criteria {study.criteriaId}. Data fingerprint (SHA-256): <span className="break-all font-mono">{dataHash}</span></p>
          <p>{dataMatchesResult ? "The stored readings still give this fingerprint." : "The stored readings no longer give this fingerprint."}</p>
        </footer>
      </article>
    </div>
  );
};

export default MsaReportPage;
