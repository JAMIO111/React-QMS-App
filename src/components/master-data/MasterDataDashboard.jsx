import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BoxesIcon, CircleCheckIcon, DatabaseIcon, ShieldCheckIcon, TriangleAlertIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import { ACCENT, Chip, Empty, HeroCard, Meter, RankList, SplitBar, StatTile, cardLink } from "../dashboard/DashboardGraphics";
import { Card, grid, tick } from "../dashboard/DashboardParts";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import { usePermissions } from "../../hooks/useQmsApi";
import { useMasterDataDashboard } from "../../hooks/useMasterData";
import { useIntegrationHealth } from "../../hooks/useIntegrations";
import { describeApiError } from "../../lib/api-client";
import { KINDS, REVISION_STATUS } from "../../lib/masterData";
import { formatDate, formatDateTime } from "../../lib/processControl";

const kindOrder = Object.keys(KINDS);
const num = (n) => n.toLocaleString("en-GB");

/** One bar per week with the breakdown by kind in the tooltip: six kinds would need six colours, and the validated chart palette has three. */
const GrowthTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const week = payload[0].payload;
  return (
    <div className="rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-xs text-primary-text shadow-lg shadow-shadow-color">
      <p className="mb-1 font-semibold">Week of {formatDate(week.start)}</p>
      {kindOrder.map((k) => (
        <p key={k} className="flex gap-4">
          <span className="text-secondary-text">{KINDS[k].label}</span>
          <span className="ml-auto font-medium">{week[k]}</span>
        </p>
      ))}
    </div>
  );
};

/** One data-quality check: a tick or a warning, how many records fail it, and a meter of those against the active records. */
const Check = ({ item }) => {
  const kind = KINDS[item.kind];
  const ok = item.count === 0;
  return (
    <li>
      <Link to={kind.to} className="flex flex-col gap-1.5 rounded-xl px-2 py-2 hover:bg-primary-text/5">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {ok ? <CircleCheckIcon className="h-5 w-5 shrink-0 text-success-color" aria-hidden="true" /> : <TriangleAlertIcon className="h-5 w-5 shrink-0 text-warning-color" aria-hidden="true" />}
          <span className="min-w-0 flex-1 text-sm text-primary-text">{item.label}</span>
          <span className={`text-sm font-medium tabular-nums ${ok ? "text-success-color" : "text-primary-text"}`}>{ok ? "None" : `${num(item.count)} of ${num(item.of)}`}</span>
          <span className="sr-only">{ok ? " (healthy)" : " (needs attention)"}</span>
        </span>
        {!ok && <Meter part={item.count} whole={item.of} color="var(--chart-warning)" label={`${item.count} of ${item.of} ${kind.label.toLowerCase()}`} />}
      </Link>
    </li>
  );
};

/** A small figure in a tinted box with a coloured edge, for the rows of counts on the integrations card. */
const Figure = ({ label, value, color = ACCENT, small = false }) => (
  <div className="rounded-xl border-l-4 bg-primary-bg px-3 py-2" style={{ borderColor: color }}>
    <dt className="text-xs text-secondary-text">{label}</dt>
    <dd className={`font-semibold tabular-nums text-primary-text ${small ? "text-sm" : "text-2xl"}`}>{value}</dd>
  </div>
);

/** The state of imports (IN8): counts by health and a link to the details, for people who may see integrations. */
const IntegrationsSummary = () => {
  const { can } = usePermissions();
  const allowed = can("integrations.read");
  const health = useIntegrationHealth({ enabled: allowed });
  const counts = health.data?.counts;
  const total = counts ? counts.ok + counts.attention + counts.failing : 0;
  if (!allowed || total === 0) {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-border-color bg-primary-bg p-3 text-sm text-primary-text">
        <DatabaseIcon className="mt-0.5 h-4 w-4 shrink-0 text-secondary-text" aria-hidden="true" />
        <span>
          {allowed ? "No imports have run yet." : "Imports are visible to Controller seat holders."} Key events (part revisions released, inspections, non-conformances, plan approvals and more) are
          queued below, ready for connectors.
        </span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <dl aria-label="Import health" className="grid grid-cols-3 gap-3">
        <Figure label="Healthy" value={counts.ok} color="var(--chart-series-3)" />
        <Figure label="Need a look" value={counts.attention} color="var(--chart-warning)" />
        <Figure label="Failing" value={counts.failing} color="var(--chart-critical)" />
      </dl>
      <Link to="/Settings/Integrations" className={cardLink}>
        Import health in Settings → Integrations
      </Link>
    </div>
  );
};

/** Master data overview: what there is, whether it is in good shape, what changed lately and what is queued for integrations. */
const MasterDataDashboard = () => {
  const { can } = usePermissions();
  const { data, error, isLoading, isFetching } = useMasterDataDashboard();
  const events = data?.events;
  const checks = data?.attention ?? [];
  const needFixing = checks.filter((a) => a.count > 0).length;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-col gap-2">
        <Breadcrumb />
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
          <BoxesIcon className="h-6 w-6" aria-hidden="true" />
          Master data overview
        </h1>
        <p className="text-sm text-secondary-text" aria-live="polite">
          {data ? `As of ${formatDateTime(data.asOf)}` : "Loading…"}
          {isFetching && !isLoading ? " · updating…" : ""}
        </p>
      </div>

      {error && (
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}
      {isLoading && <LoadingScreen />}

      {data && (
        <>
          {/* What there is: one tile per kind, each a way into its register. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Totals">
            {data.entities.map((e) => {
              const k = KINDS[e.kind];
              return (
                <StatTile key={e.kind} icon={k.icon} label={k.label} value={num(e.total)} to={k.to} note={`${num(e.active)} active · ${num(e.added30Days)} added in 30 days`}>
                  <Meter part={e.active} whole={e.total} label={`${e.active} of ${e.total} ${k.label.toLowerCase()} are active`} />
                </StatTile>
              );
            })}
          </div>

          {/* Whether it is in good shape, and how fast it grows. */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <HeroCard
              label="Data quality"
              icon={ShieldCheckIcon}
              className="xl:col-span-2"
              value={
                <>
                  {checks.length - needFixing}
                  <span className="text-2xl font-medium text-secondary-text"> of {checks.length} checks pass</span>
                </>
              }
              note={needFixing === 0 ? "Every check passes" : `${needFixing} of ${checks.length} checks need attention (active records only)`}>
              <ul aria-label="Data quality checks" className="-mx-2 flex flex-col">
                {checks.map((a) => (
                  <Check key={a.key} item={a} />
                ))}
              </ul>
            </HeroCard>
            <Card title="Records added per week" subtitle="Last 12 weeks, all kinds. Hover a bar for the split." className="xl:col-span-3">
              <div className="min-h-56 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.growth.map((w) => ({ ...w, total: kindOrder.reduce((n, k) => n + w[k], 0) }))} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="start" tick={tick} tickFormatter={(d) => formatDate(d).slice(0, 6)} axisLine={false} tickLine={false} />
                    <YAxis tick={tick} allowDecimals={false} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<GrowthTooltip />} />
                    <Bar dataKey="total" name="Records added" fill={ACCENT} radius={[6, 6, 0, 0]} maxBarSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          {/* How it is spread. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <Card title="Parts by family" subtitle="Active parts">
              {data.partsByFamily.length ? <RankList items={data.partsByFamily} label="Parts by family" /> : <Empty>No active parts.</Empty>}
            </Card>
            <Card title="Employees by department" subtitle="Active employees">
              {data.employeesByDepartment.length ? <RankList items={data.employeesByDepartment} label="Employees by department" /> : <Empty>No active employees.</Empty>}
            </Card>
            <div className="grid grid-cols-1 gap-4 lg:col-span-2 lg:grid-cols-2 xl:col-span-1 xl:grid-cols-1">
            <Card title="Machines by site" subtitle="Active machines">
              {data.machinesBySite.length ? <RankList items={data.machinesBySite} label="Machines by site" /> : <Empty>No active machines.</Empty>}
            </Card>
            <Card title="Part revisions" subtitle="All parts, by status">
              {data.revisionsByStatus.length ? (
                <SplitBar
                  label="Part revisions by status"
                  unit="revision"
                  tall
                  columns={1}
                  parts={data.revisionsByStatus.map((r) => ({ key: r.key, label: REVISION_STATUS[r.key]?.label ?? r.label, count: r.count, color: REVISION_STATUS[r.key]?.color ?? ACCENT }))}
                />
              ) : (
                <Empty>No part revisions yet.</Empty>
              )}
            </Card>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title="Recently added or changed" subtitle="The latest ten records across all kinds">
              {data.recent.length === 0 ? (
                <Empty>Nothing has been added yet.</Empty>
              ) : (
                <ul aria-label="Recent changes" className="flex flex-col divide-y divide-border-color">
                  {data.recent.map((r) => {
                    const k = KINDS[r.kind];
                    const Icon = k.icon;
                    return (
                      <li key={`${r.kind}-${r.id}`} className="flex items-center gap-3 py-2 text-sm">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-primary-text" style={{ background: `color-mix(in srgb, ${ACCENT} 16%, transparent)` }}>
                          <Icon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <Link to={k.to} className="truncate text-link-color hover:underline">
                            {r.label}
                          </Link>
                          <span className="text-xs text-secondary-text">
                            {r.action === "added" ? "Added" : "Changed"}
                            {r.by ? ` by ${r.by}` : ""} · {formatDateTime(r.at)}
                          </span>
                        </span>
                        <Chip>{k.one}</Chip>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card title="Integrations and change events" subtitle="What is connected, and what is queued for connectors">
              <IntegrationsSummary />
              {events?.available ? (
                <>
                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Figure label="Events in 24 hours" value={events.last24Hours} />
                    <Figure label="Waiting for a consumer" value={events.waiting} color={events.waiting > 0 ? "var(--chart-warning)" : ACCENT} />
                    <Figure label="Oldest waiting" value={events.oldestWaitingAt ? formatDateTime(events.oldestWaitingAt) : "—"} color="var(--chart-neutral)" small />
                  </dl>
                  {events.byType.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary-text">Event types, last 30 days</h3>
                      <RankList items={events.byType} label="Event types, last 30 days" />
                    </div>
                  )}
                  {events.recent.length > 0 && (
                    <ul aria-label="Latest events" className="flex flex-col divide-y divide-border-color text-sm">
                      {events.recent.map((e) => (
                        <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-primary-text">{e.type}</span>
                          <span className="text-xs text-secondary-text">{formatDateTime(e.at)}</span>
                          <Chip tone={e.processedAt ? "neutral" : "warning"}>{e.processedAt ? "Consumed" : "Waiting"}</Chip>
                        </li>
                      ))}
                    </ul>
                  )}
                  {events.byType.length === 0 && <p className="text-sm text-secondary-text">No events yet.</p>}
                </>
              ) : (
                <p className="text-sm text-secondary-text">The change-event stream is visible to people with audit access{can("audit.read") ? "" : ", which you do not have"}.</p>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
};

export default MasterDataDashboard;
