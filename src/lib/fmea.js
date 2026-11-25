/** FMEA (docs/fmea-plan.md): labels, colours and small rules shared by the screens. */
import { formatDay } from "./change";

export { formatDay };

export const FMEA_KINDS = [
  { value: "design", label: "Design FMEA", hint: "What could fail in the product or its design" },
  { value: "process", label: "Process FMEA", hint: "What could fail in how it is made, step by step" },
];
export const kindLabel = (kind) => FMEA_KINDS.find((k) => k.value === kind)?.label ?? kind;

const TONE_CLASS = {
  success: "bg-success-color/15 text-success-color",
  warning: "bg-warning-color/15 text-warning-color",
  error: "bg-error-color/15 text-error-color",
  info: "bg-brand-primary/15 text-brand-primary",
  neutral: "bg-secondary-bg text-secondary-text",
};

export const FMEA_STATUS = {
  draft: { label: "Draft", tone: "neutral" },
  active: { label: "In force", tone: "success" },
  withdrawn: { label: "Withdrawn", tone: "error" },
  discarded: { label: "Discarded", tone: "neutral" },
};
export const statusLabel = (status) => FMEA_STATUS[status]?.label ?? status;
export const statusPill = (status) => TONE_CLASS[FMEA_STATUS[status]?.tone ?? "neutral"];

export const REVISION_STATUS = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Waiting for approval", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  effective: { label: "In force", tone: "success" },
  superseded: { label: "Superseded", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "error" },
  discarded: { label: "Discarded", tone: "neutral" },
};
export const revisionStatusLabel = (status) => REVISION_STATUS[status]?.label ?? status;
export const revisionPill = (status) => TONE_CLASS[REVISION_STATUS[status]?.tone ?? "neutral"];

/** "A", or "draft 2" for a revision that has no letter yet. */
export const revisionName = (revision) => (revision.letter ? `rev ${revision.letter}` : `draft ${revision.sequence}`);

/** The register's status choices; "" is the default (drafts and those in force). */
export const STATUS_OPTIONS = [
  { value: "", label: "Live" },
  { value: "draft", label: "Draft" },
  { value: "active", label: "In force" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "all", label: "All" },
];

export const TEAM_ROLES = [
  { value: "lead", label: "Team lead" },
  { value: "design", label: "Design" },
  { value: "process", label: "Process engineering" },
  { value: "quality", label: "Quality" },
  { value: "manufacturing", label: "Manufacturing" },
  { value: "purchasing", label: "Purchasing" },
  { value: "supplier", label: "Supplier" },
  { value: "customer", label: "Customer" },
  { value: "other", label: "Other" },
];
export const roleLabel = (role) => TEAM_ROLES.find((r) => r.value === role)?.label ?? role;

export const LINK_KINDS = [
  { value: "part", label: "Part" },
  { value: "part_family", label: "Part family" },
  { value: "control_plan", label: "Control plan" },
  { value: "machine", label: "Machine" },
  { value: "supplier", label: "Supplier" },
  { value: "customer", label: "Customer" },
  { value: "operation_code", label: "Operation" },
];
export const linkKindLabel = (kind) => LINK_KINDS.find((k) => k.value === kind)?.label ?? kind;

/** The page of a record an FMEA covers, or null when it has none. */
export const linkPath = (link) => {
  if (!link?.readable || !link.id) return null;
  switch (link.kind) {
    case "part":
      return `/Parts/${link.id}`;
    case "part_family":
      return `/Part-Families/${link.id}`;
    case "control_plan":
      return `/Process-Control/Plans/${link.id}`;
    case "machine":
      return "/Machines";
    case "supplier":
      return `/Suppliers/${link.id}`;
    case "customer":
      return "/Customers";
    default:
      return null;
  }
};

/** "BR-100 · Bracket", or a plain word when the reader may not see the record. */
export const linkWords = (link) => {
  if (link.kind === "operation_code") return link.code;
  if (!link.readable) return "a record you cannot open";
  return [link.reference, link.name].filter(Boolean).join(" · ") || "Unnamed";
};
export const sameLink = (a, b) => a.kind === b.kind && (a.kind === "operation_code" ? a.code?.toLowerCase() === b.code?.toLowerCase() : a.id === b.id);
/** The body of PUT /fmea-revisions/{id}/links from the links on screen. */
export const linksBody = (links) => links.map((l) => (l.kind === "operation_code" ? { kind: "operation_code", code: l.code } : { kind: l.kind, id: l.id }));

/** A team member as the picker names them: members and employees are told apart by a prefix. */
export const personValue = (member) => `${member.kind === "employee" ? "e" : "u"}:${member.personId}`;
export const teamBody = (rows) => rows.map((r) => (r.person.startsWith("e:") ? { employeeId: r.person.slice(2), role: r.role } : { userId: r.person.slice(2), role: r.role }));
/** Why a team cannot be saved yet, or null. */
export const teamProblem = (rows) => {
  if (rows.some((r) => !r.person)) return "Choose a person for every row";
  if (new Set(rows.map((r) => r.person)).size !== rows.length) return "A person can be on the team once";
  if (rows.filter((r) => r.role === "lead").length > 1) return "There is one team lead";
  return null;
};

export const fmeaPath = (id) => `/FMEA/${id}`;
export const revisionPath = (fmeaId, revisionId) => `/FMEA/${fmeaId}/revisions/${revisionId}`;

// ---- the analysis (FM3) ---------------------------------------------------------------------------------------

export const ITEM_KINDS = {
  system: "System",
  subsystem: "Sub-system",
  component: "Component",
  item: "Process item",
  step: "Process step",
  element: "Work element",
};
export const itemKindLabel = (kind) => ITEM_KINDS[kind] ?? kind;
/** What may sit directly under an item of each kind (design: system > sub-system > component; process: item > step > work element). */
export const CHILD_KINDS = { system: ["subsystem", "component"], subsystem: ["component"], component: [], item: ["step"], step: ["element"], element: [] };
/** What may be added at the top of an FMEA of a kind. */
export const topKinds = (fmeaKind) => (fmeaKind === "design" ? ["system"] : ["item"]);

export const ELEMENT_TYPES = [
  { value: "man", label: "Man (people)" },
  { value: "machine", label: "Machine" },
  { value: "material", label: "Material" },
  { value: "method", label: "Method" },
  { value: "measurement", label: "Measurement" },
  { value: "environment", label: "Environment" },
];
export const elementTypeLabel = (type) => ELEMENT_TYPES.find((t) => t.value === type)?.label ?? type;

export const EFFECT_LEVELS = [
  { value: "own_plant", label: "Our own plant" },
  { value: "next_plant", label: "The next plant or the customer" },
  { value: "end_user", label: "The end user" },
];
export const effectLevelLabel = (level) => EFFECT_LEVELS.find((l) => l.value === level)?.label ?? level;

export const SPECIAL_CLASSES = [
  { value: "critical", label: "Critical" },
  { value: "significant", label: "Significant" },
];
export const specialClassLabel = (value) => SPECIAL_CLASSES.find((c) => c.value === value)?.label ?? value;

export const PRIORITY = {
  high: { label: "High", tone: "error" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "success" },
};
export const priorityLabel = (priority) => PRIORITY[priority]?.label ?? "Not rated";
export const priorityPill = (priority) => TONE_CLASS[PRIORITY[priority]?.tone ?? "neutral"];

/** Choices for a 1 to 10 rating from a scale of ten `{ label, criteria? }`: "7 · High", with the criteria as the hint. */
export const ratingOptions = (levels = []) => levels.map((l, i) => ({ value: String(i + 1), label: `${i + 1} · ${l.label}`, hint: l.criteria }));
/** "7 · High" for a rating on a scale, or a dash when it is not rated. */
export const ratingWords = (levels, n) => (n == null ? "—" : `${n}${levels?.[n - 1]?.label ? ` · ${levels[n - 1].label}` : ""}`);
export const toLevel = (value) => (value === "" || value == null ? null : Number(value));

/** What the model says about a rating, in a sentence: "RPN: high from 200, medium from 100; severity 9 or more always needs attention". */
export const modelWords = (model) =>
  model.method === "ap"
    ? `Action priority grid; severity ${model.severityFloor} or more always needs attention`
    : `RPN: high from ${model.rpnHighFrom}, medium from ${model.rpnMediumFrom}; severity ${model.severityFloor} or more always needs attention`;

/** The worst severity among a failure mode's effects, or null when none is rated. */
export const worstSeverity = (effects) => effects.reduce((m, e) => (e.severity != null && (m == null || e.severity > m) ? e.severity : m), null);

// ---- actions, comparing and the review (FM4) ---------------------------------------------------------------------

export const ACTION_KINDS = [
  { value: "prevention", label: "Prevention", hint: "Stops the cause from happening (lowers occurrence)" },
  { value: "detection", label: "Detection", hint: "Catches the cause or the failure sooner (lowers detection)" },
];
export const actionKindLabel = (kind) => ACTION_KINDS.find((k) => k.value === kind)?.label ?? kind;

export const ACTION_STATUS = {
  open: { label: "Open", tone: "info" },
  done: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export const actionStatusLabel = (status) => ACTION_STATUS[status]?.label ?? status;
export const actionStatusPill = (status) => TONE_CLASS[ACTION_STATUS[status]?.tone ?? "neutral"];

/** "Due 12 Jan 2026", or "Late: was due 12 Jan 2026" while it is open and past. */
export const dueWords = (action) => (action.overdue ? `Late: was due ${formatDay(action.dueOn)}` : `Due ${formatDay(action.dueOn)}`);

/** What a finished action says it comes to: "O 8 → 3 · RPN 192 · Medium", or just the findings when no ratings were given. */
export const revisedWords = (action, cause) => {
  const parts = [];
  if (action.revisedOccurrence != null) parts.push(`O ${cause?.occurrence ?? "?"} → ${action.revisedOccurrence}`);
  if (action.revisedDetection != null) parts.push(`D ${cause?.detection ?? "?"} → ${action.revisedDetection}`);
  if (action.revisedRpn != null) parts.push(`RPN ${action.revisedRpn}`, priorityLabel(action.revisedPriority));
  return parts.join(" · ");
};

/** The person an action is given to, as a combo value: "u:<id>" for a member, "e:<id>" for an employee. */
export const actionOwnerValue = (owner) => (owner ? `${owner.kind === "employee" ? "e" : "u"}:${owner.id}` : "");
export const actionOwnerBody = (value) => (value.startsWith("e:") ? { ownerEmployeeId: value.slice(2) } : { ownerUserId: value.slice(2) });

/** The names the comparison uses for the fields a row can have. */
export const FIELD_LABELS = {
  name: "Name", elementType: "Type of work element", description: "Description", operationCode: "Operation code",
  text: "Wording", requirement: "Requirement", characteristicKey: "Characteristic key", specialClass: "Special characteristic", ncFailureMode: "Register failure mode",
  level: "Who sees it", severity: "Severity", preventionControls: "Prevention controls", detectionControls: "Detection controls",
  occurrence: "Occurrence", detection: "Detection", severityUsed: "Severity used", rpn: "RPN", priority: "Priority", noActionReason: "Why nothing more is done",
};
export const fieldLabel = (field) => FIELD_LABELS[field] ?? field;
const KIND_WORDS = { item: "Structure", function: "Function", failure_mode: "Failure mode", effect: "Effect", cause: "Cause" };
export const compareKindLabel = (kind) => KIND_WORDS[kind] ?? kind;
/** A value as it reads in a comparison: a dash for none, the choices in words. */
export const compareValue = (field, value) => {
  if (value == null || value === "") return "—";
  if (field === "priority") return priorityLabel(value);
  if (field === "level") return effectLevelLabel(value);
  if (field === "elementType") return elementTypeLabel(value);
  if (field === "specialClass") return specialClassLabel(value);
  return String(value);
};

export const REVIEW_OUTCOME = { no_change: "No change needed", revision_started: "A revision was started" };

// ---- controls carried to the control plan (FM5a) -----------------------------------------------------------------

export const CONTROL_KINDS = [
  { value: "prevention", label: "Prevention control" },
  { value: "detection", label: "Detection control" },
];
export const controlKindLabel = (kind) => CONTROL_KINDS.find((k) => k.value === kind)?.label ?? kind;

/** Where a carried control stands against the control plan now. */
export const LINK_STATE = {
  in_plan: { label: "In the plan in force", tone: "success" },
  not_in_force: { label: "Only on a draft of the plan", tone: "warning" },
  missing: { label: "No longer in the plan", tone: "error" },
  unknown: { label: "Not checked", tone: "neutral" },
};
export const linkStateLabel = (state) => LINK_STATE[state]?.label ?? state;
export const linkStatePill = (state) => TONE_CLASS[LINK_STATE[state]?.tone ?? "neutral"];

/** Whether the causes that need attention are covered by the control plan. */
export const COVERAGE_STATUS = {
  covered: { label: "Covered", tone: "success" },
  unverified: { label: "Not checked", tone: "neutral" },
  link_problem: { label: "Link needs attention", tone: "warning" },
  not_covered: { label: "Not covered", tone: "error" },
};
export const coverageLabel = (status) => COVERAGE_STATUS[status]?.label ?? status;
export const coveragePill = (status) => TONE_CLASS[COVERAGE_STATUS[status]?.tone ?? "neutral"];

/** "FL-CP1 · OP-020 · OD (Outer diameter)": a plan characteristic in a line. */
export const planTargetWords = (t) => `${t.plan?.code ?? "A control plan"} · ${t.operationCode} · ${t.characteristicKey}${t.characteristicName ? ` (${t.characteristicName})` : ""}`;

/** The choices for carrying a control: every characteristic the server offered, "FL-CP1 · OP-020 · OD (Outer diameter)", with where it stands as the hint. */
export const planCharacteristicOptions = (items = []) =>
  items.map((c) => ({
    value: `${c.plan.id}|${c.operationCode}|${c.characteristicKey}`,
    label: `${c.plan.code} · ${c.operationCode} · ${c.characteristicKey} (${c.name})`,
    hint: `${c.inForce ? "In force" : `Revision ${c.revisionCode} not in force yet`} · ${c.criticality}`,
  }));

/** The two controls a cause can carry (only the ones it holds), as choices. */
export const carriableKinds = (cause) => CONTROL_KINDS.filter((k) => (k.value === "prevention" ? cause.preventionControls : cause.detectionControls));

/** Occurrence evidence (the living FMEA): what the non-conformance register says about each failure mode. */
export const EVIDENCE_FLAG = {
  untied: { label: "Not tied to the register", pill: "bg-secondary-bg text-secondary-text" },
  none_seen: { label: "None raised", pill: "bg-success-color/15 text-success-color" },
  seen: { label: "Raised", pill: "bg-warning-color/15 text-warning-color" },
  seen_but_rated_low: { label: "Look again at the occurrence", pill: "bg-error-color/15 text-error-color" },
};
export const evidenceFlagLabel = (flag) => EVIDENCE_FLAG[flag]?.label ?? flag;
export const evidenceFlagPill = (flag) => EVIDENCE_FLAG[flag]?.pill ?? "";

/** "3 non-conformances in the last year on this FMEA's scope (4 in all)" */
export const evidenceCountWords = (mode, days = 365) => {
  if (!mode.tied) return "Tie it to a failure mode of the register to see what has happened.";
  const n = mode.count ?? 0;
  const period = days === 365 ? "the last year" : `the last ${days} days`;
  const base = `${n} non-conformance${n === 1 ? "" : "s"} in ${period}`;
  return mode.inScope != null && mode.total != null && mode.total !== mode.inScope ? `${base} on this FMEA's scope (${mode.total} in all)` : base;
};

/** The failure mode choices of the register for a combo, keeping one that has since been switched off so it still shows. */
export const registerModeOptions = (modes = [], current) => {
  const options = modes.map((m) => ({ value: m.id, label: m.name }));
  return current && !options.some((o) => o.value === current.id) ? [...options, { value: current.id, label: `${current.name} (switched off)` }] : options;
};

const VIA_WORDS = { part: "this part", part_family: "its part family", machine: "this machine", control_plan: "this control plan" };
/** "covers this part and its part family" */
export const viaWords = (via = []) => via.map((v) => VIA_WORDS[v] ?? v).join(" and ");
export const FMEA_THING = { part: "part", part_family: "part family", machine: "machine", control_plan: "control plan" };
