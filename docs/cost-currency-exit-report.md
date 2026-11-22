# Costs in more than one currency — exit report (CU-D)

Plan: `docs/cost-currency-plan.md` (decisions CU1–CU12). Slices CU-A (database), CU-B (API), CU-C (screens) and CU-D (this check) are done.

## Evidence
- **Migration applied live 2026-11-20** (`20260415100000_cost_currency.sql`): `exchange_rates` exists, `ncr_costs` has the new columns and constraints, all six new functions are in place, no existing cost line is missing its new fields, and `app.system_workflow_facts` now sums `net_org × cost_sign`.
- **Live guardrail checks (targeted, new objects):** `exchange_rates` has RLS and a select policy, `anon` has no table or function privilege, signed-in users cannot write `exchange_rates` or the `exchange_rate` column, the four `app.system_*` functions are not executable by signed-in users, every function has a fixed `search_path`, and `ncr_costs` keeps its audit trigger. 0 violations.
- **Advisors (security):** only the two warnings that were already there (GraphQL exposure of tables to signed-in users, leaked-password protection off). Nothing new from this change.
- **Tests:** SQL `cost_currency.test.sql` (seven deliberate breaks caught), API `cost-currency.e2e-spec.ts`, `exchange-rate.gateway.spec.ts`, `ncr-records.e2e-spec.ts`, the tenancy sweep, frontend `Ncr.test.jsx`, `CostForm.test.jsx`, `NcDashboard.test.jsx`, `SettingsOrganisation.test.jsx`; full frontend (1,948) and API unit (461) suites green.
- **Browser journey** (`costCurrency()` in `scripts/journey/journey.cjs`): a cost in another currency takes the cached published rate and the tracker shows Estimated and the converted total; the person states the converted amount in the rate dialog; the line becomes Actual, the total follows, and the database keeps the stated amount, the override kind and the earlier published rate.

## Limits
- Frankfurter publishes about 30 currencies; any other pair stays "Rate needed" until someone states the rate or amount.
- The live gateway (`FrankfurterGateway`) has been tested against its documented answers only, not against the real service from this environment (no test reaches the network). Check one real cost in a foreign currency on Dev after deploying.
- A rate is for the line's incurred date and is frozen on the line; nothing re-values a line later except an explicit reset.
- The restate tool is dry-run first; it has not been run against live data (no live site currency has changed).
- Not built: rate history on the line's page, a manual rate table, currency conversion for anything other than NC costs, PPM or delivery figures.
