import { usePlatformWorker } from "../../hooks/usePlatform";
import { Card, Panel, Table, Tile, Tiles } from "./Panels";
import { ago, when } from "./format";
import Callout from "../ui/Callout";

const OUTCOME = { done: "Done", partial: "Partly failed", error: "Failed", skipped: "Skipped (another tick was working)", running: "Running" };
const STEP = { "quality-alerts": "Quality alerts", documents: "Documents", reminders: "Reminders", jobs: "Jobs", email: "Email", imports: "Imports" };

const stepWords = (s) => {
  if (!s.ok) return `${STEP[s.name] ?? s.name}: failed`;
  if (s.result?.skipped) return `${STEP[s.name] ?? s.name}: skipped`;
  return `${STEP[s.name] ?? s.name} ${s.ms} ms`;
};

/** Is the background worker running? Ticks, the job queue, failures and outbox backlogs — kinds, counts and errors only, never payloads. */
const WorkerPanel = () => {
  const query = usePlatformWorker();
  return (
    <Panel query={query}>
      {(w) => {
        const last = w.lastTick;
        const silentMs = last ? Date.now() - new Date(last.startedAt).getTime() : Infinity;
        const silent = silentMs > 5 * 60 * 1000;
        const jobs = w.jobs ?? {};
        return (
          <div className="flex flex-col gap-4">
            {!w.cronConfigured && (
              <Callout tone="warning" title="The worker cannot be called">
                CRON_SECRET is not set on the API, so the tick answers 503. Set it, and the same secret in Supabase Vault (see supabase/runbooks/worker-schedule.sql).
              </Callout>
            )}
            {w.cronConfigured && silent && (
              <Callout tone="warning" title={last ? "The worker has gone quiet" : "The worker has never run"}>
                {last ? `The last tick started ${ago(last.startedAt)}.` : "No tick has been recorded."} pg_cron should call it every minute: check the schedule and pg_net's
                responses in Supabase (supabase/runbooks/worker-schedule.sql) and the API logs.
              </Callout>
            )}
            <Tiles label="Worker health">
              <Tile label="Last tick" value={last ? ago(last.startedAt) : "Never"} hint={last ? `${OUTCOME[last.outcome] ?? last.outcome} · ${last.durationMs ?? "—"} ms · ${last.source}` : null} tone={silent ? "warn" : undefined} />
              <Tile label="Ticks in the last hour" value={w.lastHour?.ticks ?? 0} hint={w.lastHour?.skipped ? `${w.lastHour.skipped} skipped` : null} tone={(w.lastHour?.problems ?? 0) > 0 ? "warn" : undefined} />
              <Tile label="Jobs due" value={jobs.due ?? 0} hint={jobs.oldestDue ? `oldest due ${ago(jobs.oldestDue)}` : `${jobs.waiting ?? 0} waiting in all`} />
              <Tile label="Jobs failed" value={(jobs.failures ?? []).filter((f) => f.status === "failed").length} tone={(jobs.failures ?? []).some((f) => f.status === "failed") ? "bad" : undefined} />
            </Tiles>
            <Card title="Latest ticks" subtitle="Most recent first, with what each step did.">
              <Table caption="Latest ticks" head={["Started", "Source", "Outcome", "Time", "Steps"]} empty={(w.recentTicks ?? []).length === 0 ? "No ticks yet." : null}>
                {(w.recentTicks ?? []).map((t) => (
                  <tr key={t.id} className="border-b border-border-color align-top last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap text-primary-text">{when(t.startedAt)}</td>
                    <td className="py-2 pr-3 text-primary-text">{t.source}</td>
                    <td className={`py-2 pr-3 ${t.outcome === "done" || t.outcome === "skipped" ? "text-primary-text" : "text-error-color"}`}>{OUTCOME[t.outcome] ?? t.outcome}</td>
                    <td className="py-2 pr-3 tabular-nums text-primary-text">{t.durationMs != null ? `${t.durationMs} ms` : "—"}</td>
                    <td className="py-2 text-secondary-text">
                      {(t.steps ?? []).map(stepWords).join(" · ") || "—"}
                      {t.error && t.outcome !== "skipped" && <span className="block text-error-color">{t.error}</span>}
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title="Jobs" subtitle={`Waiting, running and finished in the last 24 hours, by kind. Handlers on this server: ${(w.jobKinds ?? []).join(", ") || "none yet"}.`}>
              <Table caption="Jobs by kind" head={["Kind", "Status", "Jobs"]} empty={(jobs.byKind ?? []).length === 0 ? "No jobs." : null}>
                {(jobs.byKind ?? []).map((k) => (
                  <tr key={`${k.kind}-${k.status}`} className="border-b border-border-color last:border-0">
                    <td className="py-2 pr-3 text-primary-text">{k.kind}</td>
                    <td className="py-2 pr-3 text-primary-text">{k.status}</td>
                    <td className="py-2 tabular-nums text-primary-text">{k.count}</td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title="Job problems" subtitle="Failed jobs and ones being tried again, most recent first (up to 25).">
              <Table caption="Job problems" head={["When", "Kind", "Organisation", "Status", "Attempts", "Error"]} empty={(jobs.failures ?? []).length === 0 ? "No problems." : null}>
                {(jobs.failures ?? []).map((f, i) => (
                  <tr key={`${f.at}-${i}`} className="border-b border-border-color align-top last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap text-primary-text">{when(f.at)}</td>
                    <td className="py-2 pr-3 text-primary-text">{f.kind}</td>
                    <td className="py-2 pr-3 text-primary-text">{f.organisation ?? "—"}</td>
                    <td className="py-2 pr-3 text-primary-text">{f.status === "failed" ? "Failed" : "Trying again"}</td>
                    <td className="py-2 pr-3 tabular-nums text-primary-text">{f.attempts}</td>
                    <td className="py-2 text-error-color">{f.error ?? "—"}</td>
                  </tr>
                ))}
              </Table>
            </Card>
            {(w.consumers ?? []).length > 0 && (
              <Card title="Event readers" subtitle="Each reads every change event once; the backlog is what it has not had yet.">
                <Table caption="Event readers" head={["Reader", "Backlog", "Delivered", "Last read"]}>
                  {w.consumers.map((c) => (
                    <tr key={c.name} className="border-b border-border-color last:border-0">
                      <td className="py-2 pr-3 text-primary-text">{c.name}</td>
                      <td className="py-2 pr-3 tabular-nums text-primary-text">{c.backlog}</td>
                      <td className="py-2 pr-3 tabular-nums text-primary-text">{c.delivered}</td>
                      <td className="py-2 text-primary-text">{c.lastReadAt ? ago(c.lastReadAt) : "never"}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}
          </div>
        );
      }}
    </Panel>
  );
};

export default WorkerPanel;
