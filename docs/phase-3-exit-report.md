# Phase 3 — manufacturing traceability: exit report

**Date:** 2026-11-08 · **Plan:** `docs/phase-3-plan.md` · **Slices:** TR1–TR6 · **Branch:** `Dev` (10+ commits, **not pushed**)

## What was built

Production orders (with a route of operations and machines), lots (produced or received) and serial numbers, all optional links on inspections, jobs and non-conformances;
pickers that fill the typed text from the picked record; a per-organisation switch that hides lots and serial numbers for shops that work to work orders only; orders made
from a job (when allowed); a backfill that links existing typed work orders, lots and serial numbers without guessing; SPC subgroups by order; affected lots on NCs with per-lot
dispositions and containment and a per-lot gate; and a traceability report for an order, a lot or a serial number (print view), reachable from every register and record.
**It works from an order alone**: a shop with no lots or serial numbers gets the whole story from the order.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20251212100000`, SQL tests incl. `production_traceability`, `production_links`, `ncr_affected_lots`, guardrails, tenancy sweep) | pass |
| `npm run api:test` / `api:test:e2e` (incl. `production`, `production-links`, `ncr-affected-lots`, `traceability`, API tenancy sweep for every new route) | pass |
| `npm test` (Vitest), `npm run lint` (0 errors), `npm run build` | pass |
| `npm run journey` — steps 37–55: order → operations → lot → serial range → hold; NC naming the lot, per-lot disposition, lot gate; trace of the order and of the lot; a work-order-only shop (lots off, job made on the order, NC linked, order alone traced, backfill) | pass; screenshots `37`–`55` reviewed |
| Live guardrails (`supabase/checks/guardrails.sql`) after all four migrations | **0 violations** |
| Live check of the new table and functions | RLS on, 3 policies, audit trigger, no anon access, search_path set, backfill executable by the API login only |
| Security advisors | nothing new: the existing "table visible in the GraphQL schema" notices (every table; row-level security still decides rows) and leaked password protection still **off** (Auth dashboard setting) |

Migrations applied live: `production_traceability` (TR1), `production_links` (TR3), `ncr_affected_lots` (TR4). TR2 and TR5 have no migration.

### Mutation checks

SQL (`ncr_affected_lots`): part check, quantity sum, removal while named, lot gate, per-lot disposition quantity, lowering below the lots, serials of another lot, frozen lot on a done
containment action, raise-from-inspection carrying the links — all caught. API and components: caught, apart from the equivalents below.
Closed in TR6: the gauge section of the report (out-of-calibration count, grouping, unavailable without `inspection.read`) and the exact-match-first ordering of search now have tests.

Accepted equivalent mutants: a lot create guard (row-level security also answers 403); a produced lot's supplier is null; matching an order's serial numbers through their lot (the database fills a
serial number's order from its lot, so the two agree); the redundant column filter that hides the Lot / serial column (the visibility rule hides it too).

## Design notes and limits

- A record matches at the **subject's own level**: an order sees what is linked to the order (a lot or serial link fills in the order), a lot what is linked to the lot, a serial number what is linked to it.
  An NC also matches through a live affected lot (or an affected serial number). The report lists live NCs (not deleted, not cancelled); the **NC register** filter also lists cancelled ones, as the register does.
- A section the caller may not read (`inspection.read`, `ncr.read`, `capa.read`) is reported unavailable, never empty.
- The report shows the latest 100 inspections and NCs and 200 serial numbers, and says when it is cut off.
- Gauge "out of calibration" counts readings whose gauge was invalid **when measured** (copied onto the reading), not a fresh calibration lookup.
- The affected lot is **suggested** on an NC raised from a job, never added silently.
- Not built (later phases or outside the agreed scope): genealogy (a lot made of other lots), shipments and customer delivery, ERP import (the `external_system`/`external_id` columns on orders are reserved), lot or serial cost,
  CSV/PDF export other than printing, email or push, a worker (nothing is evaluated on a schedule).
- **Journey gap:** the browser journey covers the order, lot, NC, disposition and the two traces, but it does not run a job that *fails* against the lot (the failing-reading path is covered by the API and database tests, and by the PC5 journey steps).

## Open items

- The billing gate is still off and Stripe has not been tested live (unchanged from Phase 1 onboarding).
- Turn on leaked password protection in the Supabase Auth dashboard.
- 10+ local commits on `Dev` are waiting for a push (the migrations they need are live).
