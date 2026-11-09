/**
 * Comparing two versions of an audit (docs/audits-versions-dashboard-plan.md). Pure functions, no database: the service loads the versions and these say what changed.
 *
 * Questions are matched by their wording first (the same question that moved or had a field changed), then, among those left, by position (a question reworded in place).
 * Whatever is left over on one side was added or removed.
 */
export type VQuestion = {
  sequence: number;
  question: string;
  guidance: string | null;
  answerType: string;
  passAnswer: string | null;
  unit: string | null;
  lowerLimit: number | null;
  upperLimit: number | null;
  nominal: number | null;
  options: { label: string; passes: boolean }[] | null;
  ratingMax: number | null;
  passRating: number | null;
  critical: boolean;
};
export type VTarget = { kind: 'machine' | 'operation' | 'department' | 'supplier'; ref: string; label: string };
export type VContent = { title: string; auditType: string; purpose: string | null; procedure: string | null; passMark: number; questions: VQuestion[]; targets: VTarget[] };

export const HEADER_FIELDS = ['title', 'auditType', 'purpose', 'procedure', 'passMark'] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];
export const QUESTION_FIELDS = ['question', 'guidance', 'answerType', 'passAnswer', 'unit', 'lowerLimit', 'upperLimit', 'nominal', 'options', 'ratingMax', 'passRating', 'critical'] as const;

export type Changes = {
  header: { field: HeaderField; before: string | number | null; after: string | number | null }[];
  questions: {
    added: VQuestion[];
    removed: VQuestion[];
    changed: { before: VQuestion; after: VQuestion; fields: string[] }[];
    moved: { question: string; from: number; to: number }[];
  };
  targets: { added: VTarget[]; removed: VTarget[] };
  /** A few plain sentences, for the history list. */
  summary: string[];
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const norm = (s: string) => s.trim();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const HEADER_LABEL: Record<HeaderField, string> = { title: 'Title', auditType: 'Type', purpose: 'Purpose', procedure: 'Procedure', passMark: 'Pass mark' };

export function diffVersions(before: VContent, after: VContent): Changes {
  const header: Changes['header'] = [];
  for (const field of HEADER_FIELDS) {
    if (!same(before[field], after[field])) header.push({ field, before: before[field] ?? null, after: after[field] ?? null });
  }

  const unmatchedBefore = [...before.questions].sort((a, b) => a.sequence - b.sequence);
  const unmatchedAfter = [...after.questions].sort((a, b) => a.sequence - b.sequence);
  const changed: Changes['questions']['changed'] = [];
  const moved: Changes['questions']['moved'] = [];
  const compare = (b: VQuestion, a: VQuestion) => {
    const fields = QUESTION_FIELDS.filter((f) => !same(b[f], a[f]));
    if (fields.length) changed.push({ before: b, after: a, fields: [...fields] });
    else if (b.sequence !== a.sequence) moved.push({ question: a.question, from: b.sequence, to: a.sequence });
  };

  // 1. the same wording
  for (const a of [...unmatchedAfter]) {
    const i = unmatchedBefore.findIndex((b) => norm(b.question) === norm(a.question));
    if (i < 0) continue;
    compare(unmatchedBefore[i], a);
    unmatchedBefore.splice(i, 1);
    unmatchedAfter.splice(unmatchedAfter.indexOf(a), 1);
  }
  // 2. what is left, at the same position: reworded in place
  for (const a of [...unmatchedAfter]) {
    const i = unmatchedBefore.findIndex((b) => b.sequence === a.sequence);
    if (i < 0) continue;
    compare(unmatchedBefore[i], a);
    unmatchedBefore.splice(i, 1);
    unmatchedAfter.splice(unmatchedAfter.indexOf(a), 1);
  }
  changed.sort((x, y) => x.after.sequence - y.after.sequence);
  moved.sort((x, y) => x.to - y.to);

  const key = (t: VTarget) => `${t.kind}:${t.ref.toLowerCase()}`;
  const beforeKeys = new Set(before.targets.map(key));
  const afterKeys = new Set(after.targets.map(key));
  const targets = { added: after.targets.filter((t) => !beforeKeys.has(key(t))), removed: before.targets.filter((t) => !afterKeys.has(key(t))) };

  const summary: string[] = [];
  for (const h of header) {
    summary.push(h.field === 'passMark' ? `Pass mark ${h.before ?? '—'} → ${h.after ?? '—'}` : `${HEADER_LABEL[h.field]} changed`);
  }
  if (unmatchedAfter.length) summary.push(`${plural(unmatchedAfter.length, 'question', 'questions')} added`);
  if (unmatchedBefore.length) summary.push(`${plural(unmatchedBefore.length, 'question', 'questions')} removed`);
  if (changed.length) summary.push(`${plural(changed.length, 'question', 'questions')} changed`);
  if (moved.length) summary.push(`${plural(moved.length, 'question', 'questions')} moved`);
  if (targets.added.length) summary.push(`Now relevant to ${targets.added.map((t) => t.label).join(', ')}`);
  if (targets.removed.length) summary.push(`No longer relevant to ${targets.removed.map((t) => t.label).join(', ')}`);

  return { header, questions: { added: unmatchedAfter, removed: unmatchedBefore, changed, moved }, targets, summary };
}
