# Single sign-on (SAML) — plan

**Status:** proposed 2026-11-16, decisions SS1–SS12 waiting to be agreed · **Brief:** `docs/design-brief.md` §12 Phase 7 ("SSO and enterprise identity"), §5 (security), §14 (definition of done), §15 (non-goals) · **Builds on:** `docs/security-plan.md` (network policy, allowed email domains, maximum session age, operator recovery)

## 1. Why

A company wants its staff to sign in to Fortress with their **work account** (Microsoft Entra ID, Okta, Google Workspace, OneLogin, ADFS …). The company's own sign-in system then decides:
- who is allowed in;
- how strong passwords are and whether a second factor is needed;
- that someone who leaves loses access when IT disables their account.

Buyers ask for this on security questionnaires; "no SSO" can end a sale.

This plan adds:
- **SAML 2.0 single sign-on per organisation**, set up by the organisation's own owner or admin;
- a **"SSO required"** rule that refuses password sign-in for that organisation;
- what happens to people who already have a Fortress password account.

## 2. What Supabase gives us (from its documentation, read 2026-11-16)

| Topic | What the documentation says | What it means here |
|---|---|---|
| Protocol | **SAML 2.0 only**: "for any identity providers compatible with the SAML 2.0 protocol". Multi-tenant SSO: one provider per customer, each with its own id. No per-customer OIDC. | SAML it is. Every enterprise identity system speaks it. |
| Plan and cost | "offered on plans **Pro and above**", switched on in the dashboard (Auth Providers). **$0.015 per SSO monthly active user** above the plan's quota. | **The project must be on Pro or above.** Price per SSO user is small, but goes into the subscription price. |
| Adding a provider | CLI `supabase sso add --type saml --metadata-url … --domains acme.com`, or the **Management API** `POST /v1/projects/{ref}/config/auth/sso/providers` (`type`, `metadata_url` or `metadata_xml`, `domains[]`, `attribute_mapping`, `name_id_format`); also get / list / update / delete. Needs an account token with `auth_config_write`. | Self-service means **the API holds a Supabase management token** (decision SS2). |
| What the customer's IT enters | EntityID / metadata `https://<project>.supabase.co/auth/v1/sso/saml/metadata` (`?download=true` for the file), ACS `…/auth/v1/sso/saml/acs`. NameID `emailAddress` or `persistent`. | Shown on the set-up screen, copyable. |
| Starting sign-in | `supabase.auth.signInWithSSO({ domain })` or `({ providerId })`, `options.redirectTo`; returns `data.url` to send the browser to. PKCE: the return page calls `exchangeCodeForSession(code)`. | A new **/sso** page and a return page. No Fortress endpoint is needed to find the provider. |
| The token after SSO | `amr` holds `{ method: "sso/saml", provider: "<provider uuid>", timestamp }`. With MFA another method can be first, so **search the whole array**. `user_metadata.iss` = the identity provider's EntityID. | The database can tell **which organisation's provider** a session came from (decisions SS6, SS7). |
| Attributes | Email required (looked for under the usual names, else the NameID when it is an email). Other attributes only when mapped, e.g. `{"keys": {"first_name": {"name": "givenName"}}}`; `array: true` for groups. | Names come from a mapping we set for every provider. |
| **Account linking** | **"No identity linking."** A password user who then signs in with SSO **becomes a second, separate user with the same email.** | **The biggest design question** (SS5): Fortress keys everything on the user id. |
| Sign-out | Single logout is "best-effort"; not supported in practice. | Leaving IT's system does not end a Fortress session already open (SS9). |
| Started from the company's portal | Not compatible with PKCE. Recommended: a "bookmark app" pointing at our own page, which starts the sign-in. | `/sso?domain=acme.com` serves as that bookmark. |
| Two-factor level after SSO | **Not documented.** | SS0 must find out (`aal1` expected). |
| Domain shared by two providers | **Not documented.** | Fortress keeps domains unique itself (SS3). |

## 3. What exists today (inspected)

| Area | Today | Effect on this plan |
|---|---|---|
| Sign-in | `Login.jsx` → `signInWithPassword` (`src/authService.js`); sign-up, verify email, forgot / set password, `/mfa`. | A second way in. Password sign-in stays for organisations without SSO. |
| New user | `app.handle_new_user` makes the profile from sign-up metadata (names, terms version). | An SSO user arrives with neither, so names come from the mapping and the terms are asked once (SS10). |
| Membership | `organisation_users` (`user_id`, invitation by `invited_email`, `app.accept_invitation` matches the signed-in email). | Invitations already match by email, so an invited person signing in by SSO can accept. |
| Two-factor rule | `organisation_settings.require_mfa` → `app.mfa_satisfied(org)` = `aal2` or not required, used in the membership helpers; API `403 mfa_required`. | An SSO session at `aal1` would be blocked. Decision SS7. |
| Who rules | Allowed email domains (invitations), maximum session age (`amr` sign-in time, `401 reauthentication_required`), network policy with operator recovery. | SSO domains and allowed domains must agree (SS3). The session age limit is the backstop for leavers (SS9). |
| User-keyed data | About 550 references to `user_id`, plus `owner_user_id`, `recipient_user_id`, `auth_id` (employee ↔ sign-in) and others across the schema. | Moving a person to a new user id is wide; it needs a checked list (SS5). |

## 4. Decisions to agree

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **SS1** | **Protocol** | (a) SAML through Supabase; (b) OIDC through a broker (Auth0, WorkOS) in front of Supabase; (c) both | **(a).** It is what Supabase supports and what IT departments set up. A broker adds a supplier, a cost and a second user store. OIDC can follow if a customer asks (§11). |
| **SS2** | **Who registers the provider with Supabase** | (a) the platform operator by CLI when a customer asks; (b) **self-service**: the organisation's owner or admin fills in the form, and the API calls the Management API with a token held only as a server variable (`SUPABASE_MANAGEMENT_TOKEN`); (c) like (b), but each new provider waits for an operator's approval on `/platform` | **(b), after SS0 confirms the narrowest token Supabase offers** (a fine-grained token limited to `auth_config_write` on this project, if it exists). Without a narrow token, **(c)**: the same code, with an operator's click as a second check before the call. Either way the token never reaches the browser or the database, and every call is recorded. (a) does not scale and puts a person in every sale. |
| **SS3** | **Proving the company owns its domain** | (a) trust what is typed; (b) **DNS TXT record** `fortress-verification=<token>` checked by the API; (c) an email to an address at the domain | **(b).** A domain linked to a provider sends **every** sign-in from that domain to that provider, so a false claim would capture another company's staff. **One domain → one organisation across all of Fortress.** A domain is linked to Supabase only once verified, re-checked weekly by the worker, and flagged (not removed) when the record goes. While allowed email domains (SE6) are set, an SSO domain must be one of them. |
| **SS4** | **Who may get in through SSO** | (a) **invited only**: SSO proves the identity, membership still comes from an invitation; (b) **joins on first sign-in** with a default role (and optional default department), no seat; (c) roles from the provider's groups | **(a) by default, (b) as a switch** for organisations that want it (default role from a short list: viewer, inspector; never owner or admin; no seat until someone gives one; the owners are told). **(c) later** (§11): group-to-role mapping needs care, because a mistake in the company's directory would grant rights in Fortress. |
| **SS5** | **People who already have a password account** (Supabase creates a *separate* user on their first SSO sign-in) | (a) treat them as a new person, re-invite, and suspend the old account (history split across two people); (b) **move them across**: on their first SSO sign-in, someone with `members.manage` confirms (or the person confirms with their old password) that the new sign-in is the same person, and one function moves the membership; (c) attach the SSO identity to the old user by writing to `auth.identities` (unsupported; could break on a Supabase upgrade) | **(b).** It moves what makes someone *a working member*: roles, departments, seat, employee link (`Employees.auth_id`), preferences, saved filters, reminder areas. It also moves **open** work: open actions and tasks, pending sign-offs, documents to read, items they own. **Finished records keep the old id**, which is history. The old account is suspended in that organisation, and `profiles.moved_to` makes the old name show as "now signs in with SSO". A test like the integration-catalogue drift test **fails when a migration adds a column that refers to a user and is not classified** as moved or history. |
| **SS6** | **"SSO required"** | (a) a sign-in page rule only; (b) **in the database**, like the two-factor rule: membership helpers accept the session only when `amr` has `sso/saml` from **this organisation's** provider; API `403 sso_required`; (c) optional / required modes | **(b) with modes `off | optional | required`.** Optional = SSO offered, passwords still work (for trying it out). Required is enforced where the two-factor rule is, so the API, RLS and storage follow. Switching to required needs a working provider, the person switching **signed in through it now**, and confirmation. This mirrors the network policy's guard against locking yourself out. |
| **SS7** | **Two-factor when signing in through SSO** | (a) still require Fortress two-factor on top; (b) **trust the company's sign-in**: an SSO session from the organisation's own provider meets `require_mfa`; (c) a switch | **(c), default (b).** The company enforces its own second factor. Asking again is a burden and duplicates it. `app.mfa_satisfied` also accepts a session whose `amr` names this organisation's provider when "trust the company's two-factor" is on. Owners can switch it off to require both. |
| **SS8** | **Getting in when SSO breaks** (expired certificate, misconfigured provider) | (a) named **break-glass members** who may still use a password and Fortress two-factor while SSO is required; (b) operator recovery only; (c) both | **(c).** Up to three named owners or admins may sign in with password **and** two-factor (never password alone), and every such sign-in notifies all owners. If even they cannot get in, a platform operator with MFA sets the mode back to optional, as network recovery (SE5) does: reason and verification recorded, everyone told, provider kept. |
| **SS9** | **Leavers** | — | Disabling someone in the company's system stops **new** sign-ins at once. A session already open lasts until its refresh runs out, because Supabase's single logout is best-effort. So: when SSO is required, the maximum session age (SE6) **defaults to 12 hours** if unset, and the screen says so. Automatic removal of members (SCIM) is not in this plan (§11). Members whose sign-in has not been used for 90 days are listed for review. |
| **SS10** | **Names and terms for a new SSO user** | — | Every provider gets an attribute mapping (`first_name`, `surname`, `display_name` under the usual SAML names, with fallbacks); `app.handle_new_user` reads them. Our terms are asked **once**, on a first-sign-in page, before anything else. The company's agreement with us may cover its staff, but the record of each person accepting stays the same as today. |
| **SS11** | **Where people start SSO** | (a) a button "Sign in with your company account" on the sign-in page, asking for the email and using its domain; (b) also a link `/sso?domain=acme.com` the company can put in its portal | **Both.** No Fortress endpoint says which domains use SSO, so we don't list our customers. `signInWithSSO({ domain })` answers itself, and its "no provider" error becomes "Your company has not set up single sign-on with Fortress". The password form, given an email at a domain where SSO is required, sends the person to SSO instead of failing later. |
| **SS12** | **Who manages it** | — | The existing **`security.read` / `security.manage`** (owner, admin), on a new **Single sign-on** card in Settings → Security. Moving people across (SS5) needs `members.manage`. Every change is audited, and changes of mode or provider are told to every owner and admin (no actor, emailed), as with the network policy. |

## 5. Data model (sketch; tenant tables, RLS, audit, functions only)

- **`organisation_settings`** gains:
  - `sso_mode` (`off | optional | required`);
  - `sso_join` (`invited | domain`), `sso_default_role_id`, `sso_default_department_id`;
  - `sso_trust_idp_mfa` (default true);
  - `sso_mode_changed_at` / `_by`.
- **`organisation_sso_domains`:**
  - `domain`: lower-case, **unique across Fortress** while not removed;
  - `verification_token`, `verified_at`, `last_checked_at`, `check_failed_at`;
  - removed with a reason, never deleted.
- **`organisation_sso_providers`:** one active per organisation.
  - `supabase_provider_id` (uuid), `entity_id`, `metadata_url` or `metadata_xml_sha256` (the XML itself is kept by Supabase);
  - `attribute_mapping`;
  - status `draft | active | disabled | failed`, `last_error`, `last_synced_at`.
- **`sso_break_glass_members`:** at most three; owners or admins only.
- **`sso_sign_ins`:** one row per organisation, person, hour and method (sso / break_glass), with a count. Kept 90 days, read with `security.read`.
- **`sso_account_moves`:** from user, to user, organisation, who confirmed, what was moved (counts per kind). Frozen.
- **`profiles.moved_to`**.
- **Functions:**
  - `app.sso_satisfied(org)` = mode is not required, or `amr` has `sso/saml` with this organisation's provider id, or a break-glass member at `aal2`. It is used **next to `app.mfa_satisfied`** in the membership helpers.
  - `app.mfa_satisfied` also accepts an SSO session when `sso_trust_idp_mfa` is on.
  - `app.move_member_to_sso_account(old_user, new_user, org)` works from a column list kept in one SQL function (`app.user_reference_columns()`). The drift test reads it.
  - Errors: new `QM030` → `409 sso_rule`.

## 6. API

- `GET /security/sso` (`security.read`) returns:
  - the mode, domains with their verification state and the TXT record to add;
  - the provider with its status;
  - the values the company's IT needs (EntityID, ACS URL, metadata URL);
  - break-glass members, joining settings, recent SSO sign-ins.
- Routes needing `security.manage`:
  - `POST /security/sso/domains`, `POST /security/sso/domains/{id}/verify|remove`;
  - `PUT /security/sso/provider {metadataUrl | metadataXml}` (creates or updates it in Supabase through `SupabaseSsoAdmin`; `503 sso_unavailable` without the management token), `POST …/provider/disable`;
  - `PUT /security/sso/mode {mode, confirm}`;
  - `PUT /security/sso/joining`;
  - `PUT /security/sso/break-glass`.
- `GET /me` memberships carry `sso { mode, satisfied }`. The guard answers `403 sso_required`, and `apiFetch` raises `qms:sso-required`.
- Moving an account across:
  - `GET /members/sso-matches` lists SSO users whose email matches a password member;
  - `POST /members/{id}/move-to-sso {userId}` (`members.manage`) does the move;
  - `POST /me/move-to-sso {password}` lets the person do it themselves with the old password.
- The worker step `housekeeping` re-checks verified domains weekly and purges old sign-in rows.
- `GET /platform/sso` lists every organisation's providers and failures, never metadata. `POST /platform/organisations/{id}/recover-sso` handles operator recovery.

## 7. Screens

- **Sign-in page:** "Sign in with your company account" (email → domain → `signInWithSSO`). The password form detects an SSO-required domain. `/sso?domain=` handles portal bookmarks. `/auth/callback` exchanges the code, then shows **first sign-in** (names if missing, terms) and **pending invitations**.
- **Settings → Security → Single sign-on:**
  - steps in order: add and verify the domain (TXT record shown, Check now), give IT the values (copy buttons, metadata download), paste their metadata URL or upload the XML, **Test sign-in** in a new tab;
  - mode Off / Optional / Required, with the confirmations of SS6;
  - joining, break-glass members, recent SSO sign-ins.
- **Settings → Users:** an "SSO" badge on members who signed in through it, and **Matches to move across** with Move / Not the same person.
- **Blocked screen** (like `NetworkBlocked`): "Acme requires you to sign in with your company account", with a **Sign in with SSO** button.
- **`/platform`:** an SSO tab with providers, failures and recovery.

## 8. Slices

| Slice | Content |
|---|---|
| **SS0 spike** | Upgrade check, done by you: the Supabase project must be on Pro or above, with SAML switched on. Then: (1) does a fine-grained token limited to SSO configuration on one project exist (SS2)? (2) register a test identity provider, a free SAML test IdP or a Microsoft Entra test tenant, and look at a real token: `amr`, `aal`, `user_metadata`, what `signInWithSSO` returns for an unknown domain; (3) can one domain be linked to two providers? Results written into this plan before SS1. |
| **SS1** | Migration: settings, domains (with DNS verification in the API), providers table, sign-in rows, `app.sso_satisfied` (not yet used), errors; Settings → Security card with domain steps. |
| **SS2** | `SupabaseSsoAdmin` (Management API: create / update / disable), provider form, IT values, attribute mapping; sign-in button, `/sso`, `/auth/callback`, first sign-in page (names, terms), accepting invitations. |
| **SS3** | Enforcement: modes, `app.sso_satisfied` in the membership helpers, SS7 two-factor trust, break-glass, `403 sso_required` + blocked screen, session-age default, notices to owners, operator recovery. |
| **SS4** | Joining on first sign-in (SS4 b), moving password members across (SS5) with the user-column drift test, "SSO" badges and matches on Settings → Users. |
| **SSX** | Exit check: live guardrails and advisors, a **journey step** (the journey's fake Supabase gains `signInWithSSO` and a fake identity provider: set up, verify domain, test sign-in, require, password refused, break-glass in, move a member across), real sign-in against the SS0 test IdP on the Dev deployment, `docs/sso-exit-report.md`. |

## 9. Tests that make it safe

- **SQL:**
  - another organisation's provider in `amr` does **not** satisfy `app.sso_satisfied`;
  - a password session is refused while required, and a break-glass member at `aal1` too (only `aal2` passes);
  - a domain cannot be claimed twice;
  - an unverified domain is never linked to Supabase;
  - the move function moves every classified column and nothing finished;
  - mutants for each rule.
- **API e2e:**
  - `403 sso_required` on every organisation route (the tenancy sweep);
  - a token with the provider listed first or later in `amr` (the documented caveat);
  - the Management API stubbed, and failures shown as `failed` with the reason;
  - DNS answers injected (no network), as the REST connector's tests do.
- **Frontend:** the sign-in paths, the blocked screen, the set-up steps, optimistic switches.
- **Drift test:** a new column that names a user fails until it is listed as moved or history.

## 10. What you need to do or decide

1. Agree or change SS1–SS12.
2. **Supabase plan:** SAML needs Pro or above, and charges $0.015 per SSO user per month above the plan's quota. Check the project's plan, then switch on SAML 2.0 in the dashboard (Authentication → Providers).
3. **For SS0:** a test identity provider. A free Microsoft Entra test tenant is closest to what customers use.
4. **Later, for SS2:** a Supabase management token, set as `SUPABASE_MANAGEMENT_TOKEN` on the API in Vercel only, never in the repository or the browser.

## 11. Not in this plan

- OIDC providers.
- Roles from the company's groups (needs `array` attribute mapping and a reviewed mapping screen).
- Automatic member removal (SCIM).
- Single logout.
- SSO for the platform operator panel.
- Signing in to several organisations' providers in one session (a person in two SSO organisations signs in to each in turn).
- Per-site providers.
