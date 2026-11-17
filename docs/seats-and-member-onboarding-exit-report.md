# Seats for everyone and member onboarding — exit report

**Date:** 2026-11-17 · **Plan:** `docs/seats-and-member-onboarding-plan.md` (decisions SM1–SM7) · **Slices:** SM-A, SM-B, SM-C, SM-X · **Branch:** `Dev`

## What was built

- **Every feature is tied to a package (SM-A).** Every permission has a `features` row: view for `*.read`, operational for record rights, full for manage / approve / configure. Admin rights are never priced (`app.unpriced_permissions()`). A drift check fails when a new permission is neither priced nor listed. `app.member_may` answers for someone other than the caller, so a document's approver is only offered when they may approve.
- **No seat, no access (SM-B).** Where packages are enforced, a member without a seat is not a member (`app.seat_satisfied` inside `app.mfa_satisfied`, so RLS, the API guard and every function follow). The only exception is the rights that run the account: organisation, members, roles, security, subscription and billing. An owner or admin without a seat can give seats and pay, but uses nothing priced. Read-only admin rights do not exempt anyone. The people who give seats are told when someone joins without one, and again when the person asks (at most once a day). The API answers `403 seat_required`, and `/me` lists the organisation under `seats.waitingIn` instead of `memberships`.
- **Member onboarding (SM-C).** Someone who joins an organisation that already has members (accepted invitation, company sign-in join) sets up their own profile — About you, How we reach you, Ready — separate from the owner's organisation wizard. Without a seat, Ready is replaced by the waiting screen. It says who can give a seat and when they were told, offers **Remind them** once a day and **Sign out**, and lets the person in as soon as a seat is given (it checks every 30 seconds). People already using Fortress and the founder never see it (SM7: no backfill).

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20260323100000`; incl. `every_feature_priced`, `no_seat_no_access`, `member_onboarding`, `onboarding_organisation`, guardrails and the tenancy sweep) | pass |
| `npm run api:test` and `api:test:e2e` (1,152 passed, 1 skipped; incl. `seats` (seat_required, waiting list, reminder once a day, let in with a seat, seatless admin, unenforced organisation unchanged, own set-up while waiting), `billing` and the API tenancy sweep) | pass |
| `npm test` (1,653 Vitest tests incl. `MemberWelcome`, `App`), `npm run lint` (0 errors), `npm run build` | pass |
| Browser journey (`npm run journey`) | passes. The invited colleague goes through the welcome after accepting (screenshot `14b-colleague-welcome`). A company sign-in newcomer joins without a seat, sets up their profile and lands on **You need a seat** (`167b-sso-waiting-for-seat`). A `seat_requests` row is written, and the owner gives a Contributor seat on Settings → Users. After a reload the newcomer chooses **Go to Fortress** and is on the dashboard |
| Who live would be blocked (read-only, before applying SM-B) | **nobody**: neither live organisation enforces packages (both grandfathered), and every active member and pending invitation already holds a seat |
| Live migrations | SM-A applied 2026-11-17. **`20260322100000_no_seat_no_access.sql` and `20260323100000_member_onboarding.sql`: to be applied** |
| Live guardrails and advisors after SM-B / SM-C | **to do once applied** |

## Rules held by the database

The seat rule is inside the membership helpers, not the screens. The exemption list is a function (`app.seat_exempt_permissions()`). Seat requests are written at commit by a deferred trigger and by a function, then frozen and audited. A member's onboarding rows are made by a trigger and changed only through `app.set_member_onboarding_step` for the person's own membership.

## Limits

- Grandfathered organisations (packages not enforced) are unchanged: a member without a seat is still a member there.
- The waiting screen checks every 30 seconds. It is not pushed the moment a seat is given.
- Nothing reminds the people who give seats beyond the notice (and its email) when someone joins or asks.
