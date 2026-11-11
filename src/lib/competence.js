/** Competence (docs/competence-plan.md): the fixed 0–4 scale and small helpers for skills and positions. */
export const LEVELS = [
  { value: 0, label: "None", hint: "No experience" },
  { value: 1, label: "Learning", hint: "Being taught; not yet working alone" },
  { value: 2, label: "Supervised", hint: "Works with supervision" },
  { value: 3, label: "Competent", hint: "Works unsupervised to the standard" },
  { value: 4, label: "Can train others", hint: "Competent and able to teach and assess" },
];

export const levelLabel = (value) => (value === null || value === undefined || value === "" ? "—" : (LEVELS.find((l) => l.value === Number(value))?.label ?? "—"));

/** Levels a position can require (a requirement of 0 means nothing, so 1 to 4). */
export const REQUIRED_LEVELS = LEVELS.filter((l) => l.value >= 1);

/** "Every 12 months", "Every month", or "No refresh" for a skill's refresh interval. */
export const refreshLabel = (months) => {
  if (!months) return "No refresh";
  if (months === 1) return "Every month";
  if (months % 12 === 0) return months === 12 ? "Every year" : `Every ${months / 12} years`;
  return `Every ${months} months`;
};

/** Skills grouped by category label, in the order given, for the lists. */
export const groupByCategory = (skills) => {
  const groups = new Map();
  for (const s of skills) {
    const label = s.category?.label ?? s.category ?? "Other";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(s);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
};

/** What a position requires, in one line: "CMM operation 3, Visual inspection 2". */
export const requirementSummary = (position) =>
  position.skills.length === 0 ? "Requires no skills yet" : position.skills.map((s) => `${s.name} ${s.requiredLevel}`).join(", ");

/** How a skill stands for a person (worked out by the server). Tones are the app's: success / warning / error / neutral. */
export const STATUS = {
  ok: { label: "On track", tone: "success" },
  gap: { label: "Below required", tone: "error" },
  not_assessed: { label: "Not assessed", tone: "warning" },
  expired: { label: "Assessment expired", tone: "error" },
  expiring: { label: "Expiring soon", tone: "warning" },
  extra: { label: "Not required", tone: "neutral" },
};
export const statusLabel = (status) => STATUS[status]?.label ?? "—";

/** Tailwind classes for a status pill / matrix cell (tint plus the matching text colour, which the light-mode overrides in index.css rely on). */
export const STATUS_CLASS = {
  success: "bg-success-color/15 text-success-color",
  warning: "bg-warning-color/15 text-warning-color",
  error: "bg-error-color/15 text-error-color",
  neutral: "bg-secondary-bg text-secondary-text",
};
export const statusClass = (status) => STATUS_CLASS[STATUS[status]?.tone ?? "neutral"];

/** A matrix cell in words: "Level 2 of 3 needed, expires 2027-01-05". */
export const describeCell = (cell) => {
  if (!cell) return "";
  const parts = [];
  parts.push(cell.level === null ? "Not assessed" : `${levelLabel(cell.level)} (${cell.level})`);
  if (cell.required !== null) parts.push(`needs ${cell.required}`);
  if (cell.expiresOn) parts.push(`${cell.expiry === "expired" ? "expired" : "expires"} ${cell.expiresOn}`);
  return parts.join(" · ");
};

/** Matrix status filter choices. */
export const MATRIX_STATUS_OPTIONS = [
  { value: "all", label: "Everyone" },
  { value: "attention", label: "Needs attention" },
  { value: "gap", label: "Gaps" },
  { value: "expiring", label: "Expiring" },
  { value: "expired", label: "Expired" },
];

/** Training sessions: kinds, states and the words for them. */
export const SESSION_KINDS = [
  { value: "course", label: "Course" },
  { value: "on_the_job", label: "On the job" },
  { value: "external", label: "External" },
  { value: "induction", label: "Induction" },
  { value: "other", label: "Other" },
];
export const kindLabel = (kind) => SESSION_KINDS.find((k) => k.value === kind)?.label ?? kind;

export const SESSION_STATUS = {
  open: { label: "Open", tone: "warning" },
  closed: { label: "Closed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export const ATTENDEE_STATUS = {
  enrolled: { label: "Enrolled", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  absent: { label: "Did not attend", tone: "neutral" },
  removed: { label: "Removed", tone: "neutral" },
  voided: { label: "Voided", tone: "neutral" },
};
export const sessionStatusLabel = (s) => SESSION_STATUS[s]?.label ?? s;
export const attendeeStatusLabel = (s) => ATTENDEE_STATUS[s]?.label ?? s;
/** Classes for a status pill from either table above. */
export const pillClass = (table, status) => STATUS_CLASS[table[status]?.tone ?? "neutral"];

/** Who runs a session, in one line: the trainer, or the outside provider. */
export const providerLine = (session) => (session.providerType === "internal" ? (session.trainer?.name ?? "—") : [session.providerName, session.providerContact].filter(Boolean).join(" · ") || "—");

/** "5 Jan 2026" or "5 to 7 Jan 2026" style range of a session, as given (yyyy-MM-dd). */
export const sessionDates = (session) => (session.endsOn && session.endsOn !== session.startsOn ? `${session.startsOn} to ${session.endsOn}` : session.startsOn);

export const SESSION_STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
];

/** What is still to do on a session, in words, for the page's notice. */
export const sessionNextStep = (session) => {
  if (session.status === "cancelled") return null;
  if (session.status === "closed") return "This session is closed. Reopen it to change who attended.";
  if (session.enrolledCount > 0) return `${session.enrolledCount} ${session.enrolledCount === 1 ? "person is" : "people are"} still enrolled. Record a result or remove them, then close the session.`;
  if (session.attendeeCount === 0) return "No one is on this session yet.";
  return "Everyone has a result. Close the session when you are done.";
};

/**
 * The matrix as a report for `downloadReport` (lib/reportCsv.js): one row per person, and per skill the level and how it stands, with what the file means in its first lines.
 * `result` is the matrix answer (skills, data, today); `statusFilter` and `today` say what it was made with.
 */
export const matrixReport = (result, { statusFilter = "all", today } = {}) => {
  const on = today ?? result.today;
  const columns = [
    { key: "name", label: "Person" },
    { key: "number", label: "Employee number" },
    { key: "department", label: "Department" },
    { key: "positions", label: "Positions" },
    ...result.skills.flatMap((s) => [
      { key: `l_${s.id}`, label: `${s.name} — level` },
      { key: `r_${s.id}`, label: `${s.name} — needs` },
      { key: `s_${s.id}`, label: `${s.name} — standing` },
      { key: `e_${s.id}`, label: `${s.name} — expires` },
    ]),
  ];
  const rows = result.data.map((r) => {
    const row = { name: r.employee.name, number: r.employee.employeeNumber ?? "", department: r.employee.department?.name ?? "", positions: r.positions.map((p) => p.name).join("; ") };
    for (const s of result.skills) {
      const c = r.cells[s.id];
      row[`l_${s.id}`] = c.level === null ? "" : c.level;
      row[`r_${s.id}`] = c.required === null ? "" : c.required;
      row[`s_${s.id}`] = statusLabel(c.status);
      row[`e_${s.id}`] = c.expiresOn ?? "";
    }
    return row;
  });
  return {
    meta: {
      title: "Skills matrix",
      from: on,
      to: on,
      generatedAt: new Date().toISOString(),
      rowCount: rows.length,
      basis: [
        { label: "As at", value: on },
        { label: "People shown", value: statusFilter === "all" ? "Every active person matching the filters" : `Only those with: ${MATRIX_STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label ?? statusFilter}` },
      ],
      definitions: [
        "Level: 0 none, 1 learning, 2 supervised, 3 competent, 4 can train others; empty means not assessed.",
        "Needs: the highest level required by the positions the person holds now; empty means nothing requires it.",
        "Standing: Below required, Not assessed (required), Assessment expired, Expiring soon (within 60 days), On track, Not required.",
        "Expiry never lowers a level: an expired assessment is flagged, not changed.",
      ],
    },
    columns,
    rows,
  };
};
