import { Link, Navigate } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CircleCheckIcon, ClockIcon, GraduationCapIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Card, ChartTooltip, HBars, Kpi, grid, stackedBarShape, tick } from "../dashboard/DashboardParts";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCompetenceDashboard } from "../../hooks/useCompetence";
import { describeApiError } from "../../lib/api-client";
import { formatDate } from "../../lib/processControl";
import LoadingScreen from "../ui/LoadingScreen";

const TRAINING_SERIES = [
  { key: "completed", label: "Completed", color: "var(--chart-series-3)" },
  { key: "failed", label: "Failed", color: "var(--chart-critical)" },
];
const th = "py-1 pr-2 text-left font-medium";
const td = "py-1.5 pr-2 align-top";
const Empty = ({ children }) => <p className="py-6 text-center text-sm text-secondary-text">{children}</p>;
const linkClass = "shrink-0 whitespace-nowrap rounded-lg border border-border-color bg-secondary-bg px-3 py-1.5 text-sm text-primary-text hover:bg-border-color/50";

const daysWords = (days) => (days < 0 ? `${-days} ${days === -1 ? "day" : "days"} ago` : days === 0 ? "today" : `in ${days} ${days === 1 ? "day" : "days"}`);

/**
 * Competence dashboard (`/Competence`): who is short of what their positions need, assessments expired or expiring, people never assessed, and training in the period.
 * Gaps and expiry are as of today; training follows the period in the address. People without `competence.read` are sent to their own record.
 */
const CompetenceDashboard = () => {
  const { can, isLoading: loadingPermissions } = usePermissions();
  const period = useDashboardPeriod("90d");
  const { fromIso: from, toIso: to } = period;
  const readable = !loadingPermissions && can("competence.read");
  const { data, isLoading, isFetching, error } = useCompetenceDashboard({ from: readable ? from : undefined, to });
  // Wait for the permissions: on a direct visit they are not known yet, and "no permission" must not be guessed.
  if (loadingPermissions) return <LoadingScreen />;
  if (!readable) return <Navigate to="/Competence/Mine" replace />;
  const k = data?.kpis;
  const bucketLabel = (start) => format(new Date(`${start}T00:00:00`), data?.period.bucket === "month" ? "MMM yy" : "d MMM");

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-primary-text">
            <GraduationCapIcon className="h-6 w-6" aria-hidden="true" />
            Competence dashboard
          </h1>
          <p className="text-sm text-secondary-text" aria-live="polite">
            Training {formatDate(from)} – {formatDate(to)} · gaps and expiry as of today
            {isFetching && !isLoading ? " · updating…" : ""}
          </p>
        </div>
        <div className="flex flex-nowrap items-end gap-3 max-sm:flex-wrap">
          <Link to="/Competence/Matrix" className={linkClass}>
            Skills matrix
          </Link>
          <Link to="/Competence/Training" className={linkClass}>
            Training sessions
          </Link>
          <DashboardPeriodPicker period={period} />
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
          {describeApiError(error)}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-busy={isLoading || undefined}>
        <Kpi
          icon={TriangleAlertIcon}
          label="People with gaps"
          value={k ? k.withGaps : "—"}
          note={k ? `${k.gaps} ${k.gaps === 1 ? "skill" : "skills"} short · of ${k.withRequirements} with requirements` : ""}
          to="/Competence/Matrix?status=gap"
          alert={k?.withGaps > 0}
        />
        <Kpi
          icon={ClockIcon}
          label="Expired assessments"
          value={k ? k.expired : "—"}
          note="Past their expiry; levels are not lowered"
          to="/Competence/Matrix?status=expired"
          alert={k?.expired > 0}
        />
        <Kpi
          icon={ClockIcon}
          label="Expiring soon"
          value={k ? k.expiring30 : "—"}
          note={k ? `within 30 days · ${k.expiring60} in 60 · ${k.expiring90} in 90` : ""}
          to="/Competence/Matrix?status=expiring"
        />
        <Kpi icon={UsersIcon} label="Never assessed" value={k ? k.neverAssessed : "—"} note={k ? `of ${k.people} active people` : ""} alert={k?.neverAssessed > 0} />
        <Kpi icon={GraduationCapIcon} label="Training completed" value={k ? k.completions : "—"} note={k ? `${k.sessions} ${k.sessions === 1 ? "session" : "sessions"} started in the period` : ""} to="/Competence/Training" />
        <Kpi icon={CircleCheckIcon} label="Training failed" value={k ? k.failures : "—"} note="Results recorded as failed in the period" alert={k?.failures > 0} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Gaps by skill" subtitle="How many people are short of the level their positions need (top 10)">
          {data?.gapsBySkill.length ? (
            <HBars data={data.gapsBySkill.map((s) => ({ key: s.skillId, label: s.name, count: s.people }))} colorOf={() => "var(--chart-critical)"} name="People short" labelWidth={150} />
          ) : (
            <Empty>No one is short of a required level.</Empty>
          )}
        </Card>

        <Card title="Levels held" subtitle="Current assessments by level (active people and skills)">
          {data?.levels.some((l) => l.count) ? (
            <HBars data={data.levels.map((l) => ({ key: String(l.level), label: `${l.level} · ${l.label}`, count: l.count }))} name="Assessments" height={190} labelWidth={150} />
          ) : (
            <Empty>No assessments yet.</Empty>
          )}
        </Card>

        <Card title="Training results" subtitle={`Recorded per ${data?.period.bucket ?? "week"}, on the day each person completed it`}>
          {data?.training.length ? (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.training} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="Training results per period">
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                  <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                  <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span className="text-secondary-text">{v}</span>} />
                  {TRAINING_SERIES.map((s) => (
                    <Bar key={s.key} dataKey={s.key} name={s.label} stackId="s" fill={s.color} stroke="rgb(var(--secondary-bg))" strokeWidth={1} shape={stackedBarShape(TRAINING_SERIES.map((x) => x.key))} maxBarSize={36} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty>No training results recorded in this period.</Empty>
          )}
        </Card>

        <Card title="Furthest short" subtitle="People with the largest total gap against their positions">
          {data?.worstGaps.length ? (
            <table className="w-full text-sm" aria-label="People furthest short">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Person</th>
                  <th className={th}>Skills short</th>
                  <th className={th}>Biggest gaps</th>
                </tr>
              </thead>
              <tbody>
                {data.worstGaps.map((p) => (
                  <tr key={p.employeeId} className="border-t border-border-color">
                    <td className={td}>
                      <Link to={`/Competence/People/${p.employeeId}`} className="font-medium text-primary-text hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className={td}>{p.gapSkills}</td>
                    <td className={`${td} text-secondary-text`}>{p.skills.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Nobody has a gap.</Empty>
          )}
        </Card>

        <Card title="Next to expire" subtitle="Expired, or expiring within 90 days, soonest first">
          {data?.nextExpiries.length ? (
            <table className="w-full text-sm" aria-label="Assessments expiring">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Person</th>
                  <th className={th}>Skill</th>
                  <th className={th}>Expires</th>
                </tr>
              </thead>
              <tbody>
                {data.nextExpiries.map((e) => (
                  <tr key={`${e.employeeId}-${e.skillId}`} className="border-t border-border-color">
                    <td className={td}>
                      <Link to={`/Competence/People/${e.employeeId}`} className="font-medium text-primary-text hover:underline">
                        {e.name}
                      </Link>
                    </td>
                    <td className={td}>
                      {e.skill} <span className="text-secondary-text">· level {e.level}</span>
                    </td>
                    <td className={`${td} ${e.days < 0 ? "text-error-color" : ""}`}>
                      {formatDate(e.expiresOn)} <span className="text-xs">({daysWords(e.days)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Nothing has expired or expires within 90 days.</Empty>
          )}
        </Card>

        <Card title="Never assessed" subtitle="Active people with no assessment at all">
          {data?.neverAssessedPeople.length ? (
            <ul aria-label="People never assessed" className="flex flex-col divide-y divide-border-color text-sm">
              {data.neverAssessedPeople.map((p) => (
                <li key={p.employeeId} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <Link to={`/Competence/People/${p.employeeId}`} className="font-medium text-primary-text hover:underline">
                    {p.name}
                  </Link>
                  <span className="text-xs text-secondary-text">{p.positions.length ? p.positions.join(", ") : "No position"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Everyone has been assessed on something.</Empty>
          )}
        </Card>

        <Card title="Latest training" subtitle="The most recent sessions">
          {data?.recentTraining.length ? (
            <ul aria-label="Latest training sessions" className="flex flex-col divide-y divide-border-color text-sm">
              {data.recentTraining.map((s) => (
                <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <Link to={`/Competence/Training/${s.id}`} className="font-medium text-primary-text hover:underline">
                    {s.reference} · {s.title}
                  </Link>
                  <span className="text-xs text-secondary-text">
                    {formatDate(s.startsOn)} · {s.completed} of {s.attendees} completed{s.status === "cancelled" ? " · cancelled" : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No training sessions yet.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
};

export default CompetenceDashboard;
