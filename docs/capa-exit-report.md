# CAPA / 8D module — exit report

**Date:** 2026-11-06 · **Plan:** `docs/capa-8d-plan.md` · **Slices:** CAPA1–CAPA5 · **Branch:** `Dev`

## What was built

One `capas` record (method 8D) with nine steps D0–D8 completed in any order (an 8D is a fluid document; only a closed or cancelled one is read-only),
team of members and external contacts, many-to-many NC links, 5W2H and Is / Is-Not, Ishikawa and 5 Whys, verified root causes, interim / corrective /
preventive actions, append-only effectiveness verifications (stale when the corrective actions change, a failed one reopens D5 and D6), automatic stage,
closure at D8 with `capa.verify`, evidence files, and a printable report. An NC cannot be closed while a linked 8D is running.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (migrations through `20251126100000`, SQL tests incl. `capa_core`, `capa_d2_d3`, `capa_d4`, `capa_d5_d7`, `capa_d8`, guardrails, tenancy sweep) | pass |
| `npm run api:test` / `api:test:e2e` (306 e2e incl. API tenancy sweep for every new route) | pass |
| `npm test` (Vitest), `npm run lint` (0 errors), `npm run build` | pass |
| Mutation checks on the CAPA5 migration (close ignoring the readiness list; uploads to a closed 8D; reopen keeping D8 done; close with `capa.manage` only) | all four caught by `capa_d8.test.sql` |
| Mutation checks on the CAPA4 migration (verification never stale; failed verification not reopening D5/D6) | both caught |
| Live project | migrations through `20251125100000` applied and verified (RLS on, one policy, four triggers, no anon or write grants, search_path set on every function). `20251126100000` is **not applied yet**. |

## Design notes and limits

- Evidence files belong to the 8D, not to a single step.
- The recognition note is set only when closing (a reopened 8D keeps the old note until the next closure).
- Ordering of verifications uses an identity column (`seq`), because `created_at` is the transaction time.
- No worker: nothing reminds owners of due dates; no email or push; no customer-format PDF; no CAPA dashboard or KPIs.
- **No browser check of the new screens has been done** (D5–D8 pages, the close dialog, file upload to the new bucket and the print layout were exercised only by component tests and API tests). Do this before relying on them.
- Stage 'verified_effective' lets an NC close even before the 8D is closed (rule C7 unchanged).
