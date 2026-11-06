# Documentation module — plan

**Status:** agreed (decisions D1–D9, 2026-11-06) · **Date:** 2026-11-06 · **Branch:** `Dev`

The **Documentation** module will eventually hold quality alerts, procedures, engineering changes and similar controlled
communications. This plan covers the module shell and the first feature, **Quality alerts**. Nothing here is built yet.
Per `docs/design-brief.md` it is delivered as one complete, tested vertical slice per step.

## 1. What a quality alert is

A controlled, dated communication that something needs **immediate attention** and that the named people must read and
acknowledge: an incorrect material specification, a supplier material defect, a wrong inspection procedure, a gauge found out of
calibration, a customer complaint affecting several batches, a temporary change to an inspection frequency.

It is different from an *SPC alert* (a machine-raised chart signal, PC11) and from an NC (a record of nonconforming product).
It may *refer* to those, never replace them.

## 2. Decisions already taken (from the planning questions)

| # | Decision |
|---|---|
| D1 | Recipients come from **department membership**. The architecture is redesigned so a person is assigned to a department when onboarded and is then given a role within it (§4). |
| D2 | Pushing acknowledgement: in-app notification, a **My alerts** page with an unacknowledged count in the menu, an optional **acknowledge-by date**, and a manager view of who is **overdue**. Nothing blocks work. |
| D3 | An Active alert is **frozen**. A correction is a **revision** (QA-001 rev B) that supersedes the old one and asks recipients to acknowledge again. |
| D4 | Extras in this slice: **show active alerts where work happens** (starting an inspection, part and machine pages), **file attachments**, **links to an NC / supplier / gauge / part**. |
| D5 | Not gated by subscription package in this slice (can be added later with the `modules` catalogue). |
| D6 | A person can belong to **several departments, one marked primary**. |
| D7 | A department is **mandatory when inviting** someone, except people given only organisation-wide roles (owner, admin, quality manager). |
| D8 | Issuing, withdrawing and revising need a new **`documentation.issue`** permission; drafting needs `documentation.manage`. |
| D9 | Recipients are **fixed when the alert is issued** (stored list, evidence of who was asked); a manager can add people later, audited. |

## 3. The module shell

- Menu group **Documentation** (route `/Documentation`), first entry **Quality alerts**. Later entries (procedures, engineering
  changes) sit beside it; they are out of scope and are not stubbed.
- Permissions (new, role defaults in the migration): `documentation.read` (view alerts addressed to you and the register),
  `documentation.manage` (draft, edit drafts, withdraw), `documentation.issue` (activate and revise: the act that creates the
  obligation to acknowledge). Owner, admin and quality manager get all three, quality engineer gets read and manage, everyone else
  gets read. Every active member can always see and acknowledge the alerts **addressed to them**, whatever their role.

## 4. Architecture change: people belong to departments

Today a department is only a sub-unit of a site, and a person is "in" it only through a role assignment scoped to it
(`user_role_assignments.department_id`). That is not enough to say "everyone in Goods-in must acknowledge this".

Proposed model:

- New table `department_members (organisation_id, department_id, membership_id)`: a person's membership in a department. Unique per
  pair, audited, written by API functions, no DELETE of history (a leaver is marked `ended_at`).
- A role assignment scoped to a department requires that membership (database constraint/trigger), so "a role *within* that
  department" is enforced, not just convention.
- **Onboarding:** the invitation carries the department(s) and the role(s) in them; accepting creates the membership and
  assignments together. The Users & permissions screen shows and edits departments per person.
- Organisation-wide and site-wide roles (owner, admin, quality manager) stay as they are and do not need a department.
- **Migration of existing data:** every existing department-scoped role assignment creates the matching department membership. Members
  with no department stay "unassigned": they receive an alert only if named as a person or by role. The Users screen flags them.
- `app.has_permission` is **not** changed by this slice: department scoping of permissions already works through the existing
  `department_id` column. Membership adds *who belongs where*, not new access.

Open questions on this part are in §11.

## 5. Data model (new tables, all tenant tables with RLS, `audit_changes`, in both sweeps)

- `quality_alert_sequences`-style numbering: `QA-001`, `QA-002`… per organisation (same mechanism as NC/inspection references);
  a revision keeps the number and adds a revision letter.
- `quality_alerts`: one row per **revision**. Fields: number, revision, title, category (`product|process|supplier|equipment|safety`),
  severity (`low|medium|high|critical`), description, required_action, status (`draft|active|expired|withdrawn|superseded`),
  effective_date, expiry_date (optional), acknowledge_by (optional), issued_by/at, withdrawn_by/at/reason, supersedes_id,
  revision_reason. **Frozen once active**; only status moves (`active → expired` automatically by date, `→ withdrawn`, `→ superseded`).
- Scope (what it affects), each its own small table so they can be queried and shown where work happens:
  `quality_alert_parts` (part or part family), `quality_alert_machines` (machine) and `quality_alert_operations` (operation code),
  `quality_alert_departments` (affected departments, information only: who is *affected*).
- Recipients (who must acknowledge): `quality_alert_recipients` (alert revision, membership, how the person was reached:
  department / role / named, first_viewed_at, acknowledged_at, acknowledgement_note optional). **Resolved and stored when the
  alert is issued** so the evidence is fixed ("these 14 people were asked"). New joiners later are not silently added; a manager can
  add a person to an active alert (audited) and they get notified.
- Targeting rules at issue time (stored as `quality_alert_targets`): departments, roles, named people. The union of those, active
  members only, minus nobody, becomes the recipient list. Issuing warns when a chosen department resolves to nobody.
- `quality_alert_links` (optional reference to an NC, supplier, gauge, calibration or part) and `quality_alert_attachments`
  (private `quality-alert-files` bucket at `<org>/quality-alerts/<alert id>/…`, same policies as NC files: upload only into an
  existing alert's folder, never delete).

## 6. Lifecycle

`draft → active` (issue: needs `documentation.issue`, effective date reached or immediate; recipients resolved and notified)
`active → expired` (expiry date passed; evaluated when read, plus on issue/ack writes, because there is no worker yet)
`active → withdrawn` (reason required; recipients are told it no longer applies)
`active → superseded` (a revision is issued; recipients of the new revision must acknowledge again, previous acknowledgements stay
as history on the old revision)
A draft can be edited and deleted (soft); anything issued cannot. Critical/High severity requires an acknowledge-by date.

## 7. Tracking and chasing (D2)

- **Viewed:** opening the alert records `first_viewed_at` (once). **Acknowledged:** an explicit button with the date/time and an
  optional note ("I have read and understood"), once per revision.
- **My alerts** (`/Documentation/My-Alerts`): active alerts addressed to me, unacknowledged first, overdue marked; the menu shows the
  unacknowledged count.
- **Tracking view** on each alert for issuers/managers: table of recipients with *viewed / acknowledged / not yet*, times, how they
  were reached, overdue highlighted, filter by department; totals and a percentage; export-friendly (CSV later).
- **Overdue list** across alerts for managers (`/Documentation/Quality-Alerts?overdue=1`).
- **Notifications** reuse the audit-driven mechanism: `quality_alerts` created/updated types (issued, withdrawn, revised) plus a
  per-recipient notification on issue. Because the existing mechanism never tells a person about their *own* action and is
  event-per-row, recipient notices need a small extension (notifications addressed to specific people). Email is out of scope.

## 8. Where work happens (D4)

- **Starting an inspection** for a part, family or machine with an active alert shows the alert (severity, required action) above
  the form, with a link; an inspector who has not acknowledged it is reminded there.
- **Part, part family and machine pages** list active alerts that affect them.
- Implemented as a read API `GET /quality-alerts/active?partId&machineId&operationCode` used by those pages; no blocking.

## 9. API, permissions, security

- API in `api/src/documentation/` (all queries through `DatabaseService.asUser`, RLS applies): list/read, draft create/update, issue,
  withdraw, revise, add recipient, acknowledge, mark viewed, tracking, my alerts, active-for-context, attachments, links.
- Issue, withdraw, revise, resolve-recipients and acknowledge are database functions (single transaction, audited), like the NC
  functions; there are no table INSERT/UPDATE grants beyond drafts. New routes get tenancy-sweep entries.
- Acknowledgement can only be made by the recipient themselves, never on someone's behalf.

## 10. Delivery slices (each complete and tested before the next)

1. **DOC0 Department membership** (done 2026-11-06; architecture change D1): migration, API, onboarding and Users screen, migration of existing data.
2. **DOC1 Quality alerts core:** tables, numbering, draft → active → withdrawn/expired, scope, targets, frozen rules, revisions,
   register + alert page + draft editor. No recipients yet beyond storing targets.
3. **DOC2 Recipients and acknowledgement:** resolve on issue, viewed/acknowledged, My alerts, menu count, tracking view, overdue
   list, notifications.
4. **DOC3 Where work happens, attachments, links.**
5. **DOC4 Exit check:** guardrails, sweeps, docs, browser check.

## 11. Still open (small, can be settled while building)

- Wording of the severity colours/labels in the UI and whether Critical alerts also show a banner (not in this slice; D2 chose no blocking).
- Default acknowledge-by for High/Critical (proposal: effective date + 2 working days, editable).
- Whether expired alerts stay visible on My alerts for a period (proposal: 30 days, greyed out).
