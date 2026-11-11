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
