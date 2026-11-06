import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CircleAlertIcon } from "@/components/icons";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import { PartPicker } from "../ncr/Pickers";
import { usePart } from "../../hooks/useMasterData";
import { useMachines } from "../../hooks/useProcessControl";
import { useSpcCharacteristics, useSpcChart } from "../../hooks/useSpc";
import { describeApiError } from "../../lib/api-client";
import { formatDateTime } from "../../lib/processControl";
import {
  CHART_NAME,
  DISPERSION_NAME,
  LOCATION_NAME,
  RULES,
  RULE_LABEL,
  chartRows,
  decimalsOf,
  formatValue,
} from "../../lib/spc";
import { ErrorNotice, SelectField } from "../master-data/shared";
import BaselinePanel from "./BaselinePanel";
import { ChartKey, DispersionChart, LocationChart } from "./ControlChart";

const th =
  "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";
const dayStart = (d) =>
  d ? new Date(`${d}T00:00:00`).toISOString() : undefined;
const dayEnd = (d) =>
  d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined;
const optionKey = (c) => `${c.key}|${c.operationCode}`;

/**
 * SPC control charts (I-MR and X-bar/R) for one part and characteristic. Read live from the inspection
 * measurements; only compatible data is charted and what was left out is listed. A rule violation is a
 * process signal to look into — it never raises a non-conformance by itself.
 */
const SpcPage = () => {
  const [params, setParams] = useSearchParams();
  const partId = params.get("part") || "";
  const selected = params.get("c") || "";
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const lot = params.get("lot") || "";
  const machineId = params.get("machine") || "";
  const showSpec = params.get("spec") !== "0";
  const rulesParam = params.get("rules"); // null: the baseline's rules (or all)

  const set = (patch) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch))
        v === null || v === undefined || v === ""
          ? next.delete(k)
          : next.set(k, v);
      // An explicit empty rule list is meaningful ("none"), so it is kept as an empty value.
      if (patch.rules === "") next.set("rules", "");
      return next;
    });

  const part = usePart(partId);
  const machines = useMachines();
  const characteristics = useSpcCharacteristics(partId);
  const options = characteristics.data ?? [];
  const current =
    options.find((c) => optionKey(c) === selected) ??
    (options.length === 1 ? options[0] : null);

  const query = {
    partId,
    characteristicKey: current?.key,
    operationCode: current?.operationCode,
    from: dayStart(from),
    to: dayEnd(to),
    lot: lot || undefined,
    machineId: machineId || undefined,
    ...(rulesParam !== null ? { rules: rulesParam } : {}),
  };
  const chartQuery = useSpcChart(query, !!current);
  const chart = chartQuery.data;
  const rows = useMemo(() => (chart ? chartRows(chart) : []), [chart]);
  const decimals = chart ? decimalsOf(chart.points) : 3;
  const activeRules = chart?.rules ?? RULES;

  const toggleRule = (rule) => {
    const next = activeRules.includes(rule)
      ? activeRules.filter((r) => r !== rule)
      : RULES.filter((r) => r === rule || activeRules.includes(r));
    set({ rules: next.join(",") === "" ? "" : next.join(",") });
  };

  const type = chart?.characteristic.chartType;
  const sourceLabel =
    chart?.limitsSource === "baseline"
      ? "Saved baseline"
      : chart?.limitsSource === "trial"
        ? "Trial limits (provisional)"
        : "No limits yet";

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-2xl font-semibold text-primary-text">
          SPC control charts
        </h1>
        <p className="text-sm text-secondary-text">
          Charts are read live from recorded inspection measurements. Control
          limits describe what the process does; they are not the specification.
        </p>
      </div>

      <MenuCard title="Chart">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <PartPicker
            label="Part"
            value={partId || null}
            current={part.data}
            onChange={(id) => set({ part: id ?? "", c: "", rules: null })}
          />
          <SelectField
            label="Characteristic"
            value={current ? optionKey(current) : null}
            disabled={!partId || options.length === 0}
            required
            placeholder={
              partId
                ? options.length
                  ? "Choose a characteristic"
                  : "No SPC characteristics with readings"
                : "Choose a part first"
            }
            onChange={(v) => set({ c: v ?? "", rules: null })}
            options={options.map((c) => ({
              value: optionKey(c),
              label: `${c.name} (${c.key}) · ${c.operationCode} · ${c.readings} readings${c.hasBaseline ? " · baseline" : ""}`,
            }))}
          />
          <SelectField
            label="Machine"
            value={machineId || null}
            onChange={(v) => set({ machine: v ?? "" })}
            options={(machines.data?.items ?? []).map((m) => ({
              value: m.id,
              label: `${m.code} · ${m.name}`,
            }))}
          />
          <Field
            label="From"
            type="date"
            value={from}
            onChange={(e) => set({ from: e.target.value })}
          />
          <Field
            label="To"
            type="date"
            value={to}
            onChange={(e) => set({ to: e.target.value })}
          />
          <Field
            label="Lot"
            value={lot}
            onChange={(e) => set({ lot: e.target.value })}
            maxLength={60}
            placeholder="Any lot"
          />
        </div>
        <fieldset className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          <legend className="mb-1 text-sm font-medium text-secondary-text">
            Rules that raise a signal
          </legend>
          {RULES.map((r) => (
            <label
              key={r}
              className="flex items-center gap-2 text-sm text-primary-text"
              title={RULE_LABEL[r].name}
            >
              <input
                type="checkbox"
                checked={activeRules.includes(r)}
                disabled={!chart}
                onChange={() => toggleRule(r)}
              />
              {RULE_LABEL[r].short}: {RULE_LABEL[r].name}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm text-primary-text">
            <input
              type="checkbox"
              checked={showSpec}
              onChange={(e) => set({ spec: e.target.checked ? "" : "0" })}
            />
            Show specification limits
          </label>
        </fieldset>
      </MenuCard>

      {!current &&
        partId &&
        !characteristics.isLoading &&
        options.length === 0 && (
          <p className="text-sm text-secondary-text">
            This part has no numeric readings for characteristics marked for SPC
            in the control plan. Mark a characteristic for SPC (I-MR or X-bar/R)
            on the plan, then record inspections.
          </p>
        )}
      {characteristics.error && <ErrorNotice error={characteristics.error} />}
      {chartQuery.isLoading && (
        <p className="text-secondary-text">Loading chart…</p>
      )}
      {chartQuery.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(chartQuery.error)}
        </p>
      )}

      {chart && (
        <>
          {(chart.warnings.length > 0 || chart.baselineIssue) && (
            <ul
              role="status"
              className="flex flex-col gap-1 rounded-lg border border-border-color p-3 text-sm text-primary-text"
            >
              {[
                ...chart.warnings,
                ...(chart.baselineIssue ? [chart.baselineIssue] : []),
              ].map((w) => (
                <li key={w} className="flex items-start gap-2">
                  <CircleAlertIcon className="mt-0.5 h-4 w-4 shrink-0" /> {w}
                </li>
              ))}
            </ul>
          )}

          {chart.points.length > 0 && (
            <>
              <MenuCard
                title={`${chart.characteristic.name ?? chart.characteristic.key} · ${LOCATION_NAME[type]}`}
                subtitle={`${CHART_NAME[type]}${chart.characteristic.subgroupSize > 1 ? `, subgroups of ${chart.characteristic.subgroupSize}` : ""} · ${chart.part.partNumber} · ${chart.characteristic.operationCode} · ${sourceLabel}`}
              >
                <div className="flex flex-col gap-2">
                  <ChartKey showSpec={showSpec} />
                  <LocationChart
                    chart={chart}
                    rows={rows}
                    decimals={decimals}
                    showSpec={showSpec}
                    valueLabel={LOCATION_NAME[type]}
                  />
                </div>
              </MenuCard>
              <MenuCard
                title={DISPERSION_NAME[type]}
                subtitle="Short-term variation. A point above the upper limit is a signal."
              >
                <DispersionChart
                  chart={chart}
                  rows={rows}
                  decimals={decimals}
                  label={DISPERSION_NAME[type]}
                />
              </MenuCard>

              <MenuCard
                title="Signals"
                subtitle="A signal means the process is probably behaving differently — look into it. It does not mean product is nonconforming."
              >
                {chart.signals.length === 0 &&
                chart.dispersionSignals.length === 0 ? (
                  <p className="text-sm text-primary-text">
                    No rule is broken in the points shown.
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {chart.reactions.length > 0 && (
                      <div className="rounded-lg border border-border-color p-3 text-sm text-primary-text">
                        <p className="text-secondary-text">
                          Control plan reaction to an SPC signal
                        </p>
                        <ul className="list-disc pl-5">
                          {chart.reactions.map((r, i) => (
                            <li key={i}>{r.instruction}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="overflow-x-auto">
                      <table
                        className="w-full min-w-[560px] border-separate border-spacing-0 text-sm text-primary-text"
                        aria-label="Signals"
                      >
                        <thead>
                          <tr>
                            <th scope="col" className={th}>
                              Point
                            </th>
                            <th scope="col" className={th}>
                              Time
                            </th>
                            <th scope="col" className={th}>
                              Rule
                            </th>
                            <th scope="col" className={th}>
                              Inspection
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            ...chart.signals.map((s) => ({
                              index: s.index,
                              label: `${RULE_LABEL[s.rule].short}: ${s.text}`,
                              side: s.side,
                            })),
                            ...chart.dispersionSignals.map((i) => ({
                              index: i,
                              label: `${DISPERSION_NAME[type]} above its upper limit`,
                              side: null,
                            })),
                          ]
                            .sort((a, b) => a.index - b.index)
                            .map((s, i) => {
                              const p = chart.points[s.index];
                              return (
                                <tr key={i}>
                                  <td className={`${td} tabular-nums`}>
                                    {s.index + 1}
                                  </td>
                                  <td className={`${td} whitespace-nowrap`}>
                                    {formatDateTime(p.at)}
                                  </td>
                                  <td className={td}>
                                    {s.label}
                                    {s.side
                                      ? ` (${s.side} the centre line)`
                                      : ""}
                                  </td>
                                  <td className={td}>
                                    {p.inspections.map((x) => (
                                      <Link
                                        key={x.id}
                                        to={`/Inspections/${x.id}`}
                                        className="mr-2 text-link-color hover:underline"
                                      >
                                        {x.reference}
                                      </Link>
                                    ))}
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </MenuCard>
            </>
          )}

          {chart.excluded.length > 0 && (
            <MenuCard
              title="Left out of this chart"
              subtitle="Only compatible data is charted: one part, characteristic, operation, unit, chart type and specification."
            >
              <ul
                className="text-sm text-primary-text"
                aria-label="Excluded readings"
              >
                {chart.excluded.map((e) => (
                  <li key={e.reason}>
                    {e.count} · {e.text}
                  </li>
                ))}
              </ul>
            </MenuCard>
          )}

          {chart.points.length > 0 && (
            <details className="rounded-lg border border-border-color p-3">
              <summary className="cursor-pointer text-sm text-primary-text">
                Show the data behind the chart
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table
                  className="w-full min-w-[560px] border-separate border-spacing-0 text-sm text-primary-text"
                  aria-label="Chart data"
                >
                  <thead>
                    <tr>
                      <th scope="col" className={th}>
                        Point
                      </th>
                      <th scope="col" className={th}>
                        Time
                      </th>
                      <th scope="col" className={th}>
                        {LOCATION_NAME[type]}
                      </th>
                      <th scope="col" className={th}>
                        {DISPERSION_NAME[type]}
                      </th>
                      <th scope="col" className={th}>
                        Readings
                      </th>
                      <th scope="col" className={th}>
                        Signal
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.n}>
                        <td className={`${td} tabular-nums`}>{r.n}</td>
                        <td className={`${td} whitespace-nowrap`}>
                          {formatDateTime(r.at)}
                        </td>
                        <td className={`${td} tabular-nums`}>
                          {formatValue(r.value, decimals)}
                        </td>
                        <td className={`${td} tabular-nums`}>
                          {formatValue(r.dispersion, decimals)}
                        </td>
                        <td className={td}>
                          {r.point.readings.map((x) => x.value).join(", ")}
                        </td>
                        <td className={td}>
                          {[
                            ...r.rules.map((x) => RULE_LABEL[x].short),
                            ...(r.rangeSignal ? ["Range"] : []),
                          ].join(", ") || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          <BaselinePanel
            chart={chart}
            params={query}
            rules={activeRules}
            decimals={decimals}
          />
        </>
      )}
    </div>
  );
};

export default SpcPage;
