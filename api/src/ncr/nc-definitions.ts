import { sql } from 'drizzle-orm';

/**
 * What "raised" and "open" mean for a non-conformance, once, for every place that counts them (docs/audit-nc-2026-11.md API-3, decided by the owner 2026-11-28).
 *
 * - **Raised:** the NC has left draft, is not cancelled and is not deleted. It is counted in the period of the day it was detected (`detected_at`).
 * - **Open:** raised, and not yet closed.
 *
 * A draft is something someone is still writing, and a cancelled NC never stood, so neither counts as raised or open. Used by the NC dashboard, the home page, the supplier
 * dashboard, the supplier register and the quality objective `ncr_count`; `api/test/nc-definitions.e2e-spec.ts` asks all of them about the same records and fails if they differ.
 * (The customer dashboard and the FMEA evidence already used this rule; they take it from here too.)
 *
 * `alias` is the table alias of `public.nonconformances` in the query. It is always a literal written in code, never a request value.
 */
export const ncRaised = (alias: string) => sql.raw(`${alias}.deleted_at is null and ${alias}.stage not in ('draft', 'cancelled')`);

/** Raised and not closed. */
export const ncOpen = (alias: string) => sql.raw(`${alias}.deleted_at is null and ${alias}.stage not in ('draft', 'cancelled', 'closed')`);

/** The stages an open non-conformance can be in, in order (the stages `ncOpen` lets through). */
export const NC_OPEN_STAGES = ['open', 'contained', 'investigating', 'dispositioned', 'awaiting_closure'] as const;
