# PPAP — exit report

**Date:** 2026-11-26 · **Plan:** `docs/ppap-plan.md` · **Slices:** PP1–PP6 (PP5a–c, PP6a–c), PPX · **Branch:** `Dev`

## What was built

Production part approval (PPAP) as a submission per part revision, in both directions. **It informs; it never stops work**: no screen, banner or prompt blocks production, an inspection or a shipment because an approval is missing, late or expired.

- **Foundation (PP1):** module `ppap`, permissions `ppap.read` / `.manage` / `.approve` tied to packages, `ppap_submissions` (`PPAP-YY-NNNN`), the **18 elements** made when a submission starts, file evidence, the five levels read from the organisation's own **requirement set** (versions, with the study minimums) and the customer's own rules. **The customer manuals' level tables and minimums are the publishers' and were not written into the product**; a neutral default is seeded and an approver changes it with a reason. A submission is marked ready only when every required element has evidence and is ready (or waived by an approver with a reason).
- **Evidence from live records (PP2):** an element can link a part revision, control plan revision, FMEA revision, change, inspection, Gauge R&R study, material certificate, calibration, document revision, gauge or control plan characteristic. The state is read **as the caller** ("not shown" rather than a blank pass), frozen at submission, and compared afterwards ("changed since it was submitted"). Study statistics are judged in the API against the minimums (the customer's own over the organisation's).
- **The warrant, sending, the customer's decision (PP3):** the Part Submission Warrant is typed by the preparer and **signed by an approver who is neither the owner, the creator nor the preparer**; sending re-checks everything, freezes every link and the warrant and writes the first decision; decisions are **append-only** (approved, interim approved with the day it runs to, rejected, withdrawn), interim expiry is worked out on read, resubmission and revalidation start a new submission that names the old one (links and notes carry, files, waivers and the signature do not), the periodic review moves the next date.
- **The customer answers in the portal (PP4):** staff put a sent submission to the customer; the customer sees a curated view (named fields only: their part, the level, the elements by name, the signed warrant; no evidence, files, notes or people of ours) and answers. **Their answer is recorded as the submission's own decision** through the one function that applies decisions, so a portal answer and a staff-recorded one move the status identically.
- **Received packages (PP5):** the same record in the other direction. Staff record a package a supplier sent (the supplier's own warrant is a file; none of ours); staff can ask the supplier, who adds files per element in the portal and submits (they see only their own files). The supplier profile has a **Part approvals** tab, the expiry watchlist lists interim approvals that ran out or run out, and the inspection recommendation reads the newest package for each part (increase until approved; an interim approval blocks a reduction). None of it changes the supplier's approval status.
- **Prompts and signals (PP6):** "PPAP likely needed" prompts and **Start a PPAP** from a part revision, a change or a control plan revision (the origin is kept once and never changes), banners on Start inspection, the job hub, the production order and the part page; six workflow triggers (submitted, approved, interim approved, rejected; interim expiring and revalidation due, written by the worker once for each date), two reminders areas (interim approvals, revalidation), a notice to the owner when someone else records a decision; the **dashboard** (`/PPAP`; the register is `/PPAP/Register`) and a **home page area** that share their SQL, and a **Part approvals** section on the trace page showing where each approval stood on the day a record was created.
- **Exit check (PPX):** this report, the live checks below, a fix found on the way (next section) and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (every migration through `20260458100000`; 200 SQL tests incl. `ppap_foundation`, `ppap_evidence_links`, `ppap_submission`, `portal_ppap`, `ppap_received`, `portal_ppap_supplier`, `ppap_prompts`, `ppap_signals`, `ppap_signals_replaced`, guardrails and the tenancy sweep) | pass |
| `npm run api:test:e2e` (152 suites, 1,623 tests, 1 skipped; every `ppap-*` and `portal-ppap*` suite, `home-dashboard`, `workflows`, `reminders`, `traceability` and the API tenancy sweep for every PPAP route) | pass |
| `npm test` (229 files, 2,365 Vitest tests), `npm run lint` (0 errors, 32 warnings, none new), `npm run build`, API unit tests (63 suites, 668 tests) | pass |
| Migrations live | all nine PPAP migrations are applied (checked by their objects: the nine tables, the portal request and package functions by name, the triggers, the fix in both functions). **One history row is missing: `20260453100000 portal_ppap`** (the migration was applied; the row was not added). SQL for it is at the end of this report |
| Live guardrails (rules 1, 3–7 over the whole schema; rule 8 and the tenant-owner rule for every PPAP table, run against the live project) | **0 violations**. The nine tables (`ppap_requirement_sets`, `ppap_customer_rules`, `ppap_submissions`, `ppap_elements`, `ppap_evidence`, `ppap_psw`, `ppap_decisions`, `ppap_reviews`, `portal_ppap_requests`) all have row-level security, a select policy, an organisation and the audit trigger |
| Live objects | six PPAP workflow triggers and the two PPAP reminders areas are in the live functions (19 areas in all), the notice type exists, the status trigger and origin trigger exist, **`anon` and signed-in users cannot run `app.system_emit_ppap_due_events` or the status trigger function; only the API login can**, the `ppap-files` bucket is private, three PPAP features are tied to packages |
| Advisors (security) | the two project-wide warnings only: every table is visible to GraphQL, and **leaked-password protection is off** (a Supabase dashboard setting, Pro plan). Nothing is about the PPAP tables beyond their appearing in the GraphQL list |
| Live data | no submissions yet (0 rows); two organisations have their seeded requirement set |
| Browser journey (`npm run journey`, the whole journey including the PPAP step; `JOURNEY_ONLY=ppap` runs just this step) | pass. The step is described below |

## The journey step

`ppap()` in `scripts/journey/journey.cjs`. A customer that asks for PPAP (level 1) buys a part with a released revision. The part page says no PPAP has been started; **the owner starts one from there** (the dialog is filled in, says where it came from and keeps it). The submission lists what is still needed; the owner types the warrant and **cannot mark it ready**; **Colin signs it from his own sign-in**; the owner marks it ready and sends it, which freezes the warrant; **Colin records the customer's approval**. The submission, the part page, the dashboard (1 approved, nothing needing action), the register and the home page all say approved, **the dashboard and the home page agree**, and the database holds exactly one approval and the part revision as the origin.

**What the browser found:** nothing wrong in the product. Looking at the screenshots found one fault in the journey itself (the dashboard screenshot caught the loading skeleton because the heading is shown before the figures; the step now waits for them), which is why the page was looked at and not only asserted.

**What the journey does not cover:** level 3 with linked evidence (a control plan, FMEA, inspection, Gauge R&R) and the study minimums, an interim approval or a rejection, a resubmission or a revalidation, the customer and the supplier answering **in the portal** (both are covered by API tests and by SQL tests that list the exact keys the party can see, but have never been looked at in a browser), the trace page's section, the reminders and notices. Mobile layouts and the print layout of the warrant are not checked.

## A fix found on the way

The reminders area and the workflow event for a revalidation (PP6b) still named an approval after a **revalidation had replaced it**, so the owner went on being reminded after starting the new submission. Both now use the dashboard's rule (replaced by a submission that is not withdrawn; a withdrawn replacement means the approval is due again). Migration `20260458100000_ppap_signals_replaced.sql` (applied live, history row present), test `ppap_signals_replaced.test.sql` (fails without the migration).

## Rules held by the database (not only the screens)

No table writes on any PPAP table: every change is a SECURITY DEFINER function. The preparer can never sign the warrant; a signed warrant's typed fields never change; **decisions are append-only and frozen, and the status moves to submitted, approved, interim approved or rejected only through the recording functions** (not by hand, not by SQL); sending re-checks the still-needed list at that moment and freezes the links; a record's origin is set once and never changes; a received package refuses a typed warrant of ours, and a submission to a customer refuses a supplier. The portal functions work from the caller's own live access to the party the request names, never from anything the request says, and return **named fields only** (the exact keys are asserted in the SQL and API tests, so a column added to a table adds nothing to the portal). A supplier cannot touch a package once staff mark it ready. Nothing is deleted: evidence is removed with a reason, a waiver is kept with who and why.

## What is not done, and what to know

- **No stop.** A missing, late or expired approval blocks nothing (the plan's decision). Prompts, banners and the recommendation are information.
- **The level tables and the minimum Cpk values.** Only the neutral default is seeded. An organisation enters its own reading of each customer's requirements; the product does not carry the publishers' text. The warrant is the generic layout, not an OEM-specific one.
- **A one-person organisation cannot sign its own warrant** (the preparer rule), the way a change cannot be self-approved unless a setting is on; a setting like it is not built.
- **Not built:** files or evidence shown to the customer in the portal, a conversation or a deadline on a request, reminders to a customer or a supplier who has not answered, a customer answering a submission staff have not put to them, a supplier starting a package or typing their own warrant values, requiring a supplier link for the part, database messages worded for a supplier, opening the linked record from a submission, an "expired" decision record, a review interval per customer or per level, the prompts for a machine named on a tooling change and for a new supplier source, a notice to the person who prepared a submission (the owner is told), a weekly digest, a PPAP area in the management review, a PPAP line on the supplier scorecard, the whole package as one downloadable set.
- **Not checked in a browser:** the customer's and the supplier's portal pages, mobile layouts, the warrant's print layout, a level 3 package, the trace section.

## History row to add

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('20260453100000', 'portal_ppap');
```
