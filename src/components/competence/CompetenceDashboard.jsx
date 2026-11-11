import { Link, Navigate } from "react-router-dom";
import { format } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CircleXIcon, ClockIcon, GraduationCapIcon, HourglassIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";
import Breadcrumb from "../Breadcrumb";
import Callout from "../ui/Callout";
import { DashboardPeriodPicker } from "../dashboard/DashboardPeriod";
import { Chip, Empty, HeroCard, Initial, Meter, RankList, SplitBar, StatTile, headerLink as linkClass } from "../dashboard/DashboardGraphics";
import { Card, ChartTooltip, grid, stackedBarShape, tick } from "../dashboard/DashboardParts";
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
const th = "py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide";
const td = "py-2 pr-3 align-middle";

/** Levels are an order, so they share one colour that deepens with the level; "none" is grey. */
const LEVEL_COLOUR = ["var(--chart-neutral)", ...[30, 52, 76, 100].map((pct) => `color-mix(in srgb, var(--brand-primary) ${pct}%, rgb(var(--secondary-bg)))`)];
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
  const levelParts = (data?.levels ?? []).map((l) => ({ key: String(l.level), label: `${l.level} · ${l.label}`, color: LEVEL_COLOUR[l.level] ?? "var(--chart-neutral)", count: l.count }));
  const trainingParts = TRAINING_SERIES.map((t) => ({ key: t.key, label: t.label, color: t.color, count: (data?.training ?? []).reduce((n, b) => n + (b[t.key] ?? 0), 0) }));
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
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      )}

      {/* Who is short of what, as of today. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" aria-busy={isLoading || undefined}>
        <HeroCard
          label="People with gaps"
          icon={TriangleAlertIcon}
          value={k ? k.withGaps : "—"}
          note={k ? `${k.gaps} ${k.gaps === 1 ? "skill" : "skills"} short · of ${k.withRequirements} with requirements` : "Against what their positions need"}
          to="/Competence/Matrix?status=gap"
          className="xl:col-span-5">
          <span className="text-sm font-semibold text-primary-text">Gaps by skill</span>
          <span className="text-xs text-secondary-text">How many people are short of the level their positions need (top 10)</span>
          {data?.gapsBySkill.length ? (
            <RankList items={data.gapsBySkill.map((s) => ({ key: s.skillId, label: s.name, count: s.people }))} label="People short by skill" color="var(--chart-critical)" showShare={false} />
          ) : (
            <Empty>No one is short of a required level.</Empty>
          )}
        </HeroCard>

        <div className="flex flex-col gap-4 xl:col-span-7">
          <Card title="Levels held" subtitle="Current assessments by level (active people and skills)" className="rounded-3xl">
            {levelParts.some((l) => l.count) ? <SplitBar parts={levelParts} label="Levels held" unit="assessment" showZero /> : <Empty>No assessments yet.</Empty>}
          </Card>
          <Card title="Furthest short" subtitle="People with the largest total gap against their positions" className="flex-1 rounded-3xl">
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
                        <span className="flex items-center gap-2">
                          <Initial name={p.name} />
                          <Link to={`/Competence/People/${p.employeeId}`} className="font-medium text-primary-text hover:underline">
                            {p.name}
                          </Link>
                        </span>
                      </td>
                      <td className={`${td} tabular-nums`}>{p.gapSkills}</td>
                      <td className={`${td} text-secondary-text`}>{p.skills.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>Nobody has a gap.</Empty>
            )}
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-busy={isLoading || undefined}>
        <StatTile icon={ClockIcon} label="Expired assessments" value={k ? k.expired : "—"} note="Past their expiry; levels are not lowered" to="/Competence/Matrix?status=expired" alert={k?.expired > 0} />
        <StatTile icon={HourglassIcon} label="Expiring soon" value={k ? k.expiring30 : "—"} note={k ? `within 30 days · ${k.expiring60} in 60 · ${k.expiring90} in 90` : ""} to="/Competence/Matrix?status=expiring" />
        <StatTile icon={UsersIcon} label="Never assessed" value={k ? k.neverAssessed : "—"} note={k ? `of ${k.people} active people` : ""} alert={k?.neverAssessed > 0}>
          {k?.people > 0 && <Meter part={k.neverAssessed} whole={k.people} color="var(--chart-critical)" label="Active people never assessed" />}
        </StatTile>
        <StatTile icon={GraduationCapIcon} label="Training completed" value={k ? k.completions : "—"} note={k ? `${k.sessions} ${k.sessions === 1 ? "session" : "sessions"} started in the period` : ""} to="/Competence/Training" />
        <StatTile icon={CircleXIcon} label="Training failed" value={k ? k.failures : "—"} note="Results recorded as failed in the period" alert={k?.failures > 0} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card title="Training results" subtitle={`Recorded per ${data?.period.bucket ?? "week"}, on the day each person completed it`} className="xl:col-span-7">
          {data?.training.length ? (
            <>
              <SplitBar parts={trainingParts} label="Training results in the period" unit="result" showZero />
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.training} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="20%" aria-label="Training results per period">
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="start" tickFormatter={bucketLabel} tick={tick} axisLine={false} tickLine={false} minTickGap={12} />
                    <YAxis allowDecimals={false} tick={tick} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: "var(--chart-grid)" }} content={<ChartTooltip labelFormat={bucketLabel} />} />
                    {TRAINING_SERIES.map((s) => (
                      <Bar key={s.key} dataKey={s.key} name={s.label} stackId="s" fill={s.color} stroke="rgb(var(--secondary-bg))" strokeWidth={2} shape={stackedBarShape(TRAINING_SERIES.map((x) => x.key))} maxBarSize={24} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : (
            <Empty>No training results recorded in this period.</Empty>
          )}
        </Card>

        <Card title="Latest training" subtitle="The most recent sessions" className="xl:col-span-5">
          {data?.recentTraining.length ? (
            <ul aria-label="Latest training sessions" className="flex flex-col divide-y divide-border-color text-sm">
              {data.recentTraining.map((s) => (
                <li key={s.id} className="flex flex-col gap-1.5 py-2">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <Link to={`/Competence/Training/${s.id}`} className="font-medium text-primary-text hover:underline">
                      {s.reference} · {s.title}
                    </Link>
                    {s.status === "cancelled" && <Chip>cancelled</Chip>}
                  </span>
                  <span className="flex items-center gap-3 text-xs text-secondary-text">
                    <span className="whitespace-nowrap">{formatDate(s.startsOn)}</span>
                    <span className="w-24 shrink-0">
                      <Meter part={s.completed} whole={s.attendees} color="var(--chart-series-3)" label="Attendees who completed it" />
                    </span>
                    <span className="whitespace-nowrap">
                      {s.completed} of {s.attendees} completed
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No training sessions yet.</Empty>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card title="Next to expire" subtitle="Expired, or expiring within 90 days, soonest first" className="xl:col-span-7">
          {data?.nextExpiries.length ? (
            <table className="w-full text-sm" aria-label="Assessments expiring">
              <thead className="text-secondary-text">
                <tr>
                  <th className={th}>Person</th>
                  <th className={th}>Skill</th>
                  <th className={`${th} text-right`}>Expires</th>
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
                    <td className={`${td} text-right`}>
                      <span className="flex flex-wrap items-center justify-end gap-2 whitespace-nowrap">
                        {formatDate(e.expiresOn)}
                        <Chip tone={e.days < 0 ? "error" : "warning"}>{daysWords(e.days)}</Chip>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Nothing has expired or expires within 90 days.</Empty>
          )}
        </Card>

        <Card title="Never assessed" subtitle="Active people with no assessment at all" className="xl:col-span-5">
          {data?.neverAssessedPeople.length ? (
            <ul aria-label="People never assessed" className="flex flex-col divide-y divide-border-color text-sm">
              {data.neverAssessedPeople.map((p) => (
                <li key={p.employeeId} className="flex items-center gap-3 py-2">
                  <Initial name={p.name} />
                  <span className="flex min-w-0 flex-col">
                    <Link to={`/Competence/People/${p.employeeId}`} className="font-medium text-primary-text hover:underline">
                      {p.name}
                    </Link>
                    <span className="text-xs text-secondary-text">{p.positions.length ? p.positions.join(", ") : "No position"}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Everyone has been assessed on something.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
};

export default CompetenceDashboard;
