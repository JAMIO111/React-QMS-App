import { expiryOf } from '../supplier-quality/expiry';
import { ppapState, PpapPartState } from '../supplier-quality/supplier-ppap';

/**
 * What the part approval package (PPAP) of a part says, and when one may be needed (PP13, PP14). INFORMATION ONLY: nothing is blocked, started or changed; a person reads the banner or
 * the prompt and decides. The rules are pure functions so they can be tested without a database.
 *
 * A customer "requires PPAP" when the organisation has recorded rules for them or has ever sent them a package: nothing is suggested for a customer that has never been asked for one.
 */
export const NEAR_EXPIRY_DAYS = 30;
export const IDLE_DAYS = 365;

export type CustomerPpapState = 'none' | PpapPartState;
export type PackageRow = { id: string; reference: string; customerId: string; partRevisionId: string; status: string; createdAt: string; interimExpiresOn: string | null; nextReviewOn: string | null };

export type CustomerState = {
  state: CustomerPpapState;
  submissionId: string | null;
  reference: string | null;
  interimExpiresOn: string | null;
  nextReviewOn: string | null;
  /** Approved (or interim) for an earlier revision of the part, when this revision has no package. */
  earlier: { state: CustomerPpapState; partRevisionId: string; reference: string } | null;
};

/** The newest package for the revision decides; with none, an earlier revision's approval is noted but does not count. */
export const customerState = (rows: PackageRow[], revisionId: string | null, today: string): CustomerState => {
  const newest = (xs: PackageRow[]) => xs.reduce<PackageRow | null>((best, r) => (!best || r.createdAt > best.createdAt ? r : best), null);
  const mine = revisionId ? newest(rows.filter((r) => r.partRevisionId === revisionId)) : null;
  if (mine) {
    return {
      state: ppapState(mine.status, mine.interimExpiresOn, today),
      submissionId: mine.id,
      reference: mine.reference,
      interimExpiresOn: mine.status === 'interim_approved' ? mine.interimExpiresOn : null,
      nextReviewOn: mine.status === 'approved' ? mine.nextReviewOn : null,
      earlier: null,
    };
  }
  const old = newest(rows.filter((r) => r.partRevisionId !== revisionId && ['approved', 'interim_approved'].includes(r.status)));
  return {
    state: 'none', submissionId: null, reference: null, interimExpiresOn: null, nextReviewOn: null,
    earlier: old ? { state: ppapState(old.status, old.interimExpiresOn, today), partRevisionId: old.partRevisionId, reference: old.reference } : null,
  };
};

export type AttentionCode = 'none' | 'in_preparation' | 'submitted' | 'rejected' | 'interim_ending' | 'interim_lapsed' | 'idle';
export type Attention = { code: AttentionCode; tone: 'info' | 'warning' | 'critical'; message: string; customerId: string; customerName: string; submissionId: string | null };

export type PartCustomer = { id: string; name: string; requires: boolean } & CustomerState;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** What to tell people about a part's revision, customer by customer; only customers that require PPAP, worst first. */
export const attentionFor = (i: { partNumber: string; revisionLabel: string | null; today: string; lastProducedOn: string | null; customers: PartCustomer[] }): Attention[] => {
  const rev = i.revisionLabel ? `${i.partNumber} rev ${i.revisionLabel}` : i.partNumber;
  const out: Attention[] = [];
  for (const c of i.customers) {
    if (!c.requires) continue;
    const at = (code: AttentionCode, tone: Attention['tone'], message: string) => out.push({ code, tone, message, customerId: c.id, customerName: c.name, submissionId: c.submissionId });
    switch (c.state) {
      case 'none':
        at('none', 'warning', `${rev} has no PPAP for ${c.name}${c.earlier ? ` (an earlier revision was ${c.earlier.state === 'approved' ? 'approved' : 'on an interim approval'})` : ''}`);
        break;
      case 'in_preparation':
        at('in_preparation', 'info', `The PPAP for ${c.name} is being prepared (${c.reference})`);
        break;
      case 'submitted':
        at('submitted', 'info', `The PPAP for ${c.name} is waiting for their decision (${c.reference})`);
        break;
      case 'rejected':
        at('rejected', 'critical', `${c.name} rejected the PPAP for ${rev} (${c.reference})`);
        break;
      case 'interim_lapsed':
        at('interim_lapsed', 'critical', `The interim approval from ${c.name} ran out on ${dmy(c.interimExpiresOn ?? i.today)} (${c.reference})`);
        break;
      case 'interim': {
        const left = expiryOf(c.interimExpiresOn, i.today, NEAR_EXPIRY_DAYS);
        if (left.state === 'expiring') at('interim_ending', 'warning', `The interim approval from ${c.name} runs to ${dmy(c.interimExpiresOn!)}: ${left.daysLeft === 0 ? 'today is the last day' : `${left.daysLeft} day${left.daysLeft === 1 ? '' : 's'} left`} (${c.reference})`);
        break;
      }
      case 'approved':
        if (i.lastProducedOn && daysBetween(i.lastProducedOn, i.today) > IDLE_DAYS) {
          at('idle', 'warning', `${rev} has not been produced since ${dmy(i.lastProducedOn)}: a new submission to ${c.name} may be needed`);
        }
        break;
    }
  }
  const order = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => order[a.tone] - order[b.tone] || a.customerName.localeCompare(b.customerName));
};

// ---- a change or a control plan revision: "PPAP likely needed" ---------------------------------------------

export type SourceKind = 'change' | 'control_plan_revision';
export const CHANGE_STAGES_THAT_PROMPT = ['approved', 'implementing', 'verifying'];
export const CHANGE_TYPES_THAT_PROMPT = ['product_design', 'process', 'tooling', 'material'];
export const PLAN_STATUSES_THAT_PROMPT = ['approved', 'effective'];

export type SourcePart = { id: string; partNumber: string; name: string; customers: Array<{ id: string; name: string; requires: boolean; raised: { id: string; reference: string; status: string } | null }> };
export type SourcePrompt = { code: 'change_may_need_ppap' | 'plan_may_need_ppap'; message: string; partId: string; partNumber: string; customerId: string; customerName: string };

/** For each part the record is about and each customer that requires PPAP and has no package raised from this record: one suggestion. */
export const sourcePrompts = (kind: SourceKind, reference: string, parts: SourcePart[]): SourcePrompt[] =>
  parts.flatMap((p) =>
    p.customers
      .filter((c) => c.requires && !c.raised)
      .map((c) => ({
        code: kind === 'change' ? ('change_may_need_ppap' as const) : ('plan_may_need_ppap' as const),
        message: `${kind === 'change' ? 'Change' : 'Control plan revision'} ${reference} may need a new PPAP for ${p.partNumber} to ${c.name}`,
        partId: p.id, partNumber: p.partNumber, customerId: c.id, customerName: c.name,
      }))
  );

/** Does the record's own state call for a prompt at all? */
export const sourceApplies = (kind: SourceKind, state: { stage?: string; typeKey?: string | null; status?: string }): boolean =>
  kind === 'change' ? CHANGE_STAGES_THAT_PROMPT.includes(state.stage ?? '') && CHANGE_TYPES_THAT_PROMPT.includes(state.typeKey ?? '') : PLAN_STATUSES_THAT_PROMPT.includes(state.status ?? '');
