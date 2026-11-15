// Words and paths for the Connector Agent screens (docs/connector-agent-plan.md AG1).

export const agentsPath = () => "/Settings/Integrations/Agents";
export const agentPath = (id) => `/Settings/Integrations/Agents/${id}`;

/** How long a registration token lasts, as offered when adding an agent. */
export const TOKEN_LIFETIMES = [
  { value: "1", label: "1 hour" },
  { value: "24", label: "24 hours" },
  { value: "72", label: "3 days" },
  { value: "168", label: "7 days" },
];

/** online / offline / revoked, in words and a colour tone. */
export const agentState = (a) => {
  if (!a) return { label: "", tone: "neutral" };
  if (a.status === "revoked") return { label: "Revoked", tone: "error" };
  return a.online ? { label: "Online", tone: "success" } : { label: "Offline", tone: "warning" };
};

const JOB_STATUS = {
  pending: { label: "Waiting for the agent", tone: "neutral" },
  received: { label: "Taken by the agent", tone: "neutral" },
  running: { label: "Running", tone: "warning" },
  completed: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export const jobStatus = (status) => JOB_STATUS[status] ?? { label: status, tone: "neutral" };
export const jobRunning = (status) => status === "pending" || status === "received" || status === "running";

const JOB_KINDS = { ping: "Check the agent", test_connection: "Test a connection", discover: "Browse a database", preview: "Preview a table", extract: "Read records" };
export const jobKind = (kind) => JOB_KINDS[kind] ?? kind;

/** "2 minutes ago", "just now", "3 days ago" (no clock needed beyond Date.now()). */
export const ago = (iso, now = Date.now()) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
};

/** One line per lifecycle event, as people would say it. */
export const eventWords = (e) => {
  const d = e.detail ?? {};
  switch (e.kind) {
    case "registered":
      return `Registered${d.machine ? ` on ${d.machine}` : ""}${d.version ? ` (version ${d.version})` : ""}`;
    case "replaced":
      return `Reinstalled${d.machine ? ` on ${d.machine}` : ""} with a new key`;
    case "key_rotated":
      return "Changed its key";
    case "came_online":
      return d.away ? `Came back online after ${Math.round(d.away / 60)} minutes away` : "Came online";
    case "version_changed":
      return `Updated from version ${d.from ?? "?"} to ${d.to ?? "?"}`;
    case "renamed":
      return `Renamed from "${d.from}" to "${d.to}"`;
    case "revoked":
      return `Revoked: ${d.reason ?? ""}`;
    case "deregistered":
      return "Uninstalled on its machine";
    case "job_failed":
      return `A job failed (${d.error ?? "error"})`;
    default:
      return e.kind;
  }
};

/** What a completed ping answered, in words. */
export const pingWords = (job) => {
  if (!job || job.status !== "completed") return null;
  const r = job.result ?? {};
  const parts = ["The agent answered"];
  if (r.version) parts.push(`(version ${r.version})`);
  if (r.agentTime) {
    const skew = Math.round((new Date(r.agentTime).getTime() - new Date(job.finishedAt ?? Date.now()).getTime()) / 1000);
    if (Math.abs(skew) > 60) parts.push(`— its clock is ${Math.abs(skew)} seconds ${skew > 0 ? "ahead" : "behind"}`);
  }
  return parts.join(" ");
};
