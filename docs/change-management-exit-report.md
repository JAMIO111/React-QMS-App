# Change management (ECR / ECN) — exit report

**Date:** 2026-11-24 · **Plan:** `docs/change-management-plan.md` · **Slices:** CH1–CH4, CH5a, CH5b, CH6a, CHX (CH5c decided against, CH6b not built) · **Branch:** `Dev`

## What was built

One record, the **change request** (`ECR-YY-NNNN`; an ECR while it is assessed and agreed, an ECN once approved), above the revision lifecycles that already existed (part revisions and corrections, control plan revisions, document revisions). It says why a change is made, what it covers, what else it touches, who agreed, what has to be done and from when, and whether it worked. **It informs; it never stops work.** (ISO 9001 §6.3, IATF 16949 §8.5.6.1.)

- **Core (CH1):** module, three permissions (`change.read`, `change.approve`, `change.manage`) tied to packages (Observer reads, Contributor signs, Controller does everything), seeded lists per organisation (seven types, five functions, twelve impact areas), the change record (a draft, editable only while a draft; origin and raiser never change), scope links, files, the register, the change page and Settings → Data Management → Change.
- **Assessment and approval (CH2):** an impact assessment with a row per area (affected needs a note), a **board by function** chosen per change, a numbered round of sign-offs (the raiser cannot sign unless the organisation allows it), send-back with a reason (everyone signs again), recall, the cut-in point (none, a date, an order, a lot or a serial number, and what to do with stock already made) and the customer's approval record (recorded, never asked here), the printable change notice, notices to signers and the raiser.
- **Carrying it out (CH3):** tasks given to people, each optionally pointing at the real record it changes with that record's **live status** ("In force / Not in force yet"); **start a revision from a task** (part, control plan or document, made as the person so those modules' rules apply); the stage after approval **worked out from the tasks**, never set by hand; the effectiveness check (effective closes the change, not effective sends it back to implementing); My changes with a menu badge.
- **Raising and tracing (CH4):** raise a change from an NC, an 8D (or a corrective or preventive action), an audit finding, a risk, an accepted document change request or a management review decision, prefilled, the source kept as the origin; a **Changes** card on those records and on the part, part family, machine, supplier, document and control plan revision pages; the trace page says whether a lot was built before or after a change's cut-in point.
- **Workflow and reminders (CH5a):** triggers `change.submitted`, `change.approved`, `change.closed`; reminder areas for open tasks and for sign-offs waiting (due seven days after they were asked for).
- **Dashboard, home page, management review (CH5b):** `/Change` is the change dashboard, the register is `/Change/Register`; the home page has a `change` area; a management review has a thirteenth section, **Changes to the quality management system**. **One set of SQL fragments serves all three, so they cannot disagree** (the home e2e compares them).
- **Portal (CH6a):** a customer asks for a change on one of their parts and a supplier notifies a process change; each lands as a **draft change** with the sender named, staff are told, and the sender sees a plain status only.
- **Decided against:** CH5c, the opt-in release gate (it could not fire as written, and the owner chose to build neither alternative; see plan §8g). **Not built:** CH6b (asking a customer to approve in the portal), default signers per function, files or comments on a portal request, emergency changes.
- **Exit check (CHX):** this report, the live checks below and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (every migration through `20260436100000`; 178 SQL tests incl. `change_management_core`, `change_assessment_approval`, `change_tasks_closing`, `change_raise_from`, `change_workflow_reminders`, `management_reviews`, `portal_change_requests`, guardrails and the tenancy sweep) | pass |
| `npm run api:test:e2e` (130 suites, 1,433 tests, run after CH6a; CHX changed no API code incl. `change`, `portal-change-requests`, `home-dashboard`, `management-reviews`, `workflows`, `reminders` and the API tenancy sweep for every new route) | pass |
| `npm test` (205 files, 2,154 Vitest tests), `npm run lint` (0 errors), `npm run build` | pass |
| Migrations live | all nine (`20260430100000` … `20260436100000`) are applied **and** have their history rows |
| Live guardrails (rules 1–7 over the whole schema, rule 8 for the twelve new tables, run against the live project) | **0 violations**; `portal_change_requests` was added to the "must be audited" list in `supabase/checks/guardrails.sql` |
| Live objects | the nine change tables and `portal_change_requests` exist with RLS, an `audit_changes` trigger, no anon privilege on any new function, and the origin check allows `portal_request` |
| Advisors (security) | no finding about these tables. The two warnings are project-wide: every table is visible to GraphQL and **leaked-password protection is off** (a Supabase dashboard setting, Pro plan) |
| Advisors (performance) | no multiple-permissive-policy finding on the new tables. Unindexed foreign keys on them are the usual audit and actor columns (`created_by`, `updated_by`, the signer, owner, decided-by and done-by users) and the composite organisation keys whose single-column indexes lead with the id; unused-index INFO is expected on new tables |
| Browser journey (`npm run journey`) | the whole journey passes with the new step: on its own part, control plan and non-conformance, the owner **raises a change from the NC** (the NC as its origin, the part as what it covers), submits it, marks all twelve impact areas (two affected, with how), records that the customer's approval is not needed, sets a cut-in date and names a board (**Colin signs for Quality and for Engineering**) and sends it to the board; **Colin finds it in My changes and approves both sign-offs from his own sign-in**; the owner adds two tasks that each **start a revision** (part revision B, control plan revision B); both show "Not in force yet" and the database **refuses to finish a task** while its revision is a draft; once both revisions are released the tasks show "In force", are finished and **the effectiveness check closes the change**; the change notice, the Changes card on the NC and the dashboard then show it. The journey's checks of the database: stage `closed`, two approved sign-offs, two revision tasks done, review `effective`. The management review step now expects **thirteen** sections and sees the new Changes section |

## What the browser found

1. **The change notice stopped being an ECN as soon as work began.** `ChangeNoticePage` treated only the stage `approved` as approved, so a change that was implementing, being checked or closed said "Engineering change request" and "Not approved: this is a draft of the notice", although the board had approved it. A change the board approved is now a notice in every later stage (`approved`, `implementing`, `verifying`, `closed`), with a test for each stage.
2. **The journey still said twelve sections.** The management review step expected twelve reviewed sections; since CH5b a review has thirteen. It now expects thirteen and checks that the Changes section is on screen.
3. **A task a manager may try to finish before its revision is in force** shows the Done button (the person may try); the database refuses with "The record this task changes is not in force yet: release or approve it first" and the dialog says so. The first version of the step wrongly expected no button; the step now clicks it and checks the refusal, and the journey allows that one expected `409` (`change-tasks/{id}/complete`) like its other deliberate refusals.

One run of the whole journey failed in the audit step (a "Complete audit" button still disabled), far from the change step; the next full run passed it and nothing about changes or audits had been touched. It is noted, not explained: a timing flake in an earlier step.

## Rules held by the database (not only the screens)

No table writes on any change table: every change is a SECURITY DEFINER function, and the record tables are frozen by triggers even for SQL. A change's wording changes only while it is a draft; its origin and raiser never change. A sign-off is decided once, by the named signer, and never by the raiser (unless the organisation allows it); a send-back supersedes the round and everyone signs again. The stage after approval is worked out from the tasks and only the allowed moves exist. A task's linked record keeps its own status and approval; a task on a revision can be finished only once that revision is in force. The effectiveness check is append-only. A change cannot be closed while a required customer approval is open or a linked revision is no longer in force. A portal request is one draft change with its sender named; the sender sees a plain status and nothing else. Nothing is deleted.

## What is not done, and what to know

- **No release gate.** Nothing stops a revision being released because of a change (CH5c, §8g). The cut-in point and the customer approval are recorded, not enforced.
- **CH6b** (asking a customer to approve a change in the portal) is not built; the customer's answer is recorded by staff.
- **Portal requests** carry no files, no conversation and no email back to the sender, and raise no workflow event.
- The journey releases the two revisions through the API (the part and control plan release screens are covered by their own steps), and signs for both board functions as one person because the organisation has two people.
- Not checked in a browser: mobile layouts, the portal change request page, the change notice's print layout.
