/**
 * FMEA (FM5a): which causes the control plan covers. Plain functions, no database: the service gathers the rows and these say what they mean.
 *
 * A cause that needs attention (its action priority is high, or its severity is at or above the model's floor) is COVERED when at least one control carried from it names a
 * characteristic the control plan in force has. A control can be carried to a characteristic that is only on a draft of the plan (it is on its way), or that the plan in force
 * no longer has (the link is broken); the caller may also be unable to read control plans, in which case nothing can be checked. Information only: nothing here blocks anything.
 */

/** Where a carried control stands against the control plan now. */
export type LinkState =
  /** The plan in force has the operation and the characteristic. */
  | 'in_plan'
  /** Only a draft (or a revision waiting for approval or its date) of the plan has it: on its way, not in force yet. */
  | 'not_in_force'
  /** No revision of the plan has it: the link no longer points at anything. */
  | 'missing'
  /** The caller cannot read control plans, so it cannot be checked. */
  | 'unknown';

/** `canRead`: the caller may read control plans. `inForce`: a revision of the plan in force has the characteristic. `anywhere`: any live revision of the plan has it. */
export const linkState = (canRead: boolean, inForce: boolean, anywhere: boolean): LinkState => {
  if (!canRead) return 'unknown';
  if (inForce) return 'in_plan';
  return anywhere ? 'not_in_force' : 'missing';
};

export type CoverageCause = {
  id: string;
  text: string;
  failureMode: string;
  itemName: string;
  priority: 'high' | 'medium' | 'low' | null;
  severity: number | null;
  rpn: number | null;
  specialClass: 'critical' | 'significant' | null;
};

export type CoverageLink = { id: string; causeId: string; kind: 'prevention' | 'detection'; state: LinkState; planCode: string | null; operationCode: string; characteristicKey: string };

export type CoverageStatus = 'covered' | 'unverified' | 'link_problem' | 'not_covered';

export type CoverageRow = CoverageCause & { status: CoverageStatus; links: CoverageLink[]; why: string };

export type Coverage = {
  rows: CoverageRow[];
  totals: { needingAttention: number; covered: number; unverified: number; linkProblems: number; notCovered: number; coveredPercent: number | null };
};

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const STATUS_ORDER: Record<CoverageStatus, number> = { not_covered: 0, link_problem: 1, unverified: 2, covered: 3 };

const WORDS: Record<CoverageStatus, string> = {
  covered: 'The control plan in force has a characteristic that checks it.',
  unverified: 'Controls are carried to the control plan, but you cannot read control plans, so this cannot be checked.',
  link_problem: 'A control is carried to the control plan, but the plan in force does not have that characteristic.',
  not_covered: 'No control plan characteristic checks this: carry a control to one, or say why not.',
};

/** The coverage of the causes that need attention. Worst first (not covered, then broken links), then by priority and RPN. */
export function controlCoverage(causes: CoverageCause[], links: CoverageLink[]): Coverage {
  const byCause = new Map<string, CoverageLink[]>();
  for (const l of links) byCause.set(l.causeId, [...(byCause.get(l.causeId) ?? []), l]);
  const rows: CoverageRow[] = causes.map((c) => {
    const mine = byCause.get(c.id) ?? [];
    const status: CoverageStatus = mine.some((l) => l.state === 'in_plan')
      ? 'covered'
      : mine.length === 0
        ? 'not_covered'
        : mine.every((l) => l.state === 'unknown')
          ? 'unverified'
          : 'link_problem';
    let why = WORDS[status];
    if (status === 'link_problem') {
      const draftOnly = mine.some((l) => l.state === 'not_in_force');
      why = draftOnly
        ? 'A control is carried to a characteristic that is only on a draft of the control plan: it covers this once that revision is in force.'
        : WORDS.link_problem;
    }
    return { ...c, status, links: mine, why };
  });
  rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (PRIORITY_ORDER[a.priority ?? ''] ?? 3) - (PRIORITY_ORDER[b.priority ?? ''] ?? 3) ||
      (b.rpn ?? 0) - (a.rpn ?? 0) ||
      a.text.localeCompare(b.text),
  );
  const count = (s: CoverageStatus) => rows.filter((r) => r.status === s).length;
  const covered = count('covered');
  return {
    rows,
    totals: {
      needingAttention: rows.length,
      covered,
      unverified: count('unverified'),
      linkProblems: count('link_problem'),
      notCovered: count('not_covered'),
      coveredPercent: rows.length === 0 ? null : Math.round((covered / rows.length) * 100),
    },
  };
}

/** A control plan characteristic with the FMEA causes that carry a control to it: for the control plan revision page. */
export type PlanCover = {
  operationCode: string;
  characteristicKey: string;
  covers: { causeId: string; cause: string; failureMode: string; priority: 'high' | 'medium' | 'low' | null; needsAttention: boolean; kind: 'prevention' | 'detection'; fmeaId: string; fmeaNumber: string; fmeaTitle: string; revisionLetter: string | null }[];
};

/** Groups the live links on FMEA revisions in force by plan characteristic (operation code ignoring case, then key), each group's most pressing cause first. */
export function groupPlanCover(rows: { operationCode: string; characteristicKey: string; cover: PlanCover['covers'][number] }[]): PlanCover[] {
  const groups = new Map<string, PlanCover>();
  for (const r of rows) {
    const key = `${r.operationCode.toUpperCase()}\u0000${r.characteristicKey}`;
    const g = groups.get(key) ?? { operationCode: r.operationCode, characteristicKey: r.characteristicKey, covers: [] };
    g.covers.push(r.cover);
    groups.set(key, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.covers.sort((a, b) => (PRIORITY_ORDER[a.priority ?? ''] ?? 3) - (PRIORITY_ORDER[b.priority ?? ''] ?? 3) || a.cause.localeCompare(b.cause));
  return out.sort((a, b) => a.operationCode.localeCompare(b.operationCode) || a.characteristicKey.localeCompare(b.characteristicKey));
}

/** What a failure mode's special class suggests for the plan characteristic's criticality: offered, never copied (FM7). Null when they already agree or nothing is suggested. */
export function criticalitySuggestion(specialClass: 'critical' | 'significant' | null, criticality: 'critical' | 'major' | 'minor' | null): string | null {
  if (!specialClass || !criticality) return null;
  const expected = specialClass === 'critical' ? 'critical' : 'major';
  const rank = { minor: 0, major: 1, critical: 2 } as const;
  if (rank[criticality] >= rank[expected]) return null;
  return specialClass === 'critical'
    ? `The failure mode is marked critical, but the plan characteristic is ${criticality}. Consider raising it to critical in the next plan revision.`
    : `The failure mode is marked significant, but the plan characteristic is ${criticality}. Consider raising it to major in the next plan revision.`;
}
