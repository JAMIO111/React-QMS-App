import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { RequestContext } from '../common/request-context';
import type { Db } from '../database/database.service';
import { expiryOf } from './expiry';

/**
 * What a supplier's part approval packages (PPAP, received direction) say about each part we buy from them (PP14, PP16). INFORMATION ONLY: the state is shown on the supplier
 * profile and the expiry watchlist and offered to the inspection recommendation as a reason; it never changes the supplier's approval status or an inspection requirement.
 *
 * One rule, in one place: of a part's packages that nothing has replaced and that were not withdrawn, the newest one decides.
 */
export const PPAP_PART_STATES = ['approved', 'interim', 'interim_lapsed', 'rejected', 'submitted', 'in_preparation'] as const;
export type PpapPartState = (typeof PPAP_PART_STATES)[number];

export type ReceivedPackage = {
  id: string;
  reference: string;
  partId: string;
  partNumber: string;
  partName: string;
  revision: string | null;
  status: string;
  createdAt: string;
  nextReviewOn: string | null;
  interimExpiresOn: string | null;
};

/** `today` and `interimExpiresOn` are date-only strings; an interim approval is valid through the day it runs to. */
export const ppapState = (status: string, interimExpiresOn: string | null, today: string): PpapPartState => {
  if (status === 'approved') return 'approved';
  if (status === 'interim_approved') return expiryOf(interimExpiresOn, today).state === 'expired' ? 'interim_lapsed' : 'interim';
  if (status === 'rejected') return 'rejected';
  if (status === 'submitted') return 'submitted';
  return 'in_preparation';
};

/** The newest package of each part decides that part's state. */
export const latestPerPart = (rows: ReceivedPackage[]): ReceivedPackage[] => {
  const best = new Map<string, ReceivedPackage>();
  for (const r of rows) {
    const have = best.get(r.partId);
    if (!have || r.createdAt > have.createdAt) best.set(r.partId, r);
  }
  return [...best.values()].sort((a, b) => a.partNumber.localeCompare(b.partNumber));
};

export type RecommendationPpap = {
  /** Part numbers whose newest package is not approved and is not a valid interim approval: in preparation, submitted, rejected, or an interim approval that has run out. */
  notApproved: string[];
  /** Part numbers running on an interim approval that is still valid. */
  interim: string[];
};

export const ppapForRecommendation = (rows: ReceivedPackage[], today: string): RecommendationPpap => {
  const out: RecommendationPpap = { notApproved: [], interim: [] };
  for (const r of latestPerPart(rows)) {
    const s = ppapState(r.status, r.interimExpiresOn, today);
    if (s === 'approved') continue;
    (s === 'interim' ? out.interim : out.notApproved).push(r.partNumber);
  }
  return out;
};

/** Received packages (not withdrawn, not replaced by a later one), of one supplier or of all of them. Read as the caller, so row-level security decides what is seen. */
export const loadReceivedPackages = async (db: Db, ctx: RequestContext, supplierId?: string): Promise<Array<ReceivedPackage & { supplierId: string }>> => {
  const org = ctx.organisationId!;
  const res = await db.execute<Record<string, unknown>>(sql`
    select s.id, s.reference, s.supplier_id, s.part_id, p.part_number, p.name as part_name, pr.revision, s.status, s.created_at::text as created_at, s.next_review_on::text as next_review_on,
           (select d.expires_on::text from public.ppap_decisions d where d.submission_id = s.id and d.kind = 'interim_approved' order by d.seq desc limit 1) as interim_expires_on
      from public.ppap_submissions s
      join public.parts p on p.id = s.part_id
      left join public.part_revisions pr on pr.id = s.part_revision_id
     where s.organisation_id = ${org}::uuid and s.direction = 'received' and s.status <> 'withdrawn'
       and (${supplierId ?? null}::uuid is null or s.supplier_id = ${supplierId ?? null}::uuid)
       and not exists (select 1 from public.ppap_submissions r where r.replaces_id = s.id and r.organisation_id = s.organisation_id and r.status <> 'withdrawn')`);
  return res.rows.map((r) => ({
    id: r.id as string,
    reference: r.reference as string,
    supplierId: r.supplier_id as string,
    partId: r.part_id as string,
    partNumber: r.part_number as string,
    partName: r.part_name as string,
    revision: (r.revision as string) ?? null,
    status: r.status as string,
    createdAt: r.created_at as string,
    nextReviewOn: (r.next_review_on as string) ?? null,
    interimExpiresOn: (r.interim_expires_on as string) ?? null,
  }));
};

export const canReadPpap = async (db: Db, ctx: RequestContext): Promise<boolean> =>
  Boolean((await db.execute<{ ok: boolean }>(sql`select app.has_permission(${ctx.organisationId!}::uuid, 'ppap.read') as ok`)).rows[0]?.ok);

// ---- the profile tab ---------------------------------------------------------------------------------

const DateOnly = z.string();
export const SupplierPpap = z.object({
  /** False when the caller may not read part approvals: the tab says so and shows nothing, never an empty list. */
  available: z.boolean(),
  data: z.array(
    z.object({
      partId: z.string().uuid(),
      partNumber: z.string(),
      partName: z.string(),
      revision: z.string().nullable(),
      state: z.enum(PPAP_PART_STATES),
      submissionId: z.string().uuid(),
      reference: z.string(),
      status: z.string(),
      interimExpiresOn: DateOnly.nullable(),
      nextReviewOn: DateOnly.nullable(),
    }),
  ),
  counts: z.object({ approved: z.number().int(), interim: z.number().int(), notApproved: z.number().int() }),
});
export type SupplierPpap = z.infer<typeof SupplierPpap>;

export const supplierPpap = async (db: Db, ctx: RequestContext, supplierId: string, today: string): Promise<SupplierPpap> => {
  if (!(await canReadPpap(db, ctx))) return { available: false, data: [], counts: { approved: 0, interim: 0, notApproved: 0 } };
  const rows = latestPerPart(await loadReceivedPackages(db, ctx, supplierId));
  const data = rows.map((r) => ({
    partId: r.partId, partNumber: r.partNumber, partName: r.partName, revision: r.revision, state: ppapState(r.status, r.interimExpiresOn, today),
    submissionId: r.id, reference: r.reference, status: r.status, interimExpiresOn: r.status === 'interim_approved' ? r.interimExpiresOn : null, nextReviewOn: r.status === 'approved' ? r.nextReviewOn : null,
  }));
  return {
    available: true,
    data,
    counts: {
      approved: data.filter((d) => d.state === 'approved').length,
      interim: data.filter((d) => d.state === 'interim').length,
      notApproved: data.filter((d) => d.state !== 'approved' && d.state !== 'interim').length,
    },
  };
};
