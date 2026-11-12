import { ncrPath } from "./ncr";

/** Workflow rules (WF1): where a record named by a rule's notice or task lives. Mirrors `workflowRecordPath` in api/src/workflows/catalogue.ts. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workflowRecordPath(kind, id) {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  switch (kind) {
    case "nonconformance":
      return ncrPath(id);
    case "inspection":
      return `/Inspections/${id}`;
    case "gauge":
      return `/Calibration/Gauges/${id}`;
    case "capa":
      return `/CAPA/${id}/d0`;
    case "audit_finding":
      return `/Audits/Findings/${id}`;
    case "supplier":
      return `/Suppliers/${id}`;
    default:
      return null;
  }
}

export const TASK_STATUS = {
  open: { label: "Open", tone: "warning" },
  done: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: undefined },
};

/** "due 14 Nov 2026", or null. */
export function dueWords(dueOn) {
  if (!dueOn) return null;
  const d = new Date(`${dueOn}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return `due ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}
