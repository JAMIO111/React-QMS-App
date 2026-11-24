import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Callout from "../ui/Callout";
import { Card, ChartTooltip, grid, tick } from "../dashboard/DashboardParts";
import { COMPONENT_LABEL, bandWords, fmt, fmtPct, fmtRate, type1Readings } from "../../lib/msa";
import { BandPill } from "./shared";

const SERIES = ["var(--chart-series-1)", "var(--chart-series-2)", "var(--chart-series-3)", "var(--chart-4)", "var(--chart-6)", "var(--chart-9)", "var(--chart-7)", "var(--chart-10)", "var(--chart-8)", "var(--chart-5)"];
const colourOf = (i) => SERIES[i % SERIES.length];

const Figure = ({ label, value, note, band }) => (
  <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-border-color bg-primary-bg px-3 py-2" data-figure={label}>
    <span className="text-xs text-secondary-text">{label}</span>
    <span className="text-xl font-semibold tabular-nums text-primary-text">{value}</span>
    {(note || band) && <span className="text-xs text-secondary-text">{band ? bandWords(band) : note}{band && note ? ` · ${note}` : ""}</span>}
  </div>
);

const Th = ({ children, right }) => <th className={`px-3 py-2 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>;
const Td = ({ children, right, strong }) => <td className={`px-3 py-1.5 ${right ? "text-right tabular-nums" : ""} ${strong ? "font-semibold" : ""}`}>{children}</td>;
const Table = ({ label, children }) => (
  <div className="overflow-x-auto rounded-lg border border-border-color">
    <table aria-label={label} className="w-full min-w-max border-collapse text-sm">
      {children}
    </table>
  </div>
);

export const Warnings = ({ warnings = [] }) =>
  warnings.length === 0 ? null : (
    <div className="flex flex-col gap-2" aria-label="Warnings">
      {warnings.map((w) => (
        <Callout key={w.code} tone={w.level === "warning" ? "warning" : "info"}>
          {w.text}
        </Callout>
      ))}
    </div>
  );

const Verdict = ({ verdict }) => (
  <div className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">Measurement system:</span>
      <BandPill band={verdict?.band ?? null} />
    </div>
    {verdict?.reasons?.length > 0 && (
      <ul className="list-disc pl-5 text-sm text-secondary-text">
        {verdict.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    )}
  </div>
);

/** The shares of the variation each part of the system takes, as bars: three measures side by side for each component. */
const ComponentsChart = ({ variation, tolerance }) => {
  const rows = ["grr", "repeatability", "reproducibility", "part"].map((name) => {
    const v = variation.find((x) => x.name === name);
    return { name: COMPONENT_LABEL[name].replace(/ \(.*\)/, ""), contribution: v?.pctContribution ?? null, study: v?.pctStudyVar ?? null, tolerance: v?.pctTolerance ?? null };
  });
  return (
    <div role="img" aria-label="Components of variation: percent contribution, percent of study variation and percent of tolerance for gauge R&R, repeatability, reproducibility and part to part. The same figures are in the table above." className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="name" tick={tick} interval={0} angle={-25} textAnchor="end" height={64} />
          <YAxis tick={tick} unit="%" />
          <Tooltip content={<ChartTooltip valueFormat={(v) => fmtPct(v)} />} />
          <Bar dataKey="contribution" name="% contribution" fill="var(--chart-series-1)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="study" name="% study variation" fill="var(--chart-series-2)" radius={[4, 4, 0, 0]} />
          {tolerance && <Bar dataKey="tolerance" name="% tolerance" fill="var(--chart-series-3)" radius={[4, 4, 0, 0]} />}
          <ReferenceLine y={10} stroke="var(--chart-warning)" strokeDasharray="4 4" />
          <ReferenceLine y={30} stroke="var(--chart-critical)" strokeDasharray="4 4" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

const LegendRow = ({ names }) => (
  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-text" aria-label="Appraisers">
    {names.map((n, i) => (
      <li key={n} className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colourOf(i) }} aria-hidden="true" />
        {n}
      </li>
    ))}
  </ul>
);

/** Range or average points by part, one line per appraiser, with the chart's own limits. */
const LimitChart = ({ chart, names, label, valueLabel }) => {
  const parts = [...new Set(chart.points.map((p) => p.part))].sort((a, b) => a - b);
  const data = parts.map((part) => {
    const row = { part };
    chart.points.filter((p) => p.part === part).forEach((p) => {
      row[`a${p.appraiser}`] = p.value;
    });
    return row;
  });
  return (
    <div className="flex flex-col gap-2">
      <LegendRow names={names} />
      <div role="img" aria-label={`${label}: ${chart.points.length} points by part, centre ${fmt(chart.centre, 4)}, upper limit ${fmt(chart.ucl, 4)}, lower limit ${fmt(chart.lcl, 4)}.`} className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="part" tick={tick} label={{ value: "Part", position: "insideBottom", offset: -2, className: "fill-secondary-text", fontSize: 11 }} height={32} />
            <YAxis tick={tick} domain={["auto", "auto"]} />
            <Tooltip content={<ChartTooltip labelFormat={(l) => `Part ${l}`} valueFormat={(v) => fmt(v, 4)} />} />
            <ReferenceLine y={chart.ucl} stroke="var(--chart-critical)" strokeDasharray="5 4" label={{ value: "UCL", position: "right", fontSize: 10, fill: "currentColor" }} />
            <ReferenceLine y={chart.centre} stroke="var(--chart-grid)" strokeWidth={2} />
            {chart.lcl > 0 || valueLabel === "mean" ? <ReferenceLine y={chart.lcl} stroke="var(--chart-critical)" strokeDasharray="5 4" label={{ value: "LCL", position: "right", fontSize: 10, fill: "currentColor" }} /> : null}
            {names.map((n, i) => (
              <Line key={n} type="linear" dataKey={`a${i + 1}`} name={n} stroke={colourOf(i)} strokeWidth={1.5} dot={{ r: 3 }} isAnimationActive={false} connectNulls />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

/** Each appraiser's average for each part: lines that run together mean the people agree; lines that cross mean they do not. */
const InteractionChart = ({ cellMeans, names }) => {
  const parts = cellMeans[0]?.length ?? 0;
  const data = Array.from({ length: parts }, (_, p) => {
    const row = { part: p + 1 };
    cellMeans.forEach((byPart, a) => {
      row[`a${a + 1}`] = byPart[p];
    });
    return row;
  });
  return (
    <div className="flex flex-col gap-2">
      <LegendRow names={names} />
      <div role="img" aria-label="Average of each appraiser for each part. Lines that follow each other mean the appraisers agree." className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="part" tick={tick} height={32} label={{ value: "Part", position: "insideBottom", offset: -2, className: "fill-secondary-text", fontSize: 11 }} />
            <YAxis tick={tick} domain={["auto", "auto"]} />
            <Tooltip content={<ChartTooltip labelFormat={(l) => `Part ${l}`} valueFormat={(v) => fmt(v, 4)} />} />
            {names.map((n, i) => (
              <Line key={n} type="linear" dataKey={`a${i + 1}`} name={n} stroke={colourOf(i)} strokeWidth={1.5} dot={{ r: 3 }} isAnimationActive={false} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

const CrossedView = ({ result, names }) => {
  const rowsByName = Object.fromEntries(result.variation.map((v) => [v.name, v]));
  const grr = rowsByName.grr;
  const tolerance = result.options?.tolerance;
  const range = result.rangeMethod;
  return (
    <div className="flex flex-col gap-4">
      <Verdict verdict={result.verdict} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Gauge R&R, % of study variation" value={fmtPct(grr?.pctStudyVar)} note="under 10 is acceptable, over 30 is not" />
        <Figure label="Gauge R&R, % of tolerance" value={tolerance ? fmtPct(grr?.pctTolerance) : "—"} note={tolerance ? `tolerance ${fmt(tolerance, 4)}` : "needs both limits"} />
        <Figure label="Gauge R&R, % contribution" value={fmtPct(grr?.pctContribution)} />
        <Figure label="Distinct categories" value={result.ndc ?? "—"} note="5 or more is needed" />
      </div>

      <Card title="Variation" subtitle={`Study variation = ${result.options?.sigma ?? 6} × the standard deviation of each component.`}>
        <Table label="Components of variation">
          <thead>
            <tr className="bg-secondary-bg">
              <Th>Source</Th>
              <Th right>Variance</Th>
              <Th right>Std dev</Th>
              <Th right>Study variation</Th>
              <Th right>% contribution</Th>
              <Th right>% study variation</Th>
              <Th right>% tolerance</Th>
            </tr>
          </thead>
          <tbody>
            {result.variation.map((v) => (
              <tr key={v.name} className="border-t border-border-color">
                <Td strong={v.name === "grr" || v.name === "total"}>{COMPONENT_LABEL[v.name] ?? v.name}</Td>
                <Td right>{fmt(v.variance, 6)}</Td>
                <Td right>{fmt(v.sd, 5)}</Td>
                <Td right>{fmt(v.studyVariation, 5)}</Td>
                <Td right>{fmtPct(v.pctContribution)}</Td>
                <Td right>{fmtPct(v.pctStudyVar)}</Td>
                <Td right>{v.pctTolerance === null ? "—" : fmtPct(v.pctTolerance)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <ComponentsChart variation={result.variation} tolerance={!!tolerance} />
        <p className="text-xs text-secondary-text">Dashed lines mark 10% and 30%, the usual limits for acceptable and not acceptable.</p>
      </Card>

      <Card title="Analysis of variance" subtitle={`Part × appraiser term ${result.anova.interactionKept ? "kept" : "pooled"}${result.anova.interactionP == null ? "" : ` (p = ${fmt(result.anova.interactionP, 4)}, tested at ${result.anova.alpha})`}.`}>
        <Table label="Analysis of variance">
          <thead>
            <tr className="bg-secondary-bg">
              <Th>Source</Th>
              <Th right>df</Th>
              <Th right>SS</Th>
              <Th right>MS</Th>
              <Th right>F</Th>
              <Th right>p</Th>
            </tr>
          </thead>
          <tbody>
            {result.anova.rows.map((r) => (
              <tr key={r.source} className="border-t border-border-color">
                <Td>{r.source === "total" ? "Total" : COMPONENT_LABEL[r.source] ?? r.source}</Td>
                <Td right>{r.df}</Td>
                <Td right>{fmt(r.ss, 6)}</Td>
                <Td right>{fmt(r.ms, 6)}</Td>
                <Td right>{fmt(r.f, 3)}</Td>
                <Td right>{r.p === null ? "—" : fmt(r.p, 4)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {result.anova.clamped?.length > 0 && <p className="text-xs text-secondary-text">A negative estimate was set to zero for: {result.anova.clamped.map((c) => COMPONENT_LABEL[c] ?? c).join(", ")}.</p>}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Range chart" subtitle="Is every appraiser measuring with the same consistency? Points above the upper limit are not.">
          <LimitChart chart={result.charts.range} names={names} label="Range chart" valueLabel="range" />
          {result.charts.range.outside.length > 0 ? <p className="text-xs text-secondary-text">{result.charts.range.outside.length} {result.charts.range.outside.length === 1 ? "range is" : "ranges are"} above the upper limit.</p> : <p className="text-xs text-secondary-text">Every range is inside its limit.</p>}
        </Card>
        <Card title="Average chart" subtitle="The parts should differ from each other: most points should be outside these limits, which describe the gauge's noise.">
          <LimitChart chart={result.charts.average} names={names} label="Average chart" valueLabel="mean" />
          <p className="text-xs text-secondary-text">{fmtRate(result.charts.average.fractionOutside, 0)} of the averages are outside the limits (50% or more is wanted).</p>
        </Card>
        <Card title="Part by appraiser" subtitle="Lines that follow each other mean the appraisers agree about every part.">
          <InteractionChart cellMeans={result.charts.cellMeans} names={names} />
        </Card>
        {range?.available ? (
          <Card title="Average and range method" subtitle="The older hand method, for comparison with the analysis of variance.">
            <Table label="Average and range method">
              <tbody>
                {[
                  ["Repeatability (equipment variation)", range.repeatability],
                  ["Reproducibility (appraiser variation)", range.reproducibility],
                  ["Gauge R&R", range.grr],
                  ["Part variation", range.partVariation],
                  ["Total variation", range.totalVariation],
                ].map(([l, v]) => (
                  <tr key={l} className="border-t border-border-color first:border-t-0">
                    <Td>{l}</Td>
                    <Td right>{fmt(v, 5)}</Td>
                  </tr>
                ))}
                <tr className="border-t border-border-color">
                  <Td>Gauge R&R, % of study variation</Td>
                  <Td right>{fmtPct(range.pctStudyVar)}</Td>
                </tr>
                <tr className="border-t border-border-color">
                  <Td>Distinct categories</Td>
                  <Td right>{range.ndc ?? "—"}</Td>
                </tr>
              </tbody>
            </Table>
          </Card>
        ) : (
          <Card title="Average and range method">
            <p className="text-sm text-secondary-text">{range?.reason ?? "Not available for this design."}</p>
          </Card>
        )}
      </div>
      <Warnings warnings={result.warnings} />
    </div>
  );
};

/** The readings in the order taken, with the reference value and the tolerance band when there is one. */
const Type1Chart = ({ readings, result }) => {
  const data = readings.map((r, i) => ({ trial: i + 1, value: r }));
  const lo = result.tolerance != null ? result.reference - result.tolerance / 2 : null;
  const hi = result.tolerance != null ? result.reference + result.tolerance / 2 : null;
  return (
    <div role="img" aria-label={`Readings in order against the reference value ${fmt(result.reference, 5)}; mean ${fmt(result.mean, 5)}.`} className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...grid} />
          <XAxis dataKey="trial" tick={tick} height={32} label={{ value: "Reading", position: "insideBottom", offset: -2, className: "fill-secondary-text", fontSize: 11 }} />
          <YAxis tick={tick} domain={["auto", "auto"]} />
          <Tooltip content={<ChartTooltip labelFormat={(l) => `Reading ${l}`} valueFormat={(v) => fmt(v, 5)} />} />
          {hi !== null && <ReferenceLine y={hi} stroke="var(--chart-warning)" strokeDasharray="5 4" />}
          {lo !== null && <ReferenceLine y={lo} stroke="var(--chart-warning)" strokeDasharray="5 4" />}
          <ReferenceLine y={result.reference} stroke="var(--chart-series-3)" strokeWidth={2} />
          <ReferenceLine y={result.mean} stroke="var(--chart-series-2)" strokeDasharray="2 3" />
          <Line type="linear" dataKey="value" name="Reading" stroke="var(--chart-series-1)" dot={{ r: 3 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

const Type1View = ({ result, readings }) => (
  <div className="flex flex-col gap-4">
    <Verdict verdict={result.verdict} />
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Figure label="Cg" value={fmt(result.cg, 2)} note="1.33 or more is needed" />
      <Figure label="Cgk" value={fmt(result.cgk, 2)} note="includes the bias" />
      <Figure label="Bias" value={fmt(result.bias, 5)} note={result.biasP == null ? "" : `p = ${fmt(result.biasP, 4)}`} />
      <Figure label="Readings" value={result.n} note={`mean ${fmt(result.mean, 5)}, std dev ${fmt(result.sd, 5)}`} />
    </div>
    <Card title="Readings against the reference" subtitle="Solid green is the reference value, dotted orange the mean of the readings, dashed lines the tolerance.">
      <Type1Chart readings={readings} result={result} />
    </Card>
    <Card title="Figures">
      <Table label="Type 1 figures">
        <tbody>
          {[
            ["Reference value", fmt(result.reference, 5)],
            ["Mean", fmt(result.mean, 5)],
            ["Standard deviation", fmt(result.sd, 5)],
            ["Smallest and largest", `${fmt(result.min, 5)} and ${fmt(result.max, 5)}`],
            ["Bias (mean − reference)", fmt(result.bias, 5)],
            ["Bias t statistic and p", `${fmt(result.biasT, 3)} and ${fmt(result.biasP, 4)}`],
            ["Tolerance", result.tolerance == null ? "—" : fmt(result.tolerance, 5)],
            ["Repeatability, % of tolerance", fmtPct(result.pctRepeatability)],
            ["Repeatability and bias, % of tolerance", fmtPct(result.pctRepeatabilityAndBias)],
            ["Resolution, % of tolerance", fmtPct(result.resolutionPct)],
          ].map(([l, v]) => (
            <tr key={l} className="border-t border-border-color first:border-t-0">
              <Td>{l}</Td>
              <Td right>{v}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
    <Warnings warnings={result.warnings} />
  </div>
);

const AttributeView = ({ result, names }) => (
  <div className="flex flex-col gap-4">
    <Verdict verdict={result.verdict} />
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Figure label="Effectiveness" value={fmtRate(result.overall.effectiveness)} note="90% or more is acceptable" />
      <Figure label="Miss rate" value={fmtRate(result.overall.missRate)} note="bad parts accepted" />
      <Figure label="False alarm rate" value={fmtRate(result.overall.falseAlarmRate)} note="good parts rejected" />
      <Figure label="Between appraisers" value={fmtRate(result.between.rate)} note={`kappa ${fmt(result.kappaBetween, 2)}`} />
    </div>
    <Card title="Each appraiser" subtitle="Agreement with themselves on every trial, and with the standard.">
      <Table label="Appraisers">
        <thead>
          <tr className="bg-secondary-bg">
            <Th>Appraiser</Th>
            <Th right>Within themselves</Th>
            <Th right>With the standard</Th>
            <Th right>Effectiveness</Th>
            <Th right>Miss rate</Th>
            <Th right>False alarm rate</Th>
            <Th right>Kappa vs standard</Th>
            <Th>Result</Th>
          </tr>
        </thead>
        <tbody>
          {result.appraisers.map((a, i) => (
            <tr key={a.appraiser} className="border-t border-border-color">
              <Td strong>{names[i] ?? `Appraiser ${a.appraiser}`}</Td>
              <Td right>{`${fmtRate(a.within.rate, 0)} (${a.within.matched}/${a.within.total})`}</Td>
              <Td right>{`${fmtRate(a.vsStandard.rate, 0)} (${a.vsStandard.matched}/${a.vsStandard.total})`}</Td>
              <Td right>{fmtRate(a.effectiveness, 0)}</Td>
              <Td right>{fmtRate(a.missRate, 0)}</Td>
              <Td right>{fmtRate(a.falseAlarmRate, 0)}</Td>
              <Td right>{fmt(a.kappaVsStandard, 2)}</Td>
              <Td>
                <BandPill band={a.verdict} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
    <Card title="All appraisers together">
      <Table label="All appraisers">
        <tbody>
          {[
            ["Samples (good / bad)", `${result.design.samples} (${result.design.goodSamples} / ${result.design.badSamples})`],
            ["All appraisers agree with each other", `${fmtRate(result.between.rate, 0)} (${result.between.matched}/${result.between.total})`],
            ["All appraisers agree with the standard", `${fmtRate(result.allVsStandard.rate, 0)} (${result.allVsStandard.matched}/${result.allVsStandard.total})`],
          ].map(([l, v]) => (
            <tr key={l} className="border-t border-border-color first:border-t-0">
              <Td>{l}</Td>
              <Td right>{v}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
    <Warnings warnings={result.warnings} />
  </div>
);

/** The analysis of a study of any kind, in words, tables and charts. `result` is `{ studyType, … }` from the analysis endpoint. */
const AnalysisView = ({ result, study }) => {
  const names = (study.appraisers ?? []).map((a) => a.name);
  if (!result) return null;
  if (result.studyType === "grr_crossed") return <CrossedView result={result} names={names} />;
  if (result.studyType === "type1") return <Type1View result={result} readings={type1Readings(study)} />;
  if (result.studyType === "attribute") return <AttributeView result={result} names={names} />;
  return null;
};

export default AnalysisView;
