import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { format } from "date-fns";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CircleCheckIcon, ClipboardListIcon, HourglassIcon, LayersIcon, PoundSterlingIcon, TableIcon, TriangleAlertIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import SlidingToggle from "../ui/SlidingToggle";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { ACCENT, ChangeNote, Chip, Empty, HeroCard, Pipeline, RankList, SplitBar, StatTile } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, pctChange, stackedBarShape, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { useNcDashboard } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";
import { formatMoney } from "../../lib/costs";
import { NCR_REGISTER, NC_TABS, formatDate } from "../../lib/ncr";

const SEVERITY_COLOR = { critical: "var(--chart-critical)", major: "var(--chart-serious)", minor: "var(--chart-warning)", unset: "var(--chart-neutral)" };
/** Where a non-conformance came from, as the three groups of the tabs; each keeps its colour whichever tab is chosen. */
const ORIGINS = NC_TABS.filter((t) => t.source).map((t, i) => ({ key: t.key, label: t.label, sources: t.source.split(","), color: `var(--chart-series-${i + 1})` }));
const OPEN_STAGES = "draft,open,contained,investigating,dispositioned,awaiting_closure";
const whole = (v) => v.toLocaleString("en-GB");

/**
 * Non-conformance dashboard (/Non-Conformance): how many were raised and what they cost over a period, and where the open ones stand today, for every
 * source or one quick tab (All / Internal / Customer / Supplier). Period and tab live in the URL, so a view can be bookmarked or shared. Source and
 * category are separate breakdowns: where the non-conformances came from, and what kind of problem they are.
 */
const NcDashboard = () => {
  const [params, setParams] = useSearchParams();
  const period = useDashboardPeriod("12m");
  const tabKey = NC_TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "all";
  const tab = NC_TABS.find((t) => t.key === tabKey);
  const { fromIso: from, toIso: to } = period;
  const { data, isLoading, isFetching, error } = useNcDashboard({ source: tab.source, from, to });
  const [trendAsTable, setTrendAsTable] = useState(false);

  const set = (k, v) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v) next.set(k, v);
      else next.delete(k);
      return next;
    });

  const currency = data?.baseCurrency ?? "GBP";
  const money = (v) => formatMoney(v, currency);
  const shortMoney = (v) => (v >= 10000 ? `${formatMoney(v / 1000, currency).replace(/\.\d+$/, "")}k` : formatMoney(v, currency).replace(/\.00$/, ""));
  const bucket = data?.period.bucket ?? "month";
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), bucket === "month" ? "MMM yy" : "d MMM");
  // Links into the register keep the tab's sources and the period.
  const registerLink = (extra = "") => `${NCR_REGISTER}?${[tab.source && `source=${tab.source}`, extra].filter(Boolean).join("&")}`;
  const k = data?.kpis;
  const raisedChange = k ? pctChange(k.raised, k.raisedPrevious) : null;

  // Each period's count split by where the non-conformances came from; a source outside the three groups counts as internal.
  const trend = (data?.trend ?? []).map((b) => {
    const row = { start: b.start, total: b.total, cost: b.cost };
    let placed = 0;
    for (const o of ORIGINS) {
      row[o.key] = o.sources.reduce((n, s) => n + (b.bySource?.[s] ?? 0), 0);
      placed += row[o.key];
    }
    row.internal += Math.max(0, b.total - placed);
    return row;
  });
  const originParts = ORIGINS.map((o) => ({ key: o.key, label: o.label, color: o.color, count: trend.reduce((n, b) => n + b[o.key], 0) }));
  const severityParts = (data?.bySeverity ?? []).map((s) => ({ key: s.key, label: s.label, color: SEVERITY_COLOR[s.key], count: s.count }));
  const mostParts = Math.max(1, ...(data?.topParts ?? []).map((p) => p.count));

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <TriangleAlertIcon className="h-6 w-6" aria-hidden="true" />
            Non-conformance dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            {formatDate(from)} – {formatDate(to)} · open non-conformances as of today
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        {/* Filters: one row above everything they scope. */}
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <SlidingToggle
            ariaLabel="NC source"
            mode="radio"
            options={NC_TABS.map((t) => ({ value: t.key, label: t.label }))}
            value={tabKey}
            onChange={(key) => set("tab", key === "all" ? "" : key)}
            className="shrink-0"
          />
          <DashboardPeriodPicker period={period} />
        </div>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      {/* What was raised in the period beside where the open ones stand today. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
        <HeroCard
          label="NCs raised"
          icon={ClipboardListIcon}
          value={k ? whole(k.raised) : "—"}
          note={raisedChange !== null ? <ChangeNote change={raisedChange} higherIsWorse /> : k && !k.raisedPrevious ? "None in the previous period" : "In the period"}
          to={registerLink(`from=${from}&to=${to}`)}
          className="xl:col-span-5">
          <span className="text-sm font-semibold text-primary-text">Severity</span>
          {severityParts.some((s) => s.count) ? <SplitBar parts={severityParts} label="Severity" unit="non-conformance" tall showZero /> : <Empty>No NCs in this period.</Empty>}
        </HeroCard>

        <Card
          title="Open non-conformances"
          subtitle="Where each one stands, right now"
          className="justify-between rounded-3xl xl:col-span-7">
          <Link
            to={registerLink(`stage=${OPEN_STAGES}`)}
            data-tile="Open now"
            className="flex w-fit items-end gap-4 rounded-2xl outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-brand-primary">
            <span className="flex flex-col">
              <span className="text-sm text-secondary-text">Open now</span>
              <span className="text-5xl font-semibold leading-none text-primary-text">{k ? whole(k.open) : "—"}</span>
            </span>
            {k && <Chip tone={k.criticalOpen > 0 ? "error" : "neutral"}>{k.criticalOpen} critical</Chip>}
          </Link>
          {data?.byStage?.length ? (
            <Pipeline steps={data.byStage} label="Open NCs by stage" layout="six" to={(s) => registerLink(`stage=${s.key}`)} />
          ) : (
            <Empty>No stages to show.</Empty>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-busy={isLoading || undefined}>
        <StatTile icon={CircleCheckIcon} label="Closed in period" value={k ? whole(k.closed) : "—"} note="By closing date" to={registerLink("stage=closed")} />
        <StatTile
          icon={HourglassIcon}
          label="Average days to close"
          value={k?.avgDaysToClose !== null && k?.avgDaysToClose !== undefined ? whole(k.avgDaysToClose) : "—"}
          note="Detected to closed"
        />
        <StatTile
          icon={PoundSterlingIcon}
          label="Cost of non-conformance"
          value={k ? shortMoney(k.cost) : "—"}
          change={k ? pctChange(k.cost, k.costPrevious) : null}
          higherIsWorse
          note={k && !k.costPrevious ? "Nothing in the previous period" : ""}
        />
        <StatTile icon={LayersIcon} label="Quantity affected" value={k ? whole(k.quantity) : "—"} note="Parts or units" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card
          title="NCs raised"
          subtitle={`Per ${bucket}, by detection date and where they came from`}
          action={
            <CTAButton type="neutral" icon={TableIcon} iconSize="h-4 w-4" onClick={() => setTrendAsTable((v) => !v)} aria-pressed={trendAsTable}>
              {trendAsTable ? "Show chart" : "Show table"}
            </CTAButton>
          }>
          {trendAsTable ? (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm" aria-label="NCs raised per period">
                <thead className="sticky top-0 bg-secondary-bg text-left text-secondary-text">
                  <tr>
                    <th className="py-1 pr-2 font-medium">{bucket === "week" ? "Week of" : "Month"}</th>
                    <th className="py-1 pr-2 text-right font-medium">NCs</th>
                    <th className="py-1 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="text-primary-text">
                  {trend.map((b) => (
                    <tr key={b.start} className="border-t border-border-color">
                      <td className="py-1 pr-2">{bucketLabel(b.start)}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{b.total}</td>
                      <td className="py-1 text-right tabular-nums">{money(b.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <SplitBar parts={originParts} label="NCs raised by where they came from" unit="non-conformance" />
              <div className="h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="NCs raised per period">
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                    <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                    {ORIGINS.map((o) => (
                      <Bar key={o.key} dataKey={o.key} name={o.label} stackId="s" fill={o.color} stroke="rgb(var(--secondary-bg))" strokeWidth={2} shape={stackedBarShape(ORIGINS.map((x) => x.key))} maxBarSize={24} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Card>

        <Card title="Cost of non-conformance" subtitle={`Per ${bucket}, gross, in ${currency}`} action={k && <span className="text-2xl font-semibold text-primary-text">{money(k.cost)}</span>}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 4 }} aria-label="Cost of non-conformance per period">
                <defs>
                  <linearGradient id="nc-cost-wash" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...grid} />
                <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                <YAxis tickFormatter={shortMoney} tick={tick} axisLine={false} tickLine={false} width={56} />
                <Tooltip cursor={{ stroke: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} valueFormat={money} />} />
                <Area
                  type="monotone"
                  dataKey="cost"
                  name="Cost"
                  stroke={ACCENT}
                  strokeWidth={2}
                  fill="url(#nc-cost-wash)"
                  dot={{ r: 3, fill: ACCENT, stroke: "rgb(var(--secondary-bg))", strokeWidth: 2 }}
                  activeDot={{ r: 5, fill: ACCENT, stroke: "rgb(var(--secondary-bg))", strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Card title="By source" subtitle="Where they came from or were detected, raised in the period">
          {data?.bySource?.some((x) => x.count) ? (
            <RankList items={data.bySource} label="NCs by source" to={(s) => `${NCR_REGISTER}?source=${s.key}&from=${from}&to=${to}`} />
          ) : (
            <Empty>No NCs in this period.</Empty>
          )}
        </Card>
        <Card title="By category" subtitle="What kind of problem, raised in the period">
          {data?.byCategory?.length ? <RankList items={data.byCategory} label="NCs by category" /> : <Empty>No NCs in this period.</Empty>}
        </Card>
        <Card title="Failure modes" subtitle="NCs raised in the period" className="lg:col-span-2 xl:col-span-1">
          {data?.byFailureMode.length ? <RankList items={data.byFailureMode} label="NCs by failure mode" /> : <Empty>No NCs in this period.</Empty>}
        </Card>
      </div>

      <Card title="Parts with the most NCs" subtitle="Raised in the period">
        {data?.topParts.length ? (
          <table className="w-full text-sm" aria-label="Parts with the most NCs">
            <thead className="text-left text-xs uppercase tracking-wide text-secondary-text">
              <tr>
                <th className="py-1 pr-3 font-medium">Part</th>
                <th className="py-1 pr-3 font-medium">
                  <span className="sr-only">Share of the most raised</span>
                </th>
                <th className="py-1 pr-3 text-right font-medium">NCs</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="text-primary-text">
              {data.topParts.map((p) => (
                <tr key={p.id} className="border-t border-border-color">
                  <td className="py-2 pr-3">
                    <Link className="font-medium text-link-color hover:underline" to={registerLink(`part=${p.id}&partLabel=${encodeURIComponent(`${p.partNumber} · ${p.name}`)}&from=${from}&to=${to}`)}>
                      {p.partNumber}
                    </Link>{" "}
                    <span className="text-secondary-text">{p.name}</span>
                  </td>
                  <td className="w-1/3 py-2 pr-3" aria-hidden="true">
                    <span className="block h-2.5 rounded-full" style={{ width: `${(p.count / mostParts) * 100}%`, minWidth: 6, background: ACCENT }} />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{p.count}</td>
                  <td className="py-2 text-right tabular-nums">{money(p.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No NCs with a part in this period.</Empty>
        )}
      </Card>
    </div>
  );
};

export default NcDashboard;
