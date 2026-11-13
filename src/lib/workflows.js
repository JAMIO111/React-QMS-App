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

/* ---------------- The rule builder (WF2) ---------------- */

/** The tests offered for a field, by its type (mirrors api/src/workflows/conditions.ts). */
export const OP_LABELS = {
  eq: "is",
  ne: "is not",
  in: "is one of",
  not_in: "is none of",
  gte: "is at least",
  lte: "is at most",
  empty: "is empty",
  not_empty: "is filled in",
};
export const opsFor = (field) => {
  if (!field) return [];
  if (field.type === "ordered") return ["eq", "ne", "in", "not_in", "gte", "lte", "empty", "not_empty"];
  if (field.type === "text") return ["eq", "ne", "in", "not_in", "empty", "not_empty"];
  return ["eq", "ne", "in", "not_in", "empty", "not_empty"];
};
export const isListOp = (op) => op === "in" || op === "not_in";
export const needsValue = (op) => op !== "empty" && op !== "not_empty";

export const RECIPIENT_KINDS = [
  { value: "record_owner", label: "The record's owner" },
  { value: "person", label: "A person" },
  { value: "role", label: "Everyone with a role" },
  { value: "department", label: "Everyone in a department" },
];

export const newCondition = (trigger) => {
  const field = trigger?.fields?.[0];
  return { field: field?.key ?? "", op: field?.type === "ordered" ? "gte" : "eq", value: "" };
};
export const newAction = (type = "notify") =>
  type === "task" ? { type: "task", assignee: { kind: "record_owner" }, title: "", detail: "", dueDays: "" } : { type: "notify", recipients: [{ kind: "record_owner" }], message: "" };
export const emptyDraft = () => ({ name: "", description: "", trigger: "", match: "all", conditions: [], actions: [newAction("notify")] });

const valueWords = (field, v, labels = {}) => field?.options?.find((o) => o.value === v)?.label ?? (field?.type === "ref" ? labels[v] ?? "a record no longer listed" : v);

/** "Severity is at least Major", "Part is one of A, B". */
export function describeCondition(c, trigger, labels = {}) {
  const field = trigger?.fields?.find((f) => f.key === c.field);
  const name = field?.label ?? c.field;
  if (!needsValue(c.op)) return `${name} ${OP_LABELS[c.op] ?? c.op}`;
  const values = Array.isArray(c.value) ? c.value : c.value ? [c.value] : [];
  return `${name} ${OP_LABELS[c.op] ?? c.op} ${values.map((v) => valueWords(field, v, labels)).join(", ")}`;
}

export function describeRecipient(r, labels = {}) {
  if (r.kind === "record_owner") return "the record's owner";
  if (r.kind === "person") return labels[r.userId] ?? "a person";
  if (r.kind === "role") return `everyone with the role ${labels[r.roleId] ?? "(a role)"}`;
  if (r.kind === "department") return `everyone in ${labels[r.departmentId] ?? "(a department)"}`;
  return "someone";
}

/** "Tell the record's owner and Ann Smith: “Have a look”" / "Give the record's owner a task: “Check” (due in 2 days)". */
export function describeAction(a, labels = {}) {
  if (a.type === "task") {
    const due = a.dueDays === 0 ? " (due the same day)" : a.dueDays ? ` (due in ${a.dueDays} day${a.dueDays === 1 ? "" : "s"})` : "";
    return `Give ${describeRecipient(a.assignee, labels)} a task: “${a.title}”${due}`;
  }
  return `Tell ${a.recipients.map((r) => describeRecipient(r, labels)).join(", ")}: “${a.message}”`;
}

/** A saved rule as the builder edits it. */
export function draftFromRule(rule) {
  const any = rule.conditions?.any ?? [];
  const all = rule.conditions?.all ?? [];
  return {
    name: rule.name ?? "",
    description: rule.description ?? "",
    trigger: rule.trigger ?? "",
    match: any.length && !all.length ? "any" : "all",
    conditions: (any.length && !all.length ? any : all).map((c) => ({ field: c.field, op: c.op, value: c.value ?? "" })),
    actions: (rule.actions ?? []).map((a) =>
      a.type === "task"
        ? { type: "task", assignee: { ...a.assignee }, title: a.title ?? "", detail: a.detail ?? "", dueDays: a.dueDays ?? "" }
        : { type: "notify", recipients: a.recipients.map((r) => ({ ...r })), message: a.message ?? "" },
    ),
  };
}

const cleanValue = (c) => {
  if (!needsValue(c.op)) return undefined;
  if (isListOp(c.op)) return (Array.isArray(c.value) ? c.value : String(c.value ?? "").split(",")).map((v) => String(v).trim()).filter(Boolean);
  const v = Array.isArray(c.value) ? c.value[0] : c.value;
  return v === undefined || v === null ? "" : String(v).trim();
};

/** What the API takes: trigger, conditions, actions (name and description added by the caller). */
export function ruleContent(draft) {
  const conditions = draft.conditions.map((c) => {
    const value = cleanValue(c);
    return value === undefined ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value };
  });
  return {
    trigger: draft.trigger,
    conditions: draft.match === "any" ? { any: conditions } : { all: conditions },
    actions: draft.actions.map((a) => {
      if (a.type === "task") {
        const out = { type: "task", assignee: a.assignee, title: a.title.trim() };
        if (a.detail?.trim()) out.detail = a.detail.trim();
        if (a.dueDays !== "" && a.dueDays !== null && a.dueDays !== undefined) out.dueDays = Number(a.dueDays);
        return out;
      }
      return { type: "notify", recipients: a.recipients, message: a.message.trim() };
    }),
  };
}

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
/** Whether what the rule does (trigger, conditions, actions) differs from the saved rule — only then is a reason needed. */
export const contentChanged = (draft, rule) => {
  if (!rule) return true;
  const saved = ruleContent(draftFromRule(rule));
  return JSON.stringify(sortKeys(ruleContent(draft))) !== JSON.stringify(sortKeys(saved));
};

/** What is still needed before the rule can be saved or tested (empty = fine). */
export function draftProblems(draft, trigger) {
  const problems = [];
  if (!draft.name.trim()) problems.push("Give the rule a name");
  if (!trigger) {
    problems.push("Choose what starts the rule");
    return problems;
  }
  draft.conditions.forEach((c, i) => {
    const field = trigger.fields.find((f) => f.key === c.field);
    if (!field) problems.push(`Condition ${i + 1}: choose what to test`);
    else if (needsValue(c.op)) {
      const v = cleanValue(c);
      if (Array.isArray(v) ? v.length === 0 : !v) problems.push(`Condition ${i + 1}: say what ${field.label.toLowerCase()} to compare with`);
    }
  });
  if (!draft.actions.length) problems.push("Add at least one thing for the rule to do");
  draft.actions.forEach((a, i) => {
    const n = i + 1;
    if (a.type === "notify") {
      if (!a.message.trim()) problems.push(`Action ${n}: write the message`);
      if (!a.recipients.length) problems.push(`Action ${n}: say who is told`);
      a.recipients.forEach((r) => {
        if ((r.kind === "person" && !r.userId) || (r.kind === "role" && !r.roleId) || (r.kind === "department" && !r.departmentId)) problems.push(`Action ${n}: choose who`);
      });
    } else {
      if (!a.title.trim()) problems.push(`Action ${n}: give the task a title`);
      if (a.assignee.kind === "person" && !a.assignee.userId) problems.push(`Action ${n}: choose who gets the task`);
      if (a.dueDays !== "" && a.dueDays !== null && a.dueDays !== undefined && !(Number.isInteger(Number(a.dueDays)) && Number(a.dueDays) >= 0 && Number(a.dueDays) <= 365))
        problems.push(`Action ${n}: due in 0 to 365 days`);
    }
  });
  return [...new Set(problems)];
}

export const RULE_STATUS = {
  active: { label: "Active", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  retired: { label: "Retired", tone: "neutral" },
};
export const RUN_STATUS = { running: "Running", done: "Done", partial: "Partly done", failed: "Failed" };
export const workflowRulePath = (id) => `/Settings/Workflows/${id}`;
export const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never");
