/** Shared definitions for the CAPA / 8D module (docs/capa-8d-plan.md). */

/** The eight disciplines and D0: what each step is for, in plain words. */
export const STEPS = [
  { key: "d0", code: "D0", label: "Initiate", title: "Initiate the 8D", help: "Say what the problem is and which non-conformances this 8D addresses. This is the record everyone will read first." },
  { key: "d1", code: "D1", label: "Team", title: "Form the team", help: "Name a leader and a champion, and the people who know the process. Add outside contacts such as a supplier or customer representative." },
  { key: "d2", code: "D2", label: "Problem", title: "Describe the problem", help: "Describe the problem precisely with 5W2H, and compare where it happens with where it does not." },
  { key: "d3", code: "D3", label: "Containment", title: "Interim containment", help: "Protect the customer now: sort, quarantine, 100% inspect. These actions stay until a permanent fix is proven." },
  { key: "d4", code: "D4", label: "Root cause", title: "Find the root cause", help: "Find why the problem occurred and why it escaped detection, with the Ishikawa diagram and 5 Whys. Verify every cause before acting on it." },
  { key: "d5", code: "D5", label: "Corrective actions", title: "Choose permanent corrective actions", help: "Choose actions that remove each verified root cause, with an owner and a due date." },
  { key: "d6", code: "D6", label: "Implement", title: "Implement and validate", help: "Carry out the actions, keep the evidence, and verify that the fix works." },
  { key: "d7", code: "D7", label: "Prevent", title: "Prevent recurrence", help: "Update the systems that let this happen (procedures, control plans, FMEA) and check similar parts and processes." },
  { key: "d8", code: "D8", label: "Close", title: "Close and recognise the team", help: "Sign the 8D off and recognise the team's work." },
];
export const stepOf = (key) => STEPS.find((s) => s.key === key) ?? STEPS[0];
export const stepIndex = (key) => STEPS.findIndex((s) => s.key === key);

export const STAGES = [
  { key: "open", label: "Open", tone: "bg-info-color/15 text-info-color" },
  { key: "actions_in_progress", label: "Actions in progress", tone: "bg-theme/15 text-theme" },
  { key: "awaiting_verification", label: "Awaiting verification", tone: "bg-warning-color/20 text-primary-text" },
  { key: "verified_effective", label: "Verified effective", tone: "bg-success-color/15 text-success-color" },
  { key: "closed", label: "Closed", tone: "bg-success-color/15 text-success-color" },
  { key: "cancelled", label: "Cancelled", tone: "bg-border-color text-secondary-text line-through" },
];
export const stageOf = (key) => STAGES.find((s) => s.key === key) ?? STAGES[0];
export const isRunning = (stage) => stage !== "closed" && stage !== "cancelled";

export const SOURCES = [
  { id: "internal", name: "Internal" },
  { id: "customer", name: "Customer" },
  { id: "supplier", name: "Supplier" },
];
export const SEVERITIES = [
  { id: "critical", name: "Critical" },
  { id: "major", name: "Major" },
  { id: "minor", name: "Minor" },
];
export const TEAM_ROLES = {
  leader: { label: "Leader", hint: "Runs the 8D" },
  champion: { label: "Champion", hint: "Sponsor who removes obstacles" },
  member: { label: "Member", hint: "Knows the process" },
  supplier_contact: { label: "Supplier contact", hint: "Outside contact" },
  customer_contact: { label: "Customer contact", hint: "Outside contact" },
};
export const roleLabel = (role) => TEAM_ROLES[role]?.label ?? role;

const NC_TYPE = { internal: "Internal", customer: "Customer", supplier: "Supplier", inspection: "Internal" };
/** Where a linked non-conformance lives in the app. */
export const ncrHref = (ncr) => `/Non-Conformance/${NC_TYPE[ncr.source] ?? "Internal"}/${ncr.nonconformanceId ?? ncr.id}`;

/** The step page to open for an 8D: its current step. */
export const capaHref = (capa, step) => `/CAPA/${capa.id}/${step ?? capa.currentStep ?? "d0"}`;

/** D2: the seven questions of 5W2H, in the order they are asked. `required` ones are needed to complete D2. */
export const FIVE_W2H = [
  { key: "what", label: "What", prompt: "What is wrong? What is the defect, failure or complaint?", required: true },
  { key: "where", label: "Where", prompt: "Where was it found: site, line, machine, customer?", required: true },
  { key: "when", label: "When", prompt: "When was it found, and when did it start?", required: true },
  { key: "who", label: "Who", prompt: "Who found it, and who is involved or affected?" },
  { key: "why", label: "Why it matters", prompt: "Why is it a problem? What is the impact on the customer or the business?" },
  { key: "how", label: "How", prompt: "How was it found or detected?" },
  { key: "howMany", label: "How many", prompt: "How many parts, batches or customers are affected?" },
];

/** D2: the Is / Is-Not comparison. Each row is one question; what it IS, what it IS NOT, what is distinctive, what changed. */
export const IS_IS_NOT_ROWS = [
  { key: "what_object", dimension: "what", question: "Which part, product or process has the problem?" },
  { key: "what_defect", dimension: "what", question: "What is the defect or failure?" },
  { key: "where_place", dimension: "where", question: "Where is it found: site, line, machine?" },
  { key: "where_on", dimension: "where", question: "Where on the part or in the process?" },
  { key: "when_first", dimension: "when", question: "When was it first seen?" },
  { key: "when_pattern", dimension: "when", question: "When does it happen: shift, time of day, batch?" },
  { key: "extent_size", dimension: "extent", question: "How many are affected?" },
  { key: "extent_trend", dimension: "extent", question: "Is it getting better, worse or staying the same?" },
];
export const DIMENSIONS = { what: "What", where: "Where", when: "When", extent: "How big" };

export const ACTION_STATUS = {
  open: { label: "Open", tone: "bg-info-color/15 text-info-color" },
  done: { label: "Done", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text line-through" },
};

/** D4: the three kinds of root cause. */
export const ROOT_CAUSE_KINDS = {
  occurrence: { label: "Occurrence", help: "Why the problem happened", tone: "bg-error-color/10 text-error-color" },
  escape: { label: "Escape", help: "Why it was not detected before it reached the customer", tone: "bg-warning-color/20 text-primary-text" },
  systemic: { label: "Systemic", help: "Why the system allowed it: procedures, plans, training", tone: "bg-theme/15 text-theme" },
};
export const ROOT_CAUSE_OPTIONS = Object.entries(ROOT_CAUSE_KINDS).map(([id, k]) => ({ id, name: k.label, hint: k.help }));

/** D4: the six standard Ishikawa categories, top row then bottom row. */
export const ISHIKAWA_CATEGORIES = [
  { key: "man", label: "Man", hint: "People, skills, training" },
  { key: "machine", label: "Machine", hint: "Equipment, tooling, maintenance" },
  { key: "material", label: "Material", hint: "Raw material, components, supplier" },
  { key: "method", label: "Method", hint: "Process, procedure, instructions" },
  { key: "measurement", label: "Measurement", hint: "Gauges, inspection, data" },
  { key: "environment", label: "Environment", hint: "Temperature, cleanliness, layout" },
];
