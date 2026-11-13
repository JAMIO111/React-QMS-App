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
/** The record kinds a lot can be found on (a non-conformance's lot, the lot of the inspection a failed reading belongs to). */
export const LOT_ENTITIES = ["nonconformance", "inspection_measurement"];
export const canHoldLot = (trigger) => LOT_ENTITIES.includes(trigger?.entityType);

export const newAction = (type = "notify") => {
  if (type === "task") return { type: "task", assignee: { kind: "record_owner" }, title: "", detail: "", dueDays: "" };
  if (type === "hold_lot") return { type: "hold_lot", reason: "" };
  if (type === "later") return { type: "later", afterDays: 3, match: "all", conditions: [], actions: [newAction("notify")] };
  return { type: "notify", recipients: [{ kind: "record_owner" }], message: "" };
};
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

const days = (n) => `${n} day${Number(n) === 1 ? "" : "s"}`;
const conditionsOf = (c) => [...(c?.all ?? []), ...(c?.any ?? [])];

/** "Tell the record's owner and Ann Smith: “Have a look”" / "Give the record's owner a task: “Check” (due in 2 days)" / "Put the lot on hold" / a timer. */
export function describeAction(a, labels = {}, trigger) {
  if (a.type === "task") {
    const due = a.dueDays === 0 ? " (due the same day)" : a.dueDays ? ` (due in ${days(a.dueDays)})` : "";
    return `Give ${describeRecipient(a.assignee, labels)} a task: “${a.title}”${due}`;
  }
  if (a.type === "hold_lot") return `Put the lot on hold: “${a.reason}”`;
  if (a.type === "later") {
    const list = conditionsOf(a.conditions);
    const still = list.length ? ` if ${a.conditions?.any?.length ? "any of: " : ""}${list.map((c) => describeCondition(c, trigger, labels)).join(a.conditions?.any?.length ? "; " : " and ")}` : "";
    return `After ${days(a.afterDays)}${still}: ${a.actions.map((x) => describeAction(x, labels, trigger)).join("; ")}`;
  }
  return `Tell ${a.recipients.map((r) => describeRecipient(r, labels)).join(", ")}: “${a.message}”`;
}

const conditionsToDraft = (conditions) => {
  const any = conditions?.any ?? [];
  const all = conditions?.all ?? [];
  const useAny = any.length > 0 && !all.length;
  return { match: useAny ? "any" : "all", conditions: (useAny ? any : all).map((c) => ({ field: c.field, op: c.op, value: c.value ?? "" })) };
};

const actionToDraft = (a) => {
  if (a.type === "task") return { type: "task", assignee: { ...a.assignee }, title: a.title ?? "", detail: a.detail ?? "", dueDays: a.dueDays ?? "" };
  if (a.type === "hold_lot") return { type: "hold_lot", reason: a.reason ?? "" };
  if (a.type === "later") return { type: "later", afterDays: a.afterDays ?? 1, ...conditionsToDraft(a.conditions), actions: (a.actions ?? []).map(actionToDraft) };
  return { type: "notify", recipients: a.recipients.map((r) => ({ ...r })), message: a.message ?? "" };
};

/** A saved rule as the builder edits it. */
export function draftFromRule(rule) {
  return {
    name: rule.name ?? "",
    description: rule.description ?? "",
    trigger: rule.trigger ?? "",
    ...conditionsToDraft(rule.conditions),
    actions: (rule.actions ?? []).map(actionToDraft),
  };
}

const cleanValue = (c) => {
  if (!needsValue(c.op)) return undefined;
  if (isListOp(c.op)) return (Array.isArray(c.value) ? c.value : String(c.value ?? "").split(",")).map((v) => String(v).trim()).filter(Boolean);
  const v = Array.isArray(c.value) ? c.value[0] : c.value;
  return v === undefined || v === null ? "" : String(v).trim();
};

const conditionsContent = (match, list) => {
  const conditions = list.map((c) => {
    const value = cleanValue(c);
    return value === undefined ? { field: c.field, op: c.op } : { field: c.field, op: c.op, value };
  });
  return match === "any" ? { any: conditions } : { all: conditions };
};

const actionContent = (a) => {
  if (a.type === "task") {
    const out = { type: "task", assignee: a.assignee, title: a.title.trim() };
    if (a.detail?.trim()) out.detail = a.detail.trim();
    if (a.dueDays !== "" && a.dueDays !== null && a.dueDays !== undefined) out.dueDays = Number(a.dueDays);
    return out;
  }
  if (a.type === "hold_lot") return { type: "hold_lot", reason: a.reason.trim() };
  if (a.type === "later") return { type: "later", afterDays: Number(a.afterDays), conditions: conditionsContent(a.match, a.conditions), actions: a.actions.map(actionContent) };
  return { type: "notify", recipients: a.recipients, message: a.message.trim() };
};

/** What the API takes: trigger, conditions, actions (name and description added by the caller). */
export function ruleContent(draft) {
  return { trigger: draft.trigger, conditions: conditionsContent(draft.match, draft.conditions), actions: draft.actions.map(actionContent) };
}

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
/** Whether what the rule does (trigger, conditions, actions) differs from the saved rule — only then is a reason needed. */
export const contentChanged = (draft, rule) => {
  if (!rule) return true;
  const saved = ruleContent(draftFromRule(rule));
  return JSON.stringify(sortKeys(ruleContent(draft))) !== JSON.stringify(sortKeys(saved));
};

/** What is still needed before the rule can be saved or tested (empty = fine). */
const conditionProblems = (list, trigger, where) =>
  list.flatMap((c, i) => {
    const field = trigger.fields.find((f) => f.key === c.field);
    if (!field) return [`${where}condition ${i + 1}: choose what to test`];
    if (!needsValue(c.op)) return [];
    const v = cleanValue(c);
    return (Array.isArray(v) ? v.length === 0 : !v) ? [`${where}condition ${i + 1}: say what ${field.label.toLowerCase()} to compare with`] : [];
  });

const actionProblems = (a, n, trigger) => {
  const problems = [];
  if (a.type === "notify") {
    if (!a.message.trim()) problems.push(`${n}: write the message`);
    if (!a.recipients.length) problems.push(`${n}: say who is told`);
    a.recipients.forEach((r) => {
      if ((r.kind === "person" && !r.userId) || (r.kind === "role" && !r.roleId) || (r.kind === "department" && !r.departmentId)) problems.push(`${n}: choose who`);
    });
  } else if (a.type === "task") {
    if (!a.title.trim()) problems.push(`${n}: give the task a title`);
    if (a.assignee.kind === "person" && !a.assignee.userId) problems.push(`${n}: choose who gets the task`);
    if (a.dueDays !== "" && a.dueDays !== null && a.dueDays !== undefined && !(Number.isInteger(Number(a.dueDays)) && Number(a.dueDays) >= 0 && Number(a.dueDays) <= 365))
      problems.push(`${n}: due in 0 to 365 days`);
  } else if (a.type === "hold_lot") {
    if (!canHoldLot(trigger)) problems.push(`${n}: “${trigger.label}” names no lot to hold`);
    if (a.reason.trim().length < 3) problems.push(`${n}: say why the lot is held`);
  } else if (a.type === "later") {
    const d = Number(a.afterDays);
    if (!(Number.isInteger(d) && d >= 1 && d <= 365)) problems.push(`${n}: wait 1 to 365 days`);
    problems.push(...conditionProblems(a.conditions, trigger, `${n}, `));
    if (!a.actions.length) problems.push(`${n}: say what to do then`);
    a.actions.forEach((inner, j) => problems.push(...actionProblems(inner, `${n}.${j + 1}`, trigger)));
  }
  return problems;
};

/** What is still needed before the rule can be saved or tested (empty = fine). */
export function draftProblems(draft, trigger) {
  const problems = [];
  if (!draft.name.trim()) problems.push("Give the rule a name");
  if (!trigger) {
    problems.push("Choose what starts the rule");
    return problems;
  }
  problems.push(...conditionProblems(draft.conditions, trigger, "").map((p) => p.charAt(0).toUpperCase() + p.slice(1)));
  if (!draft.actions.length) problems.push("Add at least one thing for the rule to do");
  draft.actions.forEach((a, i) => problems.push(...actionProblems(a, `Action ${i + 1}`, trigger)));
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
