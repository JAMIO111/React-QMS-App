# Single sign-on (SAML) — exit report

**Date:** 2026-11-17 · **Plan:** `docs/sso-plan.md` (decisions SS1–SS12) · **Slices:** SS0–SS4, SSX · **Branch:** `Dev`

## What was built

An organisation can let its people sign in with their **company account** (SAML 2.0 through Supabase Auth), require it, and bring existing password members across without losing their work. Everything is on **Settings → Security → Single sign-on** (owner and admin: `security.read` / `security.manage`).

- **Domains (SS1):** an email domain is proved with a DNS TXT record `fortress-verification=<token>`. The database makes the token, and only the API login records a check. One organisation holds a verified domain at a time. The domain must agree with the allowed email domains. It is removed with a reason, never deleted. A weekly worker step checks every verified domain again.
- **The company's sign-in (SS2):** the SAML metadata (an address or the file) is registered with Supabase through the Management API (`SUPABASE_MANAGEMENT_TOKEN`, scoped to the project and Auth Config: Read-write; it is held by the API only). There is one active provider per organisation, and a disabled one is kept. The verified domains are sent to Supabase on every change. **Sign in with your company account** opens `/sso` (by email, or `?domain=` / `?provider=` from the company's portal or from "Test sign-in"). The company's sign-in comes back to `/auth/callback`. A first company sign-in asks for the terms, and for a name if the company sent none.
- **Enforcement (SS3):** the mode is **Off / Optional / Required**. While required, `app.mfa_satisfied` (which every membership helper uses) admits only a session whose `amr` names the organisation's **own active provider** anywhere in the list, or a **break-glass** owner or admin at `aal2` (at most three). A company sign-in can meet the two-factor rule (on by default). Every organisation route answers `403 sso_required` before `mfa_required`, and the app shows a blocked screen that says which organisation and how to get in. Requiring is only possible from a company sign-in and needs the typed word "require". Sessions end after 12 hours while required unless another limit is set. Invitations go only to verified domains, as a link to `/sso`. Every change is kept (`sso_changes`, frozen), told to owners and admins and emailed. A **platform operator with MFA** can put a required organisation back to optional.
- **Joining and moving (SS4):** with **Anyone at your domains**, a person at a verified domain joins on their first company sign-in as a viewer or an inspector (optional department, no seat), and owners are told. A password member's **company account takes over their membership**: roles, departments, seat and 8D places follow, and open work (actions, tasks, sign-offs, documents to read, things they own) is moved kind by kind. Finished records keep the old account as history, and what a rule refused is listed, not forced. A member manager moves people from Settings → Users ("Accounts to move to company sign-in"). The person can also do it themselves on Start your organisation by typing their old password. **`app.user_reference_columns()` classifies every column that names a user**, and the SQL test fails when a new one is not classified.
- **Exit check (SSX):** this report, the live checks below and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20260320100000`; 140 SQL tests incl. `sso_domains`, `sso_providers`, `sso_enforcement`, `sso_joining_moves` with its column drift check, `subscriptions`, guardrails and the tenancy sweep) | pass |
| `npm run api:test` (442, SS4 commit; no API code changed since) and `api:test:e2e` (1,145 passed, 1 skipped; incl. `sso` and the API tenancy sweep for every route) | pass |
| `npm test` (1,644 Vitest tests), `npm run lint` (0 errors), `npm run build` | pass |
| Live migrations | the four SSO migrations applied (`20260316100000` … `20260319100000`); after the last: the ten SS4 functions and both new tables present. **`20260320100000_sso_exit_fixes.sql` is not applied yet** |
| Live guardrails (`supabase/checks/guardrails.sql` against the live project, full lists) | **0 violations**; the audited list includes `organisation_sso_domains`, `organisation_sso_providers`, `sso_break_glass_members`, `sso_changes`, `sso_account_moves`, `sso_match_dismissals` |
| Advisors (security) | nothing new. The two project-wide warnings remain: every table is visible to GraphQL (252 objects, protected by RLS) and **leaked-password protection is off** (a Supabase dashboard setting) |
| Advisors (performance) | nothing new: INFO only for the SSO tables (actor foreign keys without a covering index, indexes not yet used because no organisation uses SSO). The one WARN is the older `capa_actions` UPDATE pair (manager and assignee policies), unchanged |
| Browser journey (`npm run journey`) | the whole journey passes with the new step (`singleSignOn()`, screenshots `160`–`168`): the owner adds `journey.test`, sees the TXT record, the record is "published" and **Check now** verifies it; the company sign-in is connected and the domain is sent to the (stand-in) Supabase; joining is set to **Anyone at your domains** as inspectors; Colin (made an admin) is named break-glass. The owner signs in at the stand-in identity provider, accepts the terms, sees **Bring your account across**, types her old password and is back on her dashboard with her owner rights. She **requires** single sign-on (typed confirmation). Colin's password sign-in shows "… requires your company sign-in"; through the API, his password token is refused (`403`) and the same token at `aal2` (break-glass) is let in (`200`). Colin's company account is **not** offered Join; the owner moves him from Settings → Users and his reload shows his dashboard. A newcomer at the domain joins as an inspector. The owner sees both moves and the history, and makes SSO optional again. Nine notices were written for the changes |
| **Real sign-in against a SAML identity provider** | **not done: waits for the Supabase Pro plan** (see below) |

## What is still to do on Pro

The Supabase organisation is on the free plan, and SAML needs Pro. Until then nothing here has run against a real identity provider. When the project is on Pro:

1. Switch on SAML 2.0 (Authentication → Providers) and set `SUPABASE_MANAGEMENT_TOKEN` on the API in Vercel (Dev only for now).
2. Register a test identity provider (a free Microsoft Entra test tenant) with the values Settings → Security shows (Entity ID and Reply URL).
3. In an organisation on the Dev deployment: verify a domain, connect the metadata, then **Test sign-in**.
4. Check the token against plan §12: `amr` holds an entry with the provider's uuid, `aal` is `aal1`, and `user_metadata` carries the names from the attribute mapping.
5. Check that an unknown domain gives "Your company has not set up single sign-on", that **Required** refuses a password session, and that a break-glass owner with two-factor still gets in.

Write the result into this report and `docs/sso-plan.md` §12.

## What the browser found

Three faults, all fixed. Migration `20260320100000_sso_exit_fixes.sql` **must be applied live before the API and frontend are pushed** (it changes two functions and nothing else):

1. **A member's company account was offered "Join" as well as "Bring your account across".** With joining by domain switched on, Colin (a password member) signed in with his company account and saw both. Joining would have given his company account a second, inspector-only membership beside his real one. `app.sso_joinable_organisations()` now leaves out an organisation where a password account with the same address holds a membership, unless a member manager has marked the two accounts as different people. `app.join_by_company_sign_in` asks the same function, so it refuses too. SQL test: `sso_joining_moves` (a mutant without the fix fails it). The journey checks that Colin is not offered **Join**.
2. **The screens offered what the server then refused to a member without a seat.** Sam joined as an inspector with no seat (as designed). The home page showed the job card and asked for `GET /jobs/mine`, which answered `403`: `app.my_visible_permissions` (what `/me` lists) did not apply the subscription seat check that `app.has_permission` does. It now applies `app.has_entitlement` the same way. This affected any seatless member of an organisation whose entitlements are enforced, not only people who joined. `app.my_permissions` (which roles a person may hand out) is unchanged. SQL test: `subscriptions`.
3. **The shared confirmation pop-up was not a dialog to assistive technology.** It had no role or name, so screen readers (and the journey) could not find "Move Colin to their company account?". It is now an `alertdialog` named by its title and described by its message (`ConfirmationModalProvider.test.jsx`).

The step also needed test-side changes. The stand-in Supabase's password tokens now carry `amr` like Supabase's, because without it the API treats a token as system work and single sign-on would never refuse it. And the Single sign-on card's own **Add a domain** field is told apart from the one in **Who can be invited**.

## Rules held by the database (not only the screens)

Domains, the provider, the mode, two-factor trust, break-glass and joining change only through SECURITY DEFINER functions (`security.manage`; the provider and DNS results only from the API login). The enforcement is inside the membership helpers, so RLS, the API guard and every function follow it. Another organisation's provider in `amr` never counts. The change history is written by a trigger and frozen. Recovery is a function only a platform operator with an MFA session can call; it goes to optional, never off. Invitations outside the verified domains are refused by the database while required. Moves are recorded and frozen, and nothing is deleted.

## Design notes and limits

- **A token without `amr`** (system work acting for a person) is not limited by single sign-on or the session age. Supabase always sets `amr` on a person's sign-in.
- **Supabase never links a company account to a password account** with the same address: they are two users. Moving is what brings the membership and open work across; finished records stay with the old account.
- **One provider per organisation** and one organisation per domain (a Supabase rule too).
- **Joining by domain** gives a viewer or an inspector only, with no seat; anything more is given by an administrator.
- **Not built (plan §11):** OIDC providers, roles from the company's groups, automatic removal (SCIM), single logout, SSO for the operator panel, several organisations' providers in one session, per-site providers.
