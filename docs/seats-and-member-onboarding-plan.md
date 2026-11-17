# Seats for everyone, and member onboarding — plan

**Status:** agreed 2026-11-17 · **SM-A done** (migration `20260321100000_every_feature_priced.sql`, applied live 2026-11-17; adds `app.unpriced_permissions()` incl. `roles.manage`, and `app.member_may` so a document approver is offered only when their seat allows it) · (SM1–SM7 as proposed: managing needs a Controller seat; the server refuses a seatless member; admin rights need no seat) · **Asked for:** "every feature should be tied to a package; someone who joins without a seat stays on an onboarding screen saying an owner or admin must give them a seat; members get their own onboarding, about their profile, not the organisation's."

## 1. What happens today (inspected)

- **Packages** (`docs/subscription-plan.md`, migration `20251110100000_subscriptions.sql`): Observer (view), Contributor (operational), Controller (full). A permission is held back by the subscription only when a `features` row ties it to a module, and only in organisations with `entitlements_enforced` (every self-serve organisation; older ones are grandfathered).
- **Only four modules are tied to packages:** non-conformance (`ncr.read/create/update/delete`), calibration, control plans and inspections. Every other permission works for anyone whose role holds it, **seat or no seat**:
  - 8D (`capa.*`), audits (`audits.*`), supplier quality (`supplier_quality.*`), receiving (`receiving.*`), production (`production.*`), SPC (`spc.*`), documents and quality alerts (`documentation.*`), competence (`competence.*`), risk (`risk.*`), management review (`management_review.*`), workflows (`workflows.*`), master data (`master_data.*`), `ncr.approve_disposition`, `lookups.manage`, `custom_fields.manage`, `audit.read` (the audit trail).
  - Integrations need a Controller seat already (`app.holds_controller_seat`).
- **Some reads need membership only:** My tasks, My review actions, own competence, documents and alerts addressed to you, notifications and reminders. A seatless member reads these.
- **A seatless member gets into the app.** The menu hides what the server refuses, and a gated page says "You have not been given a subscription package". There is no waiting screen.
- **Onboarding is one shape for everyone:**
  - Someone who starts an organisation gets the set-up wizard (`/setup`).
  - Someone invited accepts on Start your organisation or `/accept-invite`, gives a name if missing, then sees a welcome.
  - Someone signing in with their company account accepts the terms on `FirstSignIn`.
  - None of these is a member's own set-up.
- **Seats on invitations are optional** ("No seat yet"). Joining by company sign-in never gives one.

## 2. Decisions to agree

**SM1 — Every feature is tied to a package.** Each module gets its features, with the permission's level:

| Level | Meaning | Permissions |
|---|---|---|
| view | read | every `*.read`, `audit.read` |
| operational | record, do assigned work | `capa` actions as assignee*, `audits.perform`, `competence.assess`, `inspection.record` (already), `calibration.record` (already), `ncr.create` (already), `receiving.manage` (inspectors record deliveries) |
| full | create, manage, approve, set up | every `*.manage`, `*.approve`, `*.configure`, `*.issue`, `capa.verify`, `ncr.approve_disposition`, `lookups.manage`, `custom_fields.manage`, `workflows.manage` |

\* An 8D actionee works with `capa.read` (CAPA6), so view is enough to update their own action. **Proposal:** leave it so. A Contributor-or-better is still needed to manage an 8D.

New modules for the ones missing from the catalogue: production, receiving, SPC, competence, management review, workflows, master data. The existing "planned" rows (documents, CAPA, audits, supplier quality, risk) become `active`. Package matrix:

| | Observer | Contributor | Controller |
|---|---|---|---|
| every module | view | operational | full |

The current exceptions stay: Contributor only views control plans, risk and analytics. **Proposed new exceptions:**
- Contributor only views management review and workflows. Those are set-up work.
- Master data is view for Observer and Contributor, full for Controller. Lists of parts and machines are read by everyone who records anything.

**SM2 — Admin permissions are not tied to a package.** These are about running the account, not using the QMS: `organisation.manage`, `members.*`, `roles.manage`, `security.*`, `subscription.*`, `billing_details.manage`, `invoices.read`, `payment_methods.manage`. They already pass while an organisation is waiting to pay (`app.gated_permissions()`). In practice an owner always holds a Controller seat, because the database keeps that invariant.

**SM3 — No seat, no access (server side, not only the screen).** In an organisation that enforces entitlements, an active member with **no seat** is not a member for anything except:
- their own profile and `/me`;
- their own invitations;
- the admin permissions in SM2, if their role holds them. An admin without a seat can still give seats and manage billing.

This is enforced in the database membership helpers, the same way two-factor and single sign-on are (`app.mfa_satisfied`), so RLS, every function and the API all follow it. The API answers `403 seat_required`, and the membership-only reads in §1 stop for a seatless member. Grandfathered organisations (not enforcing) are unchanged.

**SM4 — The waiting screen.** A seatless member of an enforcing organisation sees, instead of the app:
- "You've joined *Organisation*. An owner or admin needs to give you a seat before you can start. We've told them."
- who can give seats (names of owners/admins with `subscription.seats`);
- a **Remind them** button, at most once a day;
- sign out, and switching to another organisation if they have one.

It checks every 30 seconds and lets them in as soon as a seat is given.

**SM5 — Owners and seat managers are told.** When someone joins or accepts without a seat, people with `subscription.seats` get a notice: "*Name* is waiting for a seat", linking to Settings → Users. It is emailed by default. Reminders from SM4 send the same notice again.

**SM6 — Members get their own onboarding (profile, not organisation).** After accepting an invitation, joining with a company account or being moved across, a member goes through `/welcome`, steps saved as they go:
1. **About you** — first name, surname, job title, profile picture (all but the picture prefilled from the invitation or company sign-in).
2. **Security** — two-factor set-up when the organisation requires it (company sign-in counts when trusted).
3. **How we reach you** — the notification and email choices for their role, with defaults on, and the daily reminder.
4. **Done** — their role, departments and seat in words; where to start for their permissions, as the current welcome does. Without a seat it is the waiting screen of SM4.

Owners keep the organisation wizard (`/setup`). An owner who joins someone else's organisation is a member there and gets `/welcome`. The step state is per person and organisation (`member_onboarding`, functions only). "Finish later" is allowed for steps 1 and 3, never for step 2 when two-factor is required (already enforced).

**SM7 — Existing members.** Everyone already active is marked as having finished `/welcome`. No one is sent back through it.
- **Existing seatless members of enforcing organisations** are held by SM3 from the day the migration runs. The live check before it runs will list them, so seats can be given first.

## 3. Slices

| Slice | Content |
|---|---|
| **SM-A** | Migration: modules and features for every permission (SM1), matrix, `active` statuses; test that **every permission in `permissions` is either tied to a feature or listed as an admin permission (SM2)** — a drift check, so a new permission cannot be added unpriced. |
| **SM-B** | Migration: seat in the membership helpers (SM3), `seat_required` from the guard, `/me` says `seat: none`, notices (SM5), live check listing seatless members. API e2e + both sweeps. |
| **SM-C** | Member onboarding `/welcome` (SM6) + waiting screen (SM4), `member_onboarding` table and functions, routing in `App.jsx` (owner → `/setup`, member → `/welcome`), backfill (SM7). Frontend tests. |
| **SM-X** | Browser journey: an invited colleague without a seat waits, the owner is told and gives a seat, the colleague goes through `/welcome` into the app; a company sign-in joiner the same; live guardrails; exit report. |

## 4. What this changes for people already using Fortress

- In self-serve organisations, anyone without a seat who uses 8D, audits, supplier quality, production, competence, documents, risk or management review today **loses access** until given a seat (SM3, SM7). Grandfathered organisations see no change.
- Contributors can no longer manage 8Ds, audits, supplier approvals or documents. That needs a Controller seat (full). If some of those should be Contributor work, say which.

## 5. Agreed answers (2026-11-17)

1. Creating, managing and approving (8Ds, audits, supplier approvals, documents and the rest) needs a **Controller** seat; Contributor records and works assigned items.
2. Admin rights (SM2) work **without a seat**.
3. The **server** refuses a seatless member, not only the screens (SM3).
