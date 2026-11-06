# CAPA / 8D module — plan

**Status:** agreed (decisions C1–C3 from the planning questions, 2026-11-06; C4–C10 follow the brief and Phase 2 plan) · **Date:** 2026-11-06 · **Branch:** `Dev`
**Authority:** `docs/design-brief.md` §6.3 (CAPA is its own domain, one CAPA addresses many NCRs), `docs/phase-2-plan.md` §2.4 and §3 (CAPA tables, stages, closure rule).

## 1. What exists today (found, not assumed)

I searched all branches and the full history for 8D work (`main`, `Dev`, `archive/holiday-let`). **No 8D page was ever built.** What there is:

- The legacy NC form (`legacy/nc-entry-form/NCEntryForm.jsx`, reference only) has an "8D Investigation" card with two placeholder buttons that do nothing,
  *Start a new 8D Investigation* and *Assign NC to an existing 8D*, plus step badges and team avatars once an 8D is linked (`ref_8D`).
- The legacy `"8D"` table only holds the **D2 problem description** as 5W2H text (`d2_who/what/where/when/why/how`) and a closure request. It has no team, actions or causes and
  is not tenant-owned; it is left alone (the same way the other legacy tables were).
- `NcrPage.jsx` says "Containment, root cause (8D) and corrective actions will be added here in a later release."

So the module is built from scratch on the current architecture (tenant tables, RLS, functions as the only writers of lifecycle steps, API through `DatabaseService.asUser`),
keeping the legacy interaction: **start a new 8D from an NC, or assign the NC to an existing one**.

## 2. Decisions

| # | Decision |
|---|---|
| C1 | **One CAPA record, method 8D** (`capas`, `CAPA-000045`). An 8D is a CAPA that uses the eight-discipline method. Simple corrective or preventive CAPAs later reuse the same actions, verification and NC links; there is no second module. |
| C2 | The team (D1) is **organisation members and external contacts** (name, company, role, no login), so supplier and customer 8Ds work. Action owners are team members. |
| C3 | A **print-friendly report view** of the whole 8D (save as PDF from the browser) is in this build. A generated customer-format PDF is a later slice. |
| C4 | NCs link **many-to-many**: an 8D has many NCs, and an NC can be in more than one 8D. Links are never deleted, only ended with a reason. |
| C5 | Each step has **content, a checklist of what is still needed to complete it** (worked out by the database, shown in the UI) and a completion action. **An 8D is a fluid document: nothing locks.** Steps can be completed in any order and every step's content stays editable after it is complete (and while the 8D is running); completing a step marks it done once what it needs is in place, and reopening one needs a reason and touches no other step. Only a closed or cancelled 8D is read-only until it is reopened. |
| C6 | The **stage is worked out by the steps** (never set by hand): `open → actions_in_progress → awaiting_verification → verified_effective → closed`, `cancelled` from any stage before closed. A failed effectiveness verification returns to `actions_in_progress` and reopens D5 and D6. |
| C7 | **Closing an NC is refused while a linked 8D is still running** (not verified effective, closed or cancelled). Nothing forces an NC to have an 8D (the Phase 2 rule "linked CAPA or a reason" is left for the NC workflow slice). |
| C8 | Analysis tools open as **modals** from the step pages: 5W2H and Is / Is-Not (D2), Ishikawa and 5 Whys (D4, 5 Whys also for the escape point). Their content is saved with the 8D as structured data. |
| C9 | Permissions: `capa.read`, `capa.manage` (create, edit, link NCs, complete steps and actions), `capa.verify` (record effectiveness, close at D8). Owner, admin, quality manager: all; quality engineer: read and manage; everyone else: read. |
| C10 | Not subscription-gated in this build (can be added through the `modules` catalogue, as for documentation). |

## 3. The eight disciplines (plus D0)

| Step | Page | Content | Tools (modals) | Needed to complete |
|---|---|---|---|---|
| **D0** | Initiate | Title, problem statement, source, due date, linked NCs, owner | Link NCs | title and problem statement |
| **D1** | Team | Leader, champion, members (member or external contact) with role | Add member | a leader and at least two people |
| **D2** | Describe the problem | 5W2H (what, where, when, who, why, how, how many), Is / Is-Not comparison | **5W2H**, **Is / Is-Not** | what, where and when |
| **D3** | Interim containment | Actions that protect the customer now (owner, due, status, effectiveness note) | Action | every action done or cancelled, or "no containment needed" with a reason |
| **D4** | Root cause | Root causes of kind occurrence, escape and systemic, each verified (method, note) | **Ishikawa**, **5 Whys** | at least one occurrence cause; every cause verified |
| **D5** | Permanent corrective actions | One or more actions per occurrence cause (owner, due) | Action | every occurrence cause has an action with owner and due date |
| **D6** | Implement and validate | Actions carried out with evidence; effectiveness verification (`capa.verify`) | Action, Verification | all corrective actions done or cancelled; an effective verification |
| **D7** | Prevent recurrence | Preventive actions, systemic fixes, similar parts and processes checked, lessons learned | Action | lessons learned and (preventive actions done, or a reason there are none) |
| **D8** | Close and recognise | Recognition note, closure sign-off | Close | all earlier steps done; `capa.verify` |

Evidence files (private `capa-files` bucket, same pattern as NC and calibration files) attach to the 8D, optionally to a step.

## 4. Data model (all tenant tables, RLS, `audit_changes`, in both sweeps and the guardrails)

- `capas`: reference, method (`8d`), type (`corrective`/`preventive`), title, problem_statement, stage, severity, source (`internal`/`customer`/`supplier`), external reference
  (customer 8D no. / SCAR no.), owner (organisation member), due_date, D2 5W2H columns, `d3_no_containment_reason`, `d7_prevention_note`, `d7_lessons_learned`, `d8_recognition`,
  closed_at/by, cancelled reason, soft bookkeeping. Created through `app.start_capa` (numbering, prefilled from an NC); content edited through column grants; stage only by functions.
- `capa_steps` (nine rows per 8D): step, completed_at/by, note, reopened_at/by/reason. Written only by `app.capa_complete_step` / `app.capa_reopen_step`.
- `capa_team_members`: member (organisation_users) **or** external name/company/email, role (`leader`, `champion`, `member`, `supplier_contact`, `customer_contact`), ended_at.
- `capa_ncr_links`: capa, nonconformance, linked_at/by, ended_at/by/reason. Unique while live.
- `capa_analyses`: kind (`is_is_not`, `ishikawa`, `five_whys`), title, step, `data` jsonb (validated by the API per kind, size-limited by a check).
- `capa_root_causes`: kind (`occurrence`, `escape`, `systemic`), description, source analysis, verified, verification method and note.
- `capa_actions`: phase (`interim`, `corrective`, `preventive`), description, root cause, owner (team member), due date, status (`open`, `done`, `cancelled`), done_at/by, evidence note, cancel reason.
- `capa_verifications`: method, effective, notes, verified_by/at. Append-only.
- `capa_attachments`: as `calibration_attachments` (soft removal with reason, private bucket at `<org>/capa/<capa id>/…`).

Errors use `QM013` → `409 capa_rule`.

## 5. NC integration

- NC page, Investigation card: **Start a new 8D** (prefilled from the NC: title, problem statement, source, D2 what/where/when/how many from the NC's fields, the NC linked) and
  **Link to an existing 8D** (search the organisation's running 8Ds). Once linked, the card lists each 8D (reference, title, stage, current step), opens it, and ends a link with a reason.
- 8D page, D0: linked NCs listed with stage and a link, link another NC, end a link.
- Database: a separate `BEFORE UPDATE` trigger on `nonconformances` refuses `→ closed` while a linked 8D is still running (C7); the NC detail returns `capas`.

## 6. API (`api/src/capa/`, `/api/v1`)

`GET|POST /capas`, `GET|PATCH /capas/{id}`, `POST /capas/{id}/steps/{step}/complete|reopen`, `POST /capas/{id}/cancel|reopen`, team (`POST /capas/{id}/team`, `PATCH|DELETE /capa-team/{id}`),
NC links (`POST /capas/{id}/ncrs`, `POST /capa-ncr-links/{id}/unlink`), analyses (`POST /capas/{id}/analyses`, `PATCH|DELETE /capa-analyses/{id}`), root causes, actions (create, edit,
`POST …/complete`, `POST …/cancel`), verifications, attachments (`GET|POST /capas/{id}/attachments`, `POST /capa-attachments/{id}/delete|restore`), `GET /ncrs/{id}/capas`.
Commands answer with the whole 8D (it is small), as for quality alerts. Every new route is `@OrganisationScoped` and in the tenancy sweep.

## 7. UI

Menu item **CAPA** (`/CAPA`): register with stage, owner, current step, progress and linked NC count. `/CAPA/:id` opens the current step; `/CAPA/:id/:step` (`d0`…`d8`) is a step page:
a stepper rail (done / current / not reached) beside the step content, a "Still needed" checklist from the database, **Back** and **Complete step and continue**. Analysis tools open as
modals (`Dialog`): 5W2H, Is / Is-Not, Ishikawa (six categories with a diagram preview), 5 Whys (chain, then "record as root cause"), action editor, verification. `/CAPA/:id/report` is the print view.
Pickers use `RHFComboBox`, dates `RHFDatePickerPopout`, files `AttachmentDrop`; every action refreshes through `lib/refresh.js`.

## 8. Delivery slices (each complete and tested before the next)

1. **CAPA1 Core, NC integration, D0 and D1** (done 2026-11-06): migration (tables, numbering, permissions, steps, team, NC links, closure rule), API, register, step shell with stepper, D0, D1, NC page card (start / link / list).
2. **CAPA2 D2 and D3** (done 2026-11-06): 5W2H and Is / Is-Not modals, interim containment actions.
3. **CAPA3 D4** (done 2026-11-06): root causes with verification, Ishikawa and 5 Whys modals.
4. **CAPA4 D5, D6, D7** (done 2026-11-06): corrective and preventive actions (linked to a root cause), effectiveness verification (`capa_verifications`, append-only, stale when the corrective actions change afterwards), automatic stage, reopening D5 and D6 on a failed verification, lessons learned and "no preventive action" reason.
5. **CAPA5 D8, files, report, exit check:** closure, attachments, print report, guardrails, sweeps, docs, exit report.

## 9. Not in this build

Email or push notices for owners and due dates (no worker), a customer-format PDF, dashboards and KPIs for CAPA, 8Ds that are not method 8D (simple CAPA), a pareto or fault-tree tool,
making an NC require an 8D, importing the legacy `"8D"` rows.
