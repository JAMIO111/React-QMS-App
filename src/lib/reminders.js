/** Reminders (docs/workflow-engine-plan.md, WK2). Mirrors `api/src/reminders/reminder-paths.ts`: built only from known areas and a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function reminderPath(area, targetId) {
  const t = typeof targetId === "string" && UUID.test(targetId) ? targetId : null;
  switch (area) {
    case "capa_actions":
      return "/CAPA/My-Actions";
    case "risk_actions":
    case "risk_reviews":
      return t ? `/Risk/Register/${t}` : "/Risk/My-Work";
    case "review_actions":
      return "/Management-Review/My-Actions";
    case "ncr_containment":
      return t ? `/Non-Conformance/Register/${t}` : null;
    case "audits":
      return t ? `/Audits/Templates/${t}` : "/Audits/Schedule";
    case "gauges":
      return t ? `/Calibration/Gauges/${t}` : "/Calibration/Gauges";
    case "documents_to_read":
      return "/Documentation/My-Documents";
    case "quality_alerts":
      return t ? `/Documentation/Quality-Alerts/${t}` : "/Documentation/My-Alerts";
    case "document_reviews":
      return t ? `/Documentation/Documents/${t}` : "/Documentation/Documents";
    case "scars":
      return t ? `/Supplier-Quality/SCARs/${t}` : "/Supplier-Quality/SCARs";
    case "competence":
      return "/Competence/Mine";
    default:
      return null;
  }
}

const day = (iso) => new Date(`${iso}T00:00:00`);
const fmt = (iso) => day(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "Overdue since 3 Nov 2026 (4 days)", "Due today", "Due tomorrow", "Due in 5 days (12 Nov 2026)". */
export function dueWords(dueOn, today) {
  const diff = Math.round((day(dueOn) - day(today)) / 86_400_000);
  if (diff < 0) return `Overdue since ${fmt(dueOn)} (${-diff} ${diff === -1 ? "day" : "days"})`;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  return `Due in ${diff} days (${fmt(dueOn)})`;
}

/** Times offered for the daily reminders: every quarter of an hour. */
export const REMINDER_TIMES = Array.from({ length: 96 }, (_, i) => {
  const v = `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`;
  return { value: v, label: v };
});
