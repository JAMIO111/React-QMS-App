import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { format, startOfYear, subDays, subMonths } from "date-fns";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  CalendarIcon,
  CircleCheckIcon,
  ClipboardListIcon,
  HourglassIcon,
  LayersIcon,
  PoundSterlingIcon,
  TableIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
} from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import RHFComboBox from "../ui/RHFComboBox";
import { useNcDashboard } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";
import { formatMoney } from "../../lib/costs";
import { NCR_REGISTER, NC_TABS, formatDate } from "../../lib/ncr";
import SlidingToggle from "../ui/SlidingToggle";

const PERIODS = [
  { id: "30d", name: "Last 30 days", from: (t) => subDays(t, 29) },
  { id: "90d", name: "Last 90 days", from: (t) => subDays(t, 89) },
  { id: "12m", name: "Last 12 months", from: (t) => subDays(subMonths(t, 12), -1) },
  { id: "ytd", name: "Year to date", from: (t) => startOfYear(t) },
  { id: "24m", name: "Last 24 months", from: (t) => subDays(subMonths(t, 24), -1) },
];
const SEVERITY_COLOR = { critical: "var(--chart-critical)", major: "var(--chart-serious)", minor: "var(--chart-warning)", unset: "var(--chart-neutral)" };
const SINGLE = "var(--brand-primary)";

const tick = { className: "fill-secondary-text", fontSize: 12 };
const grid = { stroke: "var(--chart-grid)", vertical: false };
const pct = (now, before) => (before ? Math.round(((now - before) / before) * 100) : null);

/** Themed tooltip: values in text colours, the series swatch carries identity. */
const ChartTooltip = ({ active, payload, label, valueFormat = (v) => v, labelFormat = (l) => l }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-xs text-primary-text shadow-lg shadow-shadow-color">
      <p className="mb-1 font-semibold">{labelFormat(label)}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.payload?.fill ?? p.color }} aria-hidden="true" />
          <span className="text-secondary-text">{p.name}</span>
          <span className="ml-auto font-medium">{valueFormat(p.value)}</span>
        </p>
      ))}
    </div>
  );
};

const Card = ({ title, subtitle, action, children, className = "" }) => (
  <section aria-label={title} className={`flex min-w-0 flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4 ${className}`}>
    <div className="flex items-start justify-between gap-2">
      <div>
        <h2 className="text-base font-semibold text-primary-text">{title}</h2>
        {subtitle && <p className="text-xs text-secondary-text">{subtitle}</p>}
      </div>
      {action}
    </div>
    {children}
  </section>
);

/** KPI tile: one number, its label, and (optionally) the change on the previous period. */
const Kpi = ({ icon: Icon, label, value, note, change, higherIsWorse = true, to }) => {
  const worse = change !== null && change !== undefined && (higherIsWorse ? change > 0 : change < 0);
  const body = (
    <>
      <div className="flex items-center justify-between text-secondary-text">
        <span className="text-sm">{label}</span>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <p className="text-3xl font-semibold text-primary-text">{value}</p>
      <p className="min-h-4 text-xs text-secondary-text">
        {change !== null && change !== undefined ? (
          <span className={`inline-flex items-center gap-1 ${change === 0 ? "" : worse ? "text-error-color" : "text-success-color"}`}>
            {change > 0 ? <TrendingUpIcon aria-hidden="true" /> : change < 0 ? <TrendingDownIcon aria-hidden="true" /> : null}
            {change === 0 ? "No change" : `${change > 0 ? "Up" : "Down"} ${Math.abs(change)}%`} on previous period
          </span>
        ) : (
          note
        )}
      </p>
    </>
  );
  const cls = "flex flex-col gap-1 rounded-2xl border border-border-color bg-secondary-bg p-4";
  return to ? (
    <Link to={to} className={`${cls} hover:border-brand-primary transition-colors`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
};

/** Horizontal bars for a ranked or ordered list; every bar carries its value label. */
const HBars = ({ data, colorOf = () => SINGLE, name = "NCs", height }) => (
  <div style={{ height: height ?? Math.max(120, data.length * 34 + 20) }}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 36, bottom: 0, left: 0 }} barCategoryGap={6}>
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={130} tick={tick} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip />} />
        <Bar dataKey="count" name={name} radius={[0, 4, 4, 0]} maxBarSize={22} label={{ position: "right", className: "fill-primary-text", fontSize: 12 }}>
          {data.map((d) => (
            <Cell key={d.key} fill={colorOf(d)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>
);

/**
 * Non-conformance dashboard (/Non-Conformance): KPI tiles and charts for a period, for every source or one quick tab
 * (All / Customer / Supplier). Period and tab live in the URL, so a view can be bookmarked or shared. Source and
 * category are separate breakdowns: where the non-conformances came from, and what kind of problem they are.
 */
const NcDashboard = () => {
  const [params, setParams] = useSearchParams();
  const periodId = PERIODS.some((p) => p.id === params.get("period")) ? params.get("period") : "12m";
  const tabKey = NC_TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "all";
  const tab = NC_TABS.find((t) => t.key === tabKey);
  const today = new Date();
  const from = format(PERIODS.find((p) => p.id === periodId).from(today), "yyyy-MM-dd");
  const to = format(today, "yyyy-MM-dd");
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
  const bucketLabel = (start) => (data?.period.bucket === "month" ? format(new Date(`${start}T00:00:00`), "MMM yy") : format(new Date(`${start}T00:00:00`), "d MMM"));
  // Links into the register keep the tab's sources and the period.
  const registerLink = (extra = "") => `${NCR_REGISTER}?${[tab.source && `source=${tab.source}`, extra].filter(Boolean).join("&")}`;
  const k = data?.kpis;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="text-2xl font-semibold text-primary-text">Non-conformance dashboard</h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            {formatDate(from)} – {formatDate(to)}
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        {/* Filters: one row above the charts. */}
        <div className="flex flex-wrap items-end gap-3">
          <SlidingToggle
            ariaLabel="NC source"
            mode="radio"
            options={NC_TABS.map((t) => ({ value: t.key, label: t.label }))}
            value={tabKey}
            onChange={(key) => set("tab", key === "all" ? "" : key)}
          />
          <div className="w-48">
            <RHFComboBox label="Period" icon={CalendarIcon} options={PERIODS} value={periodId} onChange={(v) => set("period", v === "12m" ? "" : v)} sort={false} clearable={false} />
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
          {describeApiError(error)}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-busy={isLoading || undefined}>
        <Kpi icon={ClipboardListIcon} label="NCs raised" value={k ? k.raised.toLocaleString("en-GB") : "—"} change={k ? pct(k.raised, k.raisedPrevious) : null}
          note={k && !k.raisedPrevious ? "None in the previous period" : ""} to={registerLink(`from=${from}&to=${to}`)} />
        <Kpi icon={TriangleAlertIcon} label="Open now" value={k ? k.open.toLocaleString("en-GB") : "—"}
          note={k ? `${k.criticalOpen} critical` : ""} to={registerLink("stage=draft,open,contained,investigating,dispositioned,awaiting_closure")} />
        <Kpi icon={CircleCheckIcon} label="Closed in period" value={k ? k.closed.toLocaleString("en-GB") : "—"} note="By closing date" to={registerLink("stage=closed")} />
        <Kpi icon={HourglassIcon} label="Average days to close" value={k?.avgDaysToClose !== null && k?.avgDaysToClose !== undefined ? k.avgDaysToClose.toLocaleString("en-GB") : "—"} note="Detected to closed" />
        <Kpi icon={PoundSterlingIcon} label="Cost of non-conformance" value={k ? shortMoney(k.cost) : "—"} change={k ? pct(k.cost, k.costPrevious) : null}
          note={k && !k.costPrevious ? "Nothing in the previous period" : ""} />
        <Kpi icon={LayersIcon} label="Quantity affected" value={k ? k.quantity.toLocaleString("en-GB") : "—"} note="Parts or units" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card
          title="NCs raised"
          subtitle={`Per ${data?.period.bucket ?? "month"}, by detection date`}
          action={
            <button type="button" onClick={() => setTrendAsTable((v) => !v)} aria-pressed={trendAsTable}
              className="flex items-center gap-1 rounded-lg border border-border-color px-2 py-1 text-xs text-primary-text hover:bg-border-color/50 cursor-pointer">
              <TableIcon className="h-3.5 w-3.5" /> {trendAsTable ? "Show chart" : "Show table"}
            </button>
          }>
          {trendAsTable ? (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-sm" aria-label="NCs raised per period">
                <thead className="sticky top-0 bg-secondary-bg text-left text-secondary-text">
                  <tr>
                    <th className="py-1 pr-2 font-medium">{data?.period.bucket === "week" ? "Week of" : "Month"}</th>
                    <th className="py-1 pr-2 text-right font-medium">NCs</th>
                    <th className="py-1 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="text-primary-text">
                  {(data?.trend ?? []).map((b) => (
                    <tr key={b.start} className="border-t border-border-color">
                      <td className="py-1 pr-2">{bucketLabel(b.start)}</td>
                      <td className="py-1 pr-2 text-right">{b.total}</td>
                      <td className="py-1 text-right">{money(b.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.trend ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%">
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                  <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                  <Bar dataKey="total" name="NCs raised" fill={SINGLE} radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="Cost of non-conformance" subtitle={`Per ${data?.period.bucket ?? "month"}, gross, in ${currency}`}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.trend ?? []} margin={{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="20%">
                <CartesianGrid {...grid} />
                <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                <YAxis tickFormatter={shortMoney} tick={tick} axisLine={false} tickLine={false} width={56} />
                <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} valueFormat={money} />} />
                <Bar dataKey="cost" name="Cost" fill={SINGLE} radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="By source" subtitle="Where they came from or were detected, raised in the period">
          {data?.bySource?.some((x) => x.count) ? <HBars data={data.bySource} height={11 * 30 + 20} /> : <p className="py-8 text-center text-sm text-secondary-text">No NCs in this period.</p>}
        </Card>

        <Card title="By category" subtitle="What kind of problem, raised in the period">
          {data?.byCategory?.length ? <HBars data={data.byCategory} /> : <p className="py-8 text-center text-sm text-secondary-text">No NCs in this period.</p>}
        </Card>

        <Card title="Failure modes" subtitle="NCs raised in the period">
          {data?.byFailureMode.length ? <HBars data={data.byFailureMode} /> : <p className="py-8 text-center text-sm text-secondary-text">No NCs in this period.</p>}
        </Card>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card title="Open NCs by stage" subtitle="Right now">
            <HBars data={data?.byStage ?? []} height={230} />
          </Card>
          <Card title="Severity" subtitle="NCs raised in the period">
            <HBars data={data?.bySeverity ?? []} colorOf={(d) => SEVERITY_COLOR[d.key]} height={170} />
          </Card>
        </div>
      </div>

      <Card title="Parts with the most NCs" subtitle="Raised in the period">
        {data?.topParts.length ? (
          <table className="w-full text-sm" aria-label="Parts with the most NCs">
            <thead className="text-left text-secondary-text">
              <tr>
                <th className="py-1 pr-2 font-medium">Part</th>
                <th className="py-1 pr-2 text-right font-medium">NCs</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="text-primary-text">
              {data.topParts.map((p) => (
                <tr key={p.id} className="border-t border-border-color">
                  <td className="py-1.5 pr-2">
                    <Link className="text-link-color hover:underline" to={registerLink(`part=${p.id}&partLabel=${encodeURIComponent(`${p.partNumber} · ${p.name}`)}&from=${from}&to=${to}`)}>
                      {p.partNumber}
                    </Link>{" "}
                    <span className="text-secondary-text">{p.name}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-right">{p.count}</td>
                  <td className="py-1.5 text-right">{money(p.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="py-4 text-center text-sm text-secondary-text">No NCs with a part in this period.</p>
        )}
      </Card>
    </div>
  );
};

export default NcDashboard;
