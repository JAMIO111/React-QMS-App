import { csvLine } from "./reportCsv";
import { actionStatusLabel, effectLevelLabel, formatDay, kindLabel, linkWords, priorityLabel, revisionName, roleLabel, specialClassLabel } from "./fmea";

/**
 * The FMEA form sheet and its CSV (docs/fmea-plan.md FM6): the analysis of one revision laid out as one row for each cause, in the order of the net, the way a
 * paper FMEA form reads. Nothing is worked out here: every figure is the one the database stored and the API sent; this only lays them out.
 * A failure mode with no cause still has a row (its causes are missing, and the sheet should show that), and so has a function with no failure mode.
 */

/** Writes the actions on a cause as one line each: "Change the tool — Ada — due 1 Dec 2026 — open". */
export const actionLine = (action) =>
  [`${action.kind === "detection" ? "Detection" : "Prevention"}: ${action.description}`, action.owner?.name, `due ${formatDay(action.dueOn)}`, actionStatusLabel(action.status) + (action.status === "done" && action.doneAt ? ` ${formatDay(action.doneAt.slice(0, 10))}` : "")]
    .filter(Boolean)
    .join(" — ");

/** What the actions that were finished say the ratings now come to: the latest finished action with revised figures, or null. */
export const revisedOf = (actions) => {
  const done = (actions ?? []).filter((a) => a.status === "done" && a.revisedRpn != null);
  if (done.length === 0) return null;
  const last = [...done].sort((a, b) => String(a.doneAt ?? "").localeCompare(String(b.doneAt ?? ""))).at(-1);
  return { occurrence: last.revisedOccurrence, detection: last.revisedDetection, rpn: last.revisedRpn, priority: last.revisedPriority };
};

/** The effects of a failure mode as lines: "End user: Leaks (S 8)". */
export const effectLines = (effects) => (effects ?? []).map((e) => `${effectLevelLabel(e.level)}: ${e.text}${e.severity == null ? "" : ` (S ${e.severity})`}`);

/**
 * Every row of the form, with how many rows the function and the failure mode span (`fnSpan`, `modeSpan`, set on the first row of each, 0 on the rest) so a printed
 * table can merge those cells.
 */
export const formRows = (net) => {
  const rows = [];
  const walk = (node, path) => {
    const here = [...path, node.name];
    for (const fn of node.functions ?? []) {
      const start = rows.length;
      if ((fn.failureModes ?? []).length === 0) {
        rows.push({ path: here, node, fn, mode: null, cause: null, fnSpan: 0, modeSpan: 0 });
      }
      for (const mode of fn.failureModes ?? []) {
        const modeStart = rows.length;
        const causes = mode.causes ?? [];
        if (causes.length === 0) rows.push({ path: here, node, fn, mode, cause: null, fnSpan: 0, modeSpan: 0 });
        for (const cause of causes) rows.push({ path: here, node, fn, mode, cause, fnSpan: 0, modeSpan: 0 });
        rows[modeStart].modeSpan = rows.length - modeStart;
      }
      rows[start].fnSpan = rows.length - start;
    }
    for (const child of node.children ?? []) walk(child, here);
  };
  for (const root of net?.items ?? []) walk(root, []);
  return rows;
};

/** The columns of the CSV and of the sheet, in the order of a paper form. `value(row)` gives plain text. */
export const FORM_COLUMNS = [
  { key: "path", label: "Item / step / element", value: (r) => r.path.join(" › ") },
  { key: "operation", label: "Operation", value: (r) => r.node.operationCode ?? "" },
  { key: "function", label: "Function", value: (r) => r.fn.text },
  { key: "requirement", label: "Requirement", value: (r) => r.fn.requirement ?? "" },
  { key: "mode", label: "Failure mode", value: (r) => r.mode?.text ?? "" },
  { key: "special", label: "Special class", value: (r) => (r.mode?.specialClass ? specialClassLabel(r.mode.specialClass) : "") },
  { key: "effects", label: "Effects", value: (r) => effectLines(r.mode?.effects).join("; ") },
  { key: "severity", label: "S", value: (r) => r.cause?.severityUsed ?? "" },
  { key: "cause", label: "Cause", value: (r) => r.cause?.text ?? "" },
  { key: "prevention", label: "Prevention controls", value: (r) => r.cause?.preventionControls ?? "" },
  { key: "occurrence", label: "O", value: (r) => r.cause?.occurrence ?? "" },
  { key: "detectionControls", label: "Detection controls", value: (r) => r.cause?.detectionControls ?? "" },
  { key: "detection", label: "D", value: (r) => r.cause?.detection ?? "" },
  { key: "rpn", label: "RPN", value: (r) => r.cause?.rpn ?? "" },
  { key: "priority", label: "Priority", value: (r) => (r.cause?.priority ? priorityLabel(r.cause.priority) : "") },
  { key: "attention", label: "Needs attention", value: (r) => (r.cause?.needsAttention == null ? "" : r.cause.needsAttention ? "Yes" : "No") },
  { key: "noAction", label: "Why nothing more is done", value: (r) => r.cause?.noActionReason ?? "" },
  { key: "actions", label: "Actions", value: (r) => (r.cause?.actions ?? []).filter((a) => a.status !== "cancelled").map(actionLine).join("; ") },
  { key: "revisedO", label: "Revised O", value: (r) => revisedOf(r.cause?.actions)?.occurrence ?? "" },
  { key: "revisedD", label: "Revised D", value: (r) => revisedOf(r.cause?.actions)?.detection ?? "" },
  { key: "revisedRpn", label: "Revised RPN", value: (r) => revisedOf(r.cause?.actions)?.rpn ?? "" },
  { key: "revisedPriority", label: "Revised priority", value: (r) => (revisedOf(r.cause?.actions)?.priority ? priorityLabel(revisedOf(r.cause.actions).priority) : "") },
];

/** The facts above the table, as `[label, text]` pairs: what it is, what it covers, who made it, what it was rated with. */
export const formFacts = (revision) =>
  [
    ["FMEA", `${revision.fmea.number} ${revisionName(revision)}`],
    ["Title", revision.fmea.title],
    ["Kind", kindLabel(revision.fmea.kind)],
    ["Status", revision.status],
    revision.effectiveFrom ? ["In force from", formatDay(revision.effectiveFrom)] : null,
    revision.fmea.scopeText ? ["Scope", revision.fmea.scopeText] : null,
    (revision.links ?? []).length ? ["Covers", revision.links.map(linkWords).join("; ")] : null,
    (revision.team ?? []).length ? ["Team", revision.team.map((m) => `${m.name} (${roleLabel(m.role)})`).join("; ")] : null,
    revision.approver ? ["Approver", revision.approver.name] : null,
    revision.model ? ["Rated with", `rating model version ${revision.model.version}: ${revision.model.method === "ap" ? "action priority grid" : `RPN, high from ${revision.model.rpnHighFrom}, medium from ${revision.model.rpnMediumFrom}`}; severity ${revision.model.severityFloor} or more always needs attention`] : null,
    revision.changeSummary ? ["What changed", revision.changeSummary] : null,
  ].filter(Boolean);

/** The CSV text: first what it is and when it was made, then the table. The preamble is on purpose: a form read later must say what it is. */
export const formCsv = (revision, generatedAt = new Date().toISOString()) => {
  const rows = formRows(revision.net);
  const out = [
    csvLine(["Report", `FMEA form: ${revision.fmea.number} ${revisionName(revision)}`]),
    csvLine(["Generated (UTC)", generatedAt]),
    csvLine(["Rows", rows.length]),
    ...formFacts(revision).map(([label, text]) => csvLine([label, text])),
    csvLine(["Definition", "One row for each cause; S is the worst severity among the failure mode's effects; RPN is S × O × D as the rating model works it out; priority and needs attention come from the same model"]),
    csvLine(["Definition", "A failure mode with no cause, or a function with no failure mode, has a row of its own: the analysis is not finished there"]),
    "",
    csvLine(FORM_COLUMNS.map((c) => c.label)),
    ...rows.map((r) => csvLine(FORM_COLUMNS.map((c) => c.value(r)))),
  ];
  return out.join("\r\n") + "\r\n";
};

export const formFilename = (revision) => `${revision.fmea.number}-${revisionName(revision).replace(/\s+/g, "-")}.csv`;

/** Hands the CSV to the browser as a download. */
export const downloadForm = (revision) => {
  const blob = new Blob([formCsv(revision)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = formFilename(revision);
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

