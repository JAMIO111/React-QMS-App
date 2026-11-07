import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CircleCheckIcon, DatabaseIcon, TriangleAlertIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import { Card, HBars, Kpi, SINGLE, grid, tick } from "../dashboard/DashboardParts";
import LoadingScreen from "../ui/LoadingScreen";
import { usePermissions } from "../../hooks/useQmsApi";
import { useMasterDataDashboard } from "../../hooks/useMasterData";
import { describeApiError } from "../../lib/api-client";
import { KINDS, REVISION_STATUS } from "../../lib/masterData";
import { formatDate, formatDateTime } from "../../lib/processControl";

const kindOrder = Object.keys(KINDS);

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

const Check = ({ item }) => {
  const kind = KINDS[item.kind];
  const ok = item.count === 0;
  return (
    <li>
      <Link to={kind.to} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 hover:bg-primary-text/5">
        {ok ? <CircleCheckIcon className="h-5 w-5 shrink-0 text-success-color" aria-hidden="true" /> : <TriangleAlertIcon className="h-5 w-5 shrink-0 text-warning-color" aria-hidden="true" />}
        <span className="min-w-0 flex-1 text-sm text-primary-text">{item.label}</span>
        <span className={`text-sm font-medium tabular-nums ${ok ? "text-success-color" : "text-primary-text"}`}>
          {ok ? "None" : `${item.count} of ${item.of}`}
        </span>
        <span className="sr-only">{ok ? " (healthy)" : " (needs attention)"}</span>
      </Link>
    </li>
  );
};

/** Master data overview: what there is, whether it is in good shape, what changed lately and what is queued for integrations. */
const MasterDataDashboard = () => {
  const { can } = usePermissions();
  const { data, error, isLoading, isFetching } = useMasterDataDashboard();
  const events = data?.events;
  const needFixing = data?.attention.filter((a) => a.count > 0).length ?? 0;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-col gap-2">
        <Breadcrumb />
        <h1 className="text-2xl font-semibold text-primary-text">Master data overview</h1>
        <p className="text-sm text-secondary-text" aria-live="polite">
          {data ? `As of ${formatDateTime(data.asOf)}` : "Loading…"}
          {isFetching && !isLoading ? " · updating…" : ""}
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
          {describeApiError(error)}
        </p>
      )}
      {isLoading && <LoadingScreen />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Totals">
            {data.entities.map((e) => {
              const k = KINDS[e.kind];
              return <Kpi key={e.kind} icon={k.icon} label={k.label} value={e.total} to={k.to} note={`${e.active} active · ${e.added30Days} added in 30 days`} />;
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Card
              title="Data quality"
              subtitle={needFixing === 0 ? "Every check passes" : `${needFixing} of ${data.attention.length} checks need attention (active records only)`}
              className="xl:col-span-1">
              <ul aria-label="Data quality checks" className="flex flex-col">
                {data.attention.map((a) => (
                  <Check key={a.key} item={a} />
                ))}
              </ul>
            </Card>
            <Card title="Records added per week" subtitle="Last 12 weeks, all kinds. Hover a bar for the split." className="xl:col-span-2">
              <div style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.growth.map((w) => ({ ...w, total: kindOrder.reduce((s, k) => s + w[k], 0) }))} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="start" tick={tick} tickFormatter={(s) => formatDate(s).slice(0, 6)} axisLine={false} tickLine={false} />
                    <YAxis tick={tick} allowDecimals={false} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<GrowthTooltip />} />
                    <Bar dataKey="total" name="Records added" fill={SINGLE} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <Card title="Parts by family" subtitle="Active parts">
              {data.partsByFamily.length ? <HBars data={data.partsByFamily} name="Parts" labelWidth={120} /> : <p className="text-sm text-secondary-text">No active parts.</p>}
            </Card>
            <Card title="Machines by site" subtitle="Active machines">
              {data.machinesBySite.length ? <HBars data={data.machinesBySite} name="Machines" labelWidth={120} /> : <p className="text-sm text-secondary-text">No active machines.</p>}
            </Card>
            <Card title="Employees by department" subtitle="Active employees">
              {data.employeesByDepartment.length ? <HBars data={data.employeesByDepartment} name="Employees" labelWidth={120} /> : <p className="text-sm text-secondary-text">No active employees.</p>}
            </Card>
            <Card title="Part revisions" subtitle="All parts, by status">
              {data.revisionsByStatus.length ? (
                <HBars data={data.revisionsByStatus.map((r) => ({ ...r, label: REVISION_STATUS[r.key]?.label ?? r.label }))} colorOf={(d) => REVISION_STATUS[d.key]?.color ?? SINGLE} name="Revisions" labelWidth={90} />
              ) : (
                <p className="text-sm text-secondary-text">No part revisions yet.</p>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card title="Recently added or changed" subtitle="The latest ten records across all kinds">
              {data.recent.length === 0 ? (
                <p className="text-sm text-secondary-text">Nothing has been added yet.</p>
              ) : (
                <ul aria-label="Recent changes" className="flex flex-col divide-y divide-border-color">
                  {data.recent.map((r) => (
                    <li key={`${r.kind}-${r.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 text-sm">
                      <span className="w-24 shrink-0 text-xs text-secondary-text">{KINDS[r.kind].one}</span>
                      <Link to={KINDS[r.kind].to} className="min-w-0 flex-1 truncate text-link-color hover:underline">
                        {r.label}
                      </Link>
                      <span className="text-xs text-secondary-text">
                        {r.action === "added" ? "Added" : "Changed"}
                        {r.by ? ` by ${r.by}` : ""} · {formatDateTime(r.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Integrations and change events" subtitle="What is connected, and what is queued for connectors">
              <p className="flex items-start gap-2 rounded-lg border border-border-color bg-primary-bg p-3 text-sm text-primary-text">
                <DatabaseIcon className="mt-0.5 h-4 w-4 shrink-0 text-secondary-text" aria-hidden="true" />
                <span>
                  No connectors, imports or sync runs are set up yet, so there is nothing to report on them. Master data is entered in Fortress QMS. Key events (part revisions released,
                  inspections, non-conformances, plan approvals and more) are already queued, ready for connectors when they exist.
                </span>
              </p>
              {events?.available ? (
                <>
                  <dl className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <dt className="text-secondary-text">Events in 24 hours</dt>
                      <dd className="text-xl font-semibold text-primary-text">{events.last24Hours}</dd>
                    </div>
                    <div>
                      <dt className="text-secondary-text">Waiting for a consumer</dt>
                      <dd className="text-xl font-semibold text-primary-text">{events.waiting}</dd>
                    </div>
                    <div>
                      <dt className="text-secondary-text">Oldest waiting</dt>
                      <dd className="text-sm font-medium text-primary-text">{events.oldestWaitingAt ? formatDateTime(events.oldestWaitingAt) : "—"}</dd>
                    </div>
                  </dl>
                  {events.byType.length > 0 && (
                    <div>
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-secondary-text">Event types, last 30 days</h3>
                      <HBars data={events.byType} name="Events" labelWidth={240} />
                    </div>
                  )}
                  {events.recent.length > 0 && (
                    <ul aria-label="Latest events" className="flex flex-col divide-y divide-border-color text-sm">
                      {events.recent.map((e) => (
                        <li key={e.id} className="flex flex-wrap items-center gap-x-3 py-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-primary-text">{e.type}</span>
                          <span className="text-xs text-secondary-text">
                            {e.processedAt ? "Consumed" : "Waiting"} · {formatDateTime(e.at)}
                          </span>
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
