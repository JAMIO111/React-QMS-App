# FMEA — exit report

**Date:** 2026-11-25 · **Plan:** `docs/fmea-plan.md` · **Slices:** FM1–FM5 (FM5a, FM5b, FM5c-1 to FM5c-3), FM6a–FM6c, FMX · **Branch:** `Dev`

## What was built

Design and process FMEAs as **versioned nets**: structure → functions → failure modes → effects and causes → controls and ratings, with the organisation's own rating model and actions that carry revised ratings. **It informs; it never stops work** (nothing is blocked by a missing, late or stale FMEA).

- **Foundation (FM1):** module `fmea`, permissions `fmea.read` / `.manage` / `.approve` tied to packages, `fmeas` (`FMEA-NNN`, kind fixed), `fmea_revisions` (letter given only on first submit, never reused; draft → pending approval → approved → in force → superseded; **the preparer never approves**; one open and one in force per FMEA), team (one lead), scope links, approval and settling without a worker.
- **Rating model (FM2):** versions, **RPN with thresholds** or an imported action-priority grid (which must cover all 1,000 combinations exactly once), a severity floor, ten-level scales per kind with the organisation's own wording. **The AIAG-VDA grid and scale wording are the publisher's and were not written into the product**; neutral scales are seeded. The database scores; a client cannot send an RPN.
- **The analysis (FM3):** items, functions, failure modes (with special class), effects (with severity), causes (occurrence, detection, prevention and detection controls). **A cause's severity is the worst of its failure mode's effects**, worked out by the database; the "still needed" list asks for a structure, a function on every leaf, an effect and a cause on every failure mode, ratings and a control, and **a reason or an action for every cause that needs attention**. **Inheritance:** a part's FMEA can start from a base FMEA in force (a copy with provenance, never a live link).
- **Actions (FM4):** an action on a cause for a member or an employee; the person it is given to finishes it with only the read right; **revised ratings and the revised RPN are worked out by the database**; open actions are carried to the next revision, finished ones can be adopted; compare revisions by lineage, "the base moved on", the periodic review, My actions, the notice.
- **The living FMEA (FM5):** **carry a cause's control to the control plan** (a link, not a copy) with a coverage report (covered / link problem / not covered / unverified), a list on the control plan page; **occurrence evidence** (how many live non-conformances were raised against each failure mode, in scope and period, plus the failures the analysis did not foresee, a stated rule for "seen but rated low"); banners on the part, family, machine and control plan pages; raise an FMEA from an NC, 8D, audit finding, SCAR or change; raise a **risk** from a cause; start or link an **FMEA revision as a change task**; an "Was the FMEA reviewed?" prompt on the 8D.
- **Outputs and signals (FM6):** the **dashboard** (`/FMEA`, figures as of today and for a period; the register is `/FMEA/Register`) and a **home page area** that share their SQL, the printable **form sheet** and **CSV export**, three **workflow triggers** (`fmea.approved`; `fmea.action_overdue` and `fmea.review_due`, written once for each due date by the worker's daily step) and two **reminders areas** (actions, periodic reviews).
- **Exit check (FMX):** this report, the live checks below and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (every migration through `20260446100000`; 188 SQL tests incl. `fmea_foundation`, `fmea_rating_model`, `fmea_analysis`, `fmea_actions`, `fmea_control_links`, `fmea_occurrence_link`, `fmea_raise_from`, `fmea_risk_change_links`, `fmea_signals`, guardrails and the tenancy sweep) | pass |
| `npm run api:test:e2e` after FM6 (141 suites, 1,522 tests, 1 skipped, including every `fmea-*` suite, `home-dashboard`, `workflows`, `reminders`, `worker` and the API tenancy sweep for every new route) | pass |
| `npm test` (219 files, 2,267 Vitest tests), `npm run lint` (0 errors), `npm run build`, API unit tests (626) | pass |
| Migrations live | all nine (`20260438100000` … `20260446100000`) are applied **and** have their history rows |
| Live guardrails (rules 1–7 over the whole schema; rules 2, 3 and 8 for every `fmea*` table, run against the live project) | **0 violations**. `fmea_counters` is a counter table and, like the other counter tables, is not on the "must be audited" list |
| Live objects | the three workflow triggers and two reminders areas are in the live functions beside the older ones (change, Gauge R&R, quality alert), the approval trigger exists, `anon` and signed-in users cannot run `app.system_emit_fmea_due_events`, only the API login can |
| Advisors (security) | the two project-wide warnings only: every table is visible to GraphQL, and **leaked-password protection is off** (a Supabase dashboard setting, Pro plan). No finding is about these tables beyond their appearing in the GraphQL list |
| Browser journey (`npm run journey`, `JOURNEY_ONLY=fmea` to run just this step) | on its own part with its control plan in force, a failure mode in the register and a non-conformance raised against it: the owner submits the FMEA, **Colin approves it from his own sign-in** and it is in force; Colin finds his action in My actions and finishes it, **the database works out 192, medium**; the owner carries the control to the control plan and the coverage report says covered; the evidence card shows the non-conformance against the failure mode; the form sheet shows the analysis and the CSV downloads; the dashboard and the home page say what the analysis says |

## What the browser found

1. **The form sheet printed an empty detection after an action that changed only occurrence** ("192 (O 3, D )"), and showed the raw status word "effective". The sheet and the CSV now fill an unchanged rating from the cause, and the status is written in words. (Both found by looking at the screenshot of the form, not by a failing check; both have tests.)
2. **The journey step could not run on its own** because Colin had no approval right unless the document control step had run first. The step now gives him the quality manager role (without duplicating it), and the journey has a `JOURNEY_ONLY` switch to run one step on its own.

## Rules held by the database (not only the screens)

No table writes on any FMEA table: every change is a SECURITY DEFINER function. A revision is frozen once it leaves draft; its letter is given once; the preparer can never be the approver; severity, RPN, priority and "needs attention" are worked out from the model the revision is rated with and cannot be sent; a revision keeps its rating model until a person moves it to the latest on a draft. An analysis row stays in its revision and under its parent; lineage (`prev_row_id`, `base_row_id`) and a record's origin never change, for SQL either. An action's revised figures are overwritten if forged. A failure mode can be tied only to a failure mode of the organisation's own non-conformance register. A control link is made on a draft or on the revision in force and is ended, never deleted, with a reason. Nothing is deleted.

## What is not done, and what to know

- **No stop.** An FMEA that is missing, late or does not cover a characteristic blocks nothing (decision in the plan). Coverage and evidence are reports.
- **The rating wording.** Only neutral scales and RPN are seeded. An organisation that holds its own licence for the AIAG-VDA grid and scale wording imports or types it; the product does not carry the publisher's text.
- **Not built:** XLSX export (the CSV opens in Excel), the full register pattern (column menu, filter drawer, saved filters, register CSV), an FMEA section on the trace page, a list of the risks on a cause or an FMEA, a change card on an FMEA, taking a change task's link off from the screen, starting a revision from a record (API only), notices before an action is due beyond the reminders, digests, push.
- **Not checked in a browser:** mobile layouts, the form sheet's print layout, the base-FMEA flow, comparing revisions, the AP-grid import.
- **PPAP** (`docs/ppap-plan.md`) is planned and not started; it builds on this module.
