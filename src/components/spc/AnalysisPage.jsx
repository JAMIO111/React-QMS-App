import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useSearchParams } from "react-router-dom";
import { CircleAlertIcon } from "@/components/icons";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import { PartPicker } from "../ncr/Pickers";
import { usePart } from "../../hooks/useMasterData";
import { usePartFamilies } from "../../hooks/useProcessControl";
import { useSpcAnalysis, useSpcCharacteristics } from "../../hooks/useSpc";
import { describeApiError } from "../../lib/api-client";
import { KIND_NAME, VERDICT_TEXT, formatCount, formatPercent, formatValue } from "../../lib/spc";
import { ErrorNotice, SelectField } from "../master-data/shared";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top tabular-nums";
const tick = { fontSize: 12, fill: "currentColor" };
const dayStart = (d) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);
const optionKey = (c) => `${c.key}|${c.operationCode}`;
const pct = (v) => (v === null || v === undefined ? "—" : `${v.toFixed(0)} %`);
const idx = (v) => (v === null || v === undefined ? "—" : v.toFixed(2));

/** Mean ± 3σ of each group as a bar, in % of the tolerance (−100 and +100 are the limits), with the mean as a dot. */
const SpreadChart = ({ groups }) => {
  const rows = groups.filter((g) => g.offsetPct !== null).map((g) => ({ label: g.label, range: [g.offsetPct - g.spreadPct / 2, g.offsetPct + g.spreadPct / 2], mean: g.offsetPct, n: g.n }));
  if (!rows.length) return <p className="text-sm text-secondary-text">Both specification limits are needed to show position and spread against the tolerance.</p>;
  const reach = Math.ceil(Math.max(120, ...rows.flatMap((r) => r.range.map(Math.abs))) / 50) * 50;
  const ticks = Array.from({ length: (reach / 50) * 2 + 1 }, (_, i) => -reach + i * 50);
  const spec = "var(--chart-series-2)";
  return (
    <div className="h-72" role="img" aria-label={`Position and spread of ${rows.length} groups against the tolerance`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 12, right: 24, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="label" tick={tick} tickLine={false} interval={0} />
          <YAxis domain={[-reach, reach]} ticks={ticks} tick={tick} tickFormatter={(v) => `${Math.round(v)}%`} width={48} tickLine={false} axisLine={false} />
          <Tooltip formatter={(v, name) => (name === "range" ? [`${v[0].toFixed(0)} % to ${v[1].toFixed(0)} %`, "Mean ± 3σ"] : [`${Number(v).toFixed(0)} %`, "Mean"])} />
          <ReferenceLine y={100} stroke={spec} strokeWidth={2} label={{ value: "USL", position: "insideTopRight", fontSize: 11, fill: spec }} />
          <ReferenceLine y={-100} stroke={spec} strokeWidth={2} label={{ value: "LSL", position: "insideBottomRight", fontSize: 11, fill: spec }} />
          <ReferenceLine y={0} stroke="var(--chart-neutral)" strokeDasharray="4 3" />
          <Bar dataKey="range" name="range" fill="var(--chart-series-1)" fillOpacity={0.45} barSize={36} isAnimationActive={false} />
          <Line dataKey="mean" name="mean" stroke="none" dot={{ r: 5, fill: "var(--chart-series-1)", stroke: "var(--chart-series-1)" }} activeDot={{ r: 6 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

/** Failure rate (pass/fail) or defects per unit (count) per group, against the pooled value. */
const RateChart = ({ groups, overall, kind }) => {
  const isRate = kind === "attribute";
  const rows = groups.map((g) => ({ label: g.label, value: isRate ? g.rate : g.perUnit }));
  const ref = isRate ? overall.rate : overall.perUnit;
  const fmt = (v) => (isRate ? formatPercent(v, 1) : formatCount(v));
  return (
    <div className="h-72" role="img" aria-label={`${isRate ? "Failure rate" : "Defects per unit"} of ${rows.length} groups`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 12, right: 24, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="label" tick={tick} tickLine={false} interval={0} />
          <YAxis tick={tick} tickFormatter={(v) => (isRate ? formatPercent(v, 0) : formatCount(v, 1))} width={52} tickLine={false} axisLine={false} domain={[0, "auto"]} />
          <Tooltip formatter={(v) => [fmt(v), isRate ? "Failure rate" : "Defects per unit"]} />
          {ref !== null && <ReferenceLine y={ref} stroke="var(--chart-neutral)" strokeDasharray="6 4" label={{ value: `All groups ${fmt(ref)}`, position: "insideTopRight", fontSize: 11, fill: "var(--chart-neutral)" }} />}
          <Bar dataKey="value" fill="var(--chart-series-1)" fillOpacity={0.7} barSize={36} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

/**
 * Compares one characteristic between machines (for a part or a whole family) or between the parts of a family, from the
 * recorded inspections. A group is called higher or lower only when it is clearly (3 standard errors) away from all the
 * others together; with few readings that takes a big difference.
 */
const AnalysisPage = () => {
  const [params, setParams] = useSearchParams();
  const scope = params.get("scope") === "family" ? "family" : "part";
  const partId = params.get("part") || "";
  const familyId = params.get("family") || "";
  const by = scope === "part" ? "machine" : params.get("by") === "part" ? "part" : "machine";
  const selected = params.get("c") || "";
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const set = (patch) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) v === null || v === undefined || v === "" ? next.delete(k) : next.set(k, v);
      return next;
    });

  const part = usePart(scope === "part" ? partId : "");
  const families = usePartFamilies();
  const characteristics = useSpcCharacteristics(scope === "part" ? partId : "", { partFamilyId: scope === "family" ? familyId : undefined, all: true });
  const options = characteristics.data ?? [];
  const current = options.find((c) => optionKey(c) === selected) ?? (options.length === 1 ? options[0] : null);
  const analysis = useSpcAnalysis(
    {
      groupBy: by,
      ...(scope === "part" ? { partId } : { partFamilyId: familyId }),
      characteristicKey: current?.key,
      operationCode: current?.operationCode,
      from: dayStart(from),
      to: dayEnd(to),
    },
    !!current,
  );
  const a = analysis.data;
  const kind = a?.characteristic.kind;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-2xl font-semibold text-primary-text">Machine &amp; family analysis</h1>
        <p className="text-sm text-secondary-text">
          Compare one characteristic between machines, or between the parts of a part family, from recorded inspections. Measured values are compared against their tolerance, so parts with different sizes can share one view.
        </p>
      </div>

      <MenuCard title="Compare">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <SelectField
            label="Scope"
            required
            value={scope}
            onChange={(v) => set({ scope: v === "family" ? "family" : "", c: "", by: "" })}
            options={[
              { value: "part", label: "One part, by machine" },
              { value: "family", label: "A part family" },
            ]}
          />
          {scope === "part" ? (
            <PartPicker label="Part" value={partId || null} current={part.data} onChange={(id) => set({ part: id ?? "", c: "" })} />
          ) : (
            <SelectField
              label="Part family"
              value={familyId || null}
              placeholder="Choose a part family"
              onChange={(v) => set({ family: v ?? "", c: "" })}
              options={(families.data?.items ?? []).map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))}
            />
          )}
          {scope === "family" && (
            <SelectField
              label="Compare by"
              required
              value={by}
              onChange={(v) => set({ by: v === "part" ? "part" : "" })}
              options={[
                { value: "machine", label: "Machine (all parts of the family)" },
                { value: "part", label: "Part (within the family)" },
              ]}
            />
          )}
          <SelectField
            label="Characteristic"
            required
            value={current ? optionKey(current) : null}
            disabled={options.length === 0}
            placeholder={(scope === "part" ? partId : familyId) ? (options.length ? "Choose a characteristic" : "No characteristics with readings") : scope === "part" ? "Choose a part first" : "Choose a part family first"}
            onChange={(v) => set({ c: v ?? "" })}
            options={options.map((c) => ({ value: optionKey(c), label: `${c.name} (${c.key}) · ${c.operationCode} · ${c.readings} readings` }))}
          />
          <Field label="From" type="date" value={from} onChange={(e) => set({ from: e.target.value })} />
          <Field label="To" type="date" value={to} onChange={(e) => set({ to: e.target.value })} />
        </div>
      </MenuCard>

      {characteristics.error && <ErrorNotice error={characteristics.error} />}
      {analysis.isLoading && <p className="text-secondary-text">Loading analysis…</p>}
      {analysis.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(analysis.error)}
        </p>
      )}

      {a && (
        <>
          {a.warnings.length > 0 && (
            <ul role="status" className="flex flex-col gap-1 rounded-lg border border-border-color p-3 text-sm text-primary-text">
              {a.warnings.map((w) => (
                <li key={w} className="flex items-start gap-2">
                  <CircleAlertIcon className="mt-0.5 h-4 w-4 shrink-0" /> {w}
                </li>
              ))}
            </ul>
          )}
          <MenuCard
            title={`${a.characteristic.name ?? a.characteristic.key} by ${a.groupBy}`}
            subtitle={`${KIND_NAME[kind]} · ${a.scope.label}${a.characteristic.operationCode ? ` · ${a.characteristic.operationCode}` : ""} · ${a.overall.n} ${kind === "attribute" ? "checks" : kind === "count" ? "units" : "readings"}`}
          >
            {kind === "variable" ? <SpreadChart groups={a.groups} /> : <RateChart groups={a.groups} overall={a.overall} kind={kind} />}
            {kind === "variable" && <p className="mt-1 text-xs text-secondary-text">Bar: mean ± 3σ. Dot: mean. Solid lines: the specification limits (−100 % and +100 %); the dashed line is the middle of the tolerance.</p>}
          </MenuCard>

          <MenuCard title="Groups" subtitle="A group is called higher or lower only when it is clearly different from all the others together.">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Group comparison">
                <thead>
                  <tr>
                    <th scope="col" className={th}>{a.groupBy === "machine" ? "Machine" : "Part"}</th>
                    <th scope="col" className={th}>{kind === "attribute" ? "Checks" : kind === "count" ? "Units" : "Readings"}</th>
                    {kind === "variable" && (
                      <>
                        <th scope="col" className={th}>Mean position</th>
                        <th scope="col" className={th}>Spread (6σ of tolerance)</th>
                        <th scope="col" className={th}>Pp</th>
                        <th scope="col" className={th}>Ppk</th>
                        <th scope="col" className={th}>Out of spec</th>
                      </>
                    )}
                    {kind === "attribute" && (
                      <>
                        <th scope="col" className={th}>Failed</th>
                        <th scope="col" className={th}>Failure rate</th>
                      </>
                    )}
                    {kind === "count" && (
                      <>
                        <th scope="col" className={th}>Defects</th>
                        <th scope="col" className={th}>Per unit</th>
                      </>
                    )}
                    <th scope="col" className={th}>Compared with the rest</th>
                  </tr>
                </thead>
                <tbody>
                  {a.groups.map((g) => (
                    <tr key={g.key}>
                      <th scope="row" className="border-b border-border-color px-2 py-2 text-left font-normal">{g.label}</th>
                      <td className={td}>{g.n}</td>
                      {kind === "variable" && (
                        <>
                          <td className={td}>{pct(g.offsetPct)}{g.spec && g.mean !== null ? <span className="block text-xs text-secondary-text">mean {formatValue(g.mean, 4)} {a.characteristic.unitCode ?? ""}</span> : null}</td>
                          <td className={td}>{pct(g.spreadPct)}</td>
                          <td className={td}>{idx(g.pp)}</td>
                          <td className={`${td} font-medium`}>{idx(g.ppk)}</td>
                          <td className={td}>{g.outOfSpec}</td>
                        </>
                      )}
                      {kind === "attribute" && (
                        <>
                          <td className={td}>{g.failed}</td>
                          <td className={td}>{formatPercent(g.rate, 1)}</td>
                        </>
                      )}
                      {kind === "count" && (
                        <>
                          <td className={td}>{g.defects}</td>
                          <td className={td}>{formatCount(g.perUnit)}</td>
                        </>
                      )}
                      <td className="border-b border-border-color px-2 py-2">{g.verdict ? VERDICT_TEXT[g.verdict] : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </MenuCard>

          {a.excluded.length > 0 && (
            <MenuCard title="Left out" subtitle="Only comparable readings are analysed.">
              <ul className="text-sm text-primary-text" aria-label="Excluded readings">
                {a.excluded.map((e) => (
                  <li key={e.reason}>{e.count} · {e.text}</li>
                ))}
              </ul>
            </MenuCard>
          )}
        </>
      )}
    </div>
  );
};

export default AnalysisPage;
