import { Link } from "react-router-dom";
import { ArrowRightIcon, BellIcon, CircleCheckIcon, EyeIcon, FileTextIcon, ListChecksIcon, ListTodoIcon, PresentationIcon, ShieldAlertIcon, TriangleAlertIcon } from "@/components/icons";
import { useHomeDashboard } from "../../hooks/useHomeDashboard";
import { describeApiError } from "../../lib/api-client";
import Callout from "../ui/Callout";
import { ACCENT, Chip, Empty, HeroCard, SplitBar, StatTile } from "./DashboardGraphics";
import { Card } from "./DashboardParts";

const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
const TONE = { critical: "error", warning: "warning" };
const PERSONAL_ICON = { alerts: BellIcon, documents: FileTextIcon, reviews: EyeIcon, actions: ListChecksIcon, risk: ShieldAlertIcon, reviewActions: PresentationIcon, tasks: ListTodoIcon };
const heading = "text-sm font-semibold uppercase tracking-wide text-secondary-text";

/** One thing to act on: how many, what, and the way to it. */
const AttentionLine = ({ line, module }) => (
  <li>
    <Link to={line.to} className="group flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm hover:bg-primary-text/5">
      {module && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-primary-text" style={{ background: tint(ACCENT, 16) }}>
          <module.icon className="h-4 w-4" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-10 shrink-0 text-right">
        <Chip tone={TONE[line.tone]}>{line.count.toLocaleString("en-GB")}</Chip>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-primary-text">{line.label}</span>
        {module && <span className="text-xs text-secondary-text">{module.label}</span>}
      </span>
      <span className="sr-only">{line.tone === "critical" ? " (critical)" : " (to watch)"}</span>
      <ArrowRightIcon className="h-4 w-4 shrink-0 text-secondary-text opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
    </Link>
  </li>
);

/** A module on the home page: its headline figure, how it stands, and each thing in it that needs someone. */
const ModuleCard = ({ module }) => {
  const critical = module.lines.filter((l) => l.tone === "critical").length;
  const watch = module.lines.length - critical;
  return (
    <section aria-label={module.label} data-tile={module.label} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: tint(ACCENT, 16), color: ACCENT }}>
          <module.icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-primary-text">
          <Link to={module.to} className="hover:underline">
            {module.label}
          </Link>
        </h3>
        {module.lines.length === 0 ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-success-color">
            <CircleCheckIcon className="h-4 w-4" aria-hidden="true" />
            All clear
          </span>
        ) : (
          <span className="flex shrink-0 flex-wrap justify-end gap-1">
            {critical > 0 && <Chip tone="error">{critical} critical</Chip>}
            {watch > 0 && <Chip tone="warning">{watch} to watch</Chip>}
          </span>
        )}
      </div>

      <p className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-primary-text">{typeof module.headline.value === "number" ? module.headline.value.toLocaleString("en-GB") : module.headline.value}</span>
        <span className="text-sm text-secondary-text">{module.headline.label}</span>
      </p>
      {module.lines.length > 0 ? (
        <ul aria-label={`${module.label}: needs attention`} className="-mx-2 flex flex-col">
          {module.lines.map((l) => (
            <AttentionLine key={l.key} line={l} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-secondary-text">Nothing here needs attention.</p>
      )}
    </section>
  );
};

/**
 * The home page's summary of every module: what needs attention across the areas the person may read, their own to-dos, and a card per area.
 * Each figure is the module's own (its dashboard's answer), and each line leads to the list behind it.
 */
const HomeAttention = () => {
  const { modules, summary, personal, isLoading, error } = useHomeDashboard();
  if (!isLoading && !error && modules.length === 0 && personal.length === 0) return null;
  const urgent = summary.urgent.slice(0, 6);

  return (
    <>
      {isLoading && (
        <div role="status" aria-label="Checking what needs attention" className="grid animate-pulse grid-cols-1 gap-4 motion-reduce:animate-none xl:grid-cols-5">
          <span className="h-52 rounded-3xl bg-secondary-bg xl:col-span-2" />
          <span className="h-52 rounded-2xl bg-secondary-bg xl:col-span-3" />
        </div>
      )}
      {error && (
        <Callout tone="error" role="alert" title="What needs attention could not be loaded">
          {describeApiError(error)}
        </Callout>
      )}
      {modules.length > 0 && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
          <HeroCard
            label="Needs attention"
            icon={TriangleAlertIcon}
            className="xl:col-span-2"
            value={summary.total}
            note={
              summary.total === 0
                ? "Nothing needs attention in the areas you can see."
                : `${summary.critical} critical · ${summary.warning} to watch · in ${summary.areas} of ${modules.length} areas`
            }>
            <SplitBar
              tall
              label="What needs attention"
              unit="thing"
              parts={[
                { key: "critical", label: "Critical: late, failed or quarantined", count: summary.critical, color: "var(--chart-critical)" },
                { key: "warning", label: "To watch: waiting or due soon", count: summary.warning, color: "var(--chart-warning)" },
              ]}
              showZero
              columns={1}
            />
          </HeroCard>
          <Card title="Act on these first" subtitle="Late, failed or quarantined, largest first" className="xl:col-span-3">
            {urgent.length > 0 ? (
              <ul aria-label="Most urgent" className="-mx-2 grid grid-cols-1 gap-x-4 lg:grid-cols-2">
                {urgent.map((l) => (
                  <AttentionLine key={`${l.module.key}-${l.key}`} line={l} module={l.module} />
                ))}
              </ul>
            ) : (
              <Empty>Nothing is late, failed or quarantined.</Empty>
            )}
            {summary.urgent.length > urgent.length && <p className="text-xs text-secondary-text">{summary.urgent.length - urgent.length} more are listed by area below.</p>}
          </Card>
        </div>
      )}

      {personal.length > 0 && (
        <section aria-label="For you" className="flex flex-col gap-3">
          <h2 className={heading}>For you</h2>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {personal.map((p) => (
              <StatTile
                key={p.key}
                icon={PERSONAL_ICON[p.key]}
                label={p.label}
                value={p.count ?? "—"}
                to={p.to}
                alert={p.overdue > 0}
                note={p.overdue > 0 ? `${p.overdue} overdue` : p.count > 0 ? "Waiting for you" : p.count === 0 ? "Nothing waiting" : ""}
              />
            ))}
          </div>
        </section>
      )}

      {modules.length > 0 && (
        <section aria-label="By area" className="flex flex-col gap-3">
          <h2 className={heading}>By area</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {modules.map((m) => (
              <ModuleCard key={m.key} module={m} />
            ))}
          </div>
        </section>
      )}
    </>
  );
};

export default HomeAttention;
