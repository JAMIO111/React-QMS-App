/**
 * Occurrence evidence (the living FMEA, plan FM12): what the non-conformance register says about the failure modes of an analysis. Plain functions over rows the service has read as the
 * caller, so they can be tested without a database. Information only: nothing here re-rates anything.
 */

/** A cause rated this low or lower on the scale of ten says "this hardly ever happens". */
export const LOW_OCCURRENCE = 3;
/** Seeing at least this many non-conformances in the period against such a rating is worth a second look. */
export const SEEN_AT_LEAST = 3;
export const DEFAULT_DAYS = 365;
export const MAX_DAYS = 1095;

export interface EvidenceMode {
  id: string;
  text: string;
  itemName: string;
  /** The failure mode of the non-conformance register this one is tied to. */
  ncFailureModeId: string | null;
  /** The occurrence ratings of its causes that have one. */
  occurrences: number[];
}

/** How many live non-conformances name one failure mode of the register in the period. `inScope`: those on the FMEA's parts, families or machines. */
export interface NcCount {
  ncFailureModeId: string;
  name: string;
  total: number;
  inScope: number;
  latestOn: string | null;
}

export type EvidenceFlag = 'untied' | 'none_seen' | 'seen' | 'seen_but_rated_low';

export interface ModeEvidence {
  id: string;
  text: string;
  itemName: string;
  tied: boolean;
  ncFailureModeId: string | null;
  ncFailureModeName: string | null;
  /** What the evidence counts: the ones in scope when the FMEA has a scope, else all of them. Null when the failure mode is tied to nothing. */
  count: number | null;
  total: number | null;
  inScope: number | null;
  latestOn: string | null;
  maxOccurrence: number | null;
  flag: EvidenceFlag;
}

/** Each failure mode of the analysis beside what happened. `scoped` says whether the FMEA names a part, family or machine (so `inScope` means something). */
export function modeEvidence(modes: EvidenceMode[], counts: NcCount[], scoped: boolean): ModeEvidence[] {
  const byId = new Map(counts.map((c) => [c.ncFailureModeId, c]));
  return modes.map((m) => {
    const maxOccurrence = m.occurrences.length ? Math.max(...m.occurrences) : null;
    if (!m.ncFailureModeId) {
      return { id: m.id, text: m.text, itemName: m.itemName, tied: false, ncFailureModeId: null, ncFailureModeName: null, count: null, total: null, inScope: null, latestOn: null, maxOccurrence, flag: 'untied' };
    }
    const c = byId.get(m.ncFailureModeId);
    const total = c?.total ?? 0;
    const inScope = scoped ? (c?.inScope ?? 0) : null;
    const count = scoped ? (inScope as number) : total;
    const flag: EvidenceFlag = count === 0 ? 'none_seen' : maxOccurrence != null && maxOccurrence <= LOW_OCCURRENCE && count >= SEEN_AT_LEAST ? 'seen_but_rated_low' : 'seen';
    return { id: m.id, text: m.text, itemName: m.itemName, tied: true, ncFailureModeId: m.ncFailureModeId, ncFailureModeName: c?.name ?? null, count, total, inScope, latestOn: c?.latestOn ?? null, maxOccurrence, flag };
  });
}

export interface NcExample {
  id: string;
  reference: string;
  title: string;
  detectedOn: string;
  ncFailureModeId: string;
}

export interface NotForeseen {
  ncFailureModeId: string;
  name: string;
  count: number;
  latestOn: string | null;
  /** The newest few, so a person can open them. */
  examples: NcExample[];
}

export const EXAMPLES_PER_GROUP = 5;

/**
 * The failure modes of the register that happened in scope and that no failure mode of this analysis is tied to, most frequent first. A non-conformance with no failure mode at all
 * cannot be said to be unforeseen: it is counted apart by the caller.
 */
export function notForeseen(counts: NcCount[], tied: Set<string>, examples: NcExample[]): NotForeseen[] {
  const byMode = new Map<string, NcExample[]>();
  for (const e of examples) byMode.set(e.ncFailureModeId, [...(byMode.get(e.ncFailureModeId) ?? []), e]);
  return counts
    .filter((c) => !tied.has(c.ncFailureModeId) && c.inScope > 0)
    .map((c) => ({
      ncFailureModeId: c.ncFailureModeId,
      name: c.name,
      count: c.inScope,
      latestOn: c.latestOn,
      examples: (byMode.get(c.ncFailureModeId) ?? [])
        .slice()
        .sort((a, b) => b.detectedOn.localeCompare(a.detectedOn) || a.reference.localeCompare(b.reference))
        .slice(0, EXAMPLES_PER_GROUP),
    }))
    .sort((a, b) => b.count - a.count || (b.latestOn ?? '').localeCompare(a.latestOn ?? '') || a.name.localeCompare(b.name));
}
