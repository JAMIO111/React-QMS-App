# Single sign-on (SAML) — plan

**Status:** agreed 2026-11-16 (SS1–SS12 as recommended) · **SS0 done as far as it can be without a paid plan** (§12; the live sign-in check waits for Pro) · **SS1 done** (migration `20260316100000_sso_domains.sql`, §13; applied live 2026-11-16) · **SS2 done** (migration `20260317100000_sso_providers.sql`, §14; applied live 2026-11-16) · **SS3 done** (migration `20260318100000_sso_enforcement.sql`, §15; applied live 2026-11-16) · **SS4 built** (migration `20260319100000_sso_joining_and_moves.sql`, §16; not yet applied live) · **Brief:** `docs/design-brief.md` §12 Phase 7 ("SSO and enterprise identity"), §5 (security), §14 (definition of done), §15 (non-goals) · **Builds on:** `docs/security-plan.md` (network policy, allowed email domains, maximum session age, operator recovery)

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
| Domain shared by two providers | Not documented; **the Auth server refuses it** (unique index on `lower(domain)`, §12). | Fortress keeps domains unique itself too (SS3), so the refusal is never what a customer sees. |

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
| **SS2** | **Who registers the provider with Supabase** | (a) the platform operator by CLI when a customer asks; (b) **self-service**: the organisation's owner or admin fills in the form, and the API calls the Management API with a token held only as a server variable (`SUPABASE_MANAGEMENT_TOKEN`); (c) like (b), but each new provider waits for an operator's approval on `/platform` | **(b), with a scoped token** (§12: Supabase personal access tokens can be limited to one project and one permission, **Auth Config: Read-write**, which covers creating, updating and deleting SSO providers). Either way the token never reaches the browser or the database, and every call is recorded. (a) does not scale and puts a person in every sale. |
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
| **SS1** | Migration: settings, domains (with DNS verification in the API), errors; Settings → Security card with domain steps. (The providers table moved to SS2, the sign-in rows and `app.sso_satisfied` to SS3, where they are first used.) |
| **SS2** | `SupabaseSsoAdmin` (Management API: create / update / disable), provider form, IT values, attribute mapping; sign-in button, `/sso`, `/auth/callback`, first sign-in page (names, terms). (Invitations reach SSO people through the existing invitation list on Start your organisation; the invitation email that sends people to `/sso` belongs with the modes in SS3.) |
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

## 12. SS0 result (2026-11-16)

Found from the documentation and from **the Supabase Auth server's source** (`github.com/supabase/auth`, commit `387e91f`, 2026-11-16), not yet from a live sign-in.

| Question | Answer | Where it came from |
|---|---|---|
| Is the project on a plan with SAML? | **No.** The organisation (JDigital) is on the **free plan**. SAML needs **Pro or above**. | Supabase organisation details |
| Can the management token be narrow? | **Yes.** A personal access token can be limited to chosen organisations, projects and permissions. Tokens made in the dashboard are scoped by default; full-access ones are marked "Legacy". **Auth Config: Read-write** covers "Create / Update / Delete a SSO provider". The page says nothing about expiry. | `supabase.com/docs/guides/platform/personal-access-tokens` |
| Two-factor level of a SAML sign-in | **`aal1`.** Only TOTP, phone, WebAuthn and recovery codes count as second factors (`IsAAL2Claim`, `internal/models/amr.go`). An SSO user can still add Fortress two-factor and reach `aal2`. | Source |
| What `amr` holds | Every method used in the session, **most recent first**. A SAML entry carries `provider` = the provider's uuid, because an SSO user has exactly one identity, `sso:<uuid>` (`CalculateAALAndAMR`, `internal/models/sessions.go`). **Check the whole array, never only the first entry.** | Source |
| One domain on two providers | **Refused**: `create unique index sso_domains_domain_idx on sso_domains (lower(domain))`. | Source, migration `20221021082433_add_saml` |
| Unknown domain | `signInWithSSO({ domain })` answers **404 `sso_provider_not_found`**, "No SSO provider assigned for this domain". It reveals only whether *some* provider has that domain, so the sign-in page shows one message for both cases. | Source, `internal/api/sso.go` |
| Linking | An SSO user is marked `is_sso_user` and is **never** found by email for password sign-in, recovery or linking. Two users with one email is the normal state, as SS5 assumes. | Source, `internal/models/user.go` |

**Consequences for the build:**

- **Anything that looks a person up by email must handle two users with one address.** That covers:
  - `app.accept_invitation` (it reads the signed-in user's own email, which is fine);
  - the invitation mailer: for an organisation that requires SSO it must send a plain link to `/sso`, never a Supabase password invitation;
  - the employee login-candidate list;
  - any other `auth.users` email lookup.
  
  SS2 lists and tests each one.
- **SS7 is needed**, because a SAML session alone never reaches `aal2`.
- **Testing without the paid plan:** the Auth server is open source, builds with the Go already in this container, and runs against the local test Postgres with SAML switched on. The SS2 and SS3 tests can drive a **real Supabase Auth server and a local test identity provider**, instead of a fake, to get real tokens. The live check on the Dev deployment still needs Pro.

**Still to do once the project is on Pro:** switch on SAML, register a test identity provider (a free Microsoft Entra test tenant), sign in, and confirm the token matches the table above. That is the first step of SSX if it has not happened earlier.

## 13. SS1 as built (migration `20260316100000_sso_domains.sql`)

- **Settings.** `organisation_settings` gains the SSO settings:
  - `sso_mode` (off, the default);
  - `sso_join` (invited);
  - `sso_default_role_id`, `sso_default_department_id` (composite foreign key to the organisation's departments);
  - `sso_trust_idp_mfa` (true);
  - `sso_mode_changed_at` / `_by`.
  
  Nothing changes them yet, and they are not in the column UPDATE grant. SS3 adds the functions.
- **`organisation_sso_domains`:**
  - one row per claim;
  - `verification_token` is 32 hex characters made by the database. It is never chosen by the caller, so another organisation's public record can never prove a claim;
  - `verified_at` / `_by`, `last_checked_at`, `check_failed_at`, `check_error`;
  - removed with a reason, never deleted;
  - the domain and its token never change (trigger);
  - audited, RLS `security.read`, no table writes;
  - unique indexes: one live claim per organisation and domain, and **one verified claim of a domain across Fortress**.
- **Functions:**
  - `app.add_sso_domain(org, domain)` and `app.remove_sso_domain(id, reason)` need `security.manage`. A domain must pass `app.normalise_email_domain`, at most 20 per organisation, and must not be held by another organisation. While allowed email domains are set, it must be one of them or a sub-domain of one. Removing also takes away the verification.
  - API login only:
    - `app.system_sso_domain_check(id, found, error, checked_by)` returns verified / unverified / failed (verified before, now missing: flagged, still verified) / refused. It locks every claim of the domain, so two organisations cannot both verify.
    - `app.system_sso_domains_due(limit)` lists verified domains not checked for 7 days.
  - Errors: **`QM030` → `409 sso_rule`**.
- **API** (`api/src/sso/`):
  - `GET /security/sso` (`security.read`) returns the mode, join, two-factor trust, allowed email domains, and the domains with state verified / unverified / failing / removed and the record to publish `{type: TXT, name, value: fortress-verification=<token>}`.
  - `POST /security/sso/domains {domain}`, `POST …/domains/{id}/verify` (returns `check.outcome`) and `POST …/domains/{id}/remove {reason}` need `security.manage`.
  - The TXT lookup is `DnsTxtResolver` (`SystemDnsTxtResolver`: system resolver, 4 s, 2 tries; tests swap in a fake). `checkVerificationRecord` matches the whole value ignoring case and surrounding spaces, and never throws.
  - Worker step **`sso-domains`** re-checks up to 10 due domains each tick.
- **UI:** `Settings/SingleSignOn.jsx`, the **Single sign-on** card on Settings → Security:
  - domains with a state pill;
  - the record to add, with Copy buttons (the shared `ui/CopyButton.jsx`, moved from the agent dialogs);
  - **Check now**, with a toast saying what was found;
  - a "…" menu → Remove with a reason (optimistic);
  - removed domains folded away;
  - read-only without `security.manage`.
  
  Hooks `useSso` / `useSsoMutation` (`useSecurity.js`); words `SSO_DOMAIN_STATES`, `ssoCheckWords` (`lib/security.js`).
- **Tests:**
  - `supabase/tests/sso_domains.test.sql`, plus a tenancy sweep seed and the guardrails list;
  - `api/src/sso/dns-txt.spec.ts`;
  - `api/test/sso.e2e-spec.ts` (fake DNS), plus the API sweep and the worker test's step list;
  - `SingleSignOn.test.jsx`.

## 14. SS2 as built (migration `20260317100000_sso_providers.sql`)

- **`organisation_sso_providers`.**
  - Columns:
    - `supabase_provider_id` (the provider's id in Supabase Auth, unique), `entity_id`;
    - `metadata_url` (https) **or** `metadata_sha256` (when a file was uploaded; the XML itself stays with Supabase);
    - `status` active | disabled, `domains` (as last sent to Supabase), `last_synced_at`, `last_error`;
    - `disabled_at` / `_by` / `_reason`.
  - At most one active per organisation; disabled ones are kept, never changed, never deleted.
  - Audited, RLS `security.read`, and **no writes but the API login's**:
    - `app.system_sso_save_provider` (new, or new metadata for the active one);
    - `app.system_sso_provider_synced` (a failed sync keeps the last good domains and the error);
    - `app.system_sso_disable_provider` (needs a reason);
    - `app.system_sso_provider_state` (the provider, the domains last sent, the domains verified now and the last error);
    - `app.sso_verified_domains`.
- **`app.handle_new_user`** now also reads `given_name` / `family_name` / `name` from a company sign-in. A full name is split at the first space, and our sign-up form's `first_name` / `surname` still win.
- **`app.accept_terms(version)`** writes only the signed-in person's own profile.
- **API:**
  - `SupabaseSsoAdmin` (`api/src/sso/supabase-sso-admin.ts`; `ManagementApiSsoAdmin` calls `POST/PUT/DELETE https://api.supabase.com/v1/projects/{ref}/config/auth/sso/providers[/{id}]` with **`SUPABASE_MANAGEMENT_TOKEN`**). The project ref comes from `SUPABASE_URL` or `SUPABASE_PROJECT_REF`. `ATTRIBUTE_MAPPING` asks for given name, surname and display name under the usual SAML names, never Entra's `…/claims/name`, which is the sign-in address.
  - `PUT /security/sso/provider {metadataUrl | metadataXml}` needs a verified domain. A refusal from Supabase answers `409 sso_rule` "Supabase did not accept it: …". If the database cannot record the provider, the new one is taken back out of Supabase.
  - `POST /security/sso/provider/disable {reason}` removes it from Supabase, so its domains are free again.
  - `503 sso_unavailable` without the token.
  - Verifying or removing a domain sends the verified list to Supabase when it changed, or when the last sync failed.
  - `GET /security/sso` adds `available`, `serviceProvider` (entity ID, ACS, metadata addresses), `provider` and `previousProviders`.
  - `/me` profile carries `termsAcceptedAt` / `termsVersion`, and there is `POST /me/terms {version}`.
- **UI:**
  - The Single sign-on card's second half (`Settings/SsoProvider.jsx`): the values for IT with Copy buttons and Fortress's metadata download; **Connect your sign-in** (an address or a file; a file that is not SAML metadata is refused in the browser); the connected sign-in with **Test sign-in** (`/sso?provider=<id>` in a new tab), **Replace metadata** and **Disconnect** (reason); earlier connections; a sync problem shown.
  - **Sign in with your company account** on the sign-in page leads to `/sso` (`auth/SsoSignIn.jsx`: work email → its domain; `?domain=` and `?provider=` start at once; "has not set up single sign-on" in words).
  - `/auth/callback` (`auth/AuthCallback.jsx`) waits for the session the client reads from the address, then goes on.
  - **First company sign-in** (`auth/FirstSignIn.jsx`, from `ProtectedRoute` when the account's identity is `sso:…` and no terms are recorded) asks for the terms, and for a name when the company sent none.
  - Helpers `lib/sso.js`; `ui/CopyButton.jsx`; `ExternalLinkIcon`.
- **Tests:**
  - `supabase/tests/sso_providers.test.sql`, plus a tenancy sweep seed and the guardrails list;
  - `api/test/sso.e2e-spec.ts` (fake Management API; provider, domain sync, disable, terms), `supabase-sso-admin.spec.ts`, and the API sweep allowlist for `POST /me/terms`;
  - `SingleSignOn.test.jsx`, `SingleSignOnPages.test.jsx`, `lib/sso.test.js`.
- **Not checked live:** the real Management API and a real sign-in both wait for the Pro plan. The fake follows Supabase's documented request and response shapes.

## 15. SS3 as built (migration `20260318100000_sso_enforcement.sql`)

- **Where it is enforced.** `app.mfa_satisfied(org)`, which every membership and permission helper already calls, is now **two-factor satisfied AND
  single sign-on satisfied**, so RLS, the API guard, storage and every function follow it without touching the helpers.
  - Two-factor: `aal2`, or not required, or (`sso_trust_idp_mfa` and a session through **this organisation's active provider**) (SS7).
  - Single sign-on: the mode is not required, or the session came through this organisation's provider, or a **break-glass member at `aal2`**
    (never a password alone), or the token has **no `amr`** at all.
  - "This organisation's provider" = an `amr` entry with method `sso/saml` and `provider` = the active provider's Supabase id, found **anywhere
    in the array** (`app.sso_session_for`). Another organisation's provider, a disabled one, or an entry without a provider id never counts.
  - **Why no `amr` is exempt:** every token Supabase issues carries `amr`; the system work that acts for a person (email fan-out, reminders,
    workflows, scorecards, imports, agents) sets only `sub`, `role` and `aal`, and must not be refused. Over HTTP such a token still meets the
    12-hour session limit (its sign-in time is unknown, so it is asked to sign in again).
  - The halves are also `app.two_factor_satisfied` and `app.sso_satisfied`. `app.mfa_blocked_organisations` lists only organisations where
    two-factor is what blocks; **`app.sso_blocked_organisations`** lists those where single sign-on does, with the provider id and whether the
    caller is break-glass.
- **Modes** through `app.set_sso_mode(org, mode)` (`security.manage`): optional and required need an active provider with a domain sent to
  Supabase; **required needs the request to come through that provider now**. While required:
  - the session limit is **12 hours** unless one is stored (`app.max_session_hours`; the stored setting wins) (SS9);
  - invitations only to addresses at the verified single sign-on domains or their sub-domains (trigger, `QM015`);
  - (and while not off) a verified domain cannot be removed and the provider cannot be disconnected: switch it off first (the API checks
    before it touches Supabase).
  - Off vs optional: a company sign-in through a connected provider is accepted in both; the difference is what the organisation tells and
    sends people (invitations below). Disconnecting the provider is the switch that stops company sign-ins.
- **Two-factor trust** through `app.set_sso_trust_idp_mfa` (refused when switching it off would lock the caller out). `app.guard_require_mfa`
  now also accepts a trusted company sign-in when two-factor is switched on.
- **Break-glass** (`sso_break_glass_members`, replaced as a whole by `app.set_sso_break_glass`): at most three, organisation-wide owners or
  admins, checked again at every request (someone who stops being an owner or admin stops being break-glass). Ended, never deleted.
- **Sign-ins** (`sso_sign_ins`): one row per organisation, person, method (`sso` | `break_glass`) and hour with a count, written by the API login
  (`app.system_record_sso_sign_in`, called by the guard once an hour per process); the first break-glass use of an hour is a change, so owners
  and admins are told. Kept 90 days (worker housekeeping).
- **History and notices** (`sso_changes`): mode, two-factor trust, break-glass list, each break-glass use and an operator's recovery; frozen,
  audited, `security.read`; notice `sso_changes.created` to owners and admins **with no actor** (so the person who changed it is told too),
  emailed by default. `app.emit_notification` = the `20260303100000` version + `sso_changes` in the no-actor list — **the latest definition**.
- **Recovery:** `app.platform_recover_sso(org, reason, verification)` (operator with MFA): required → optional, never off, the provider kept.
  `app.platform_sso_modes(orgs)` for the panel.
- **Password members:** `app.sso_password_members(org)` (`security.read`; members whose account is not `is_sso_user`), shown before requiring:
  they are blocked unless break-glass, and (until SS4 moves them across) need inviting again with their company address.
- **API:**
  - The guard answers **`403 sso_required`** `{ providerId, breakGlass }` before checking two-factor, and records company / break-glass sign-ins.
  - `PUT /security/sso/mode {mode, confirm}` (`confirm: true` for required), `PUT /security/sso/two-factor {trust}`,
    `PUT /security/sso/break-glass {userIds}`; `GET /security/sso` adds `modeChangedAt/By`, `session {viaSso, aal}`, `requireMfa`,
    `sessionHours {stored, effective}`, `breakGlass`, `passwordMembers`, `signIns` (30 days), `changes` (last 20).
  - `/me` has `sso.requiredBy` (id, name, providerId, breakGlass); those organisations are left out of `memberships`.
  - `POST /platform/organisations/{id}/recover-sso`; platform organisations carry `sso {mode, connected}`.
  - **Invitations** to an address at the organisation's single sign-on domains, while not off, are **never Supabase password invitations**
    (they would make a password account beside the company one): `InvitationMailer.sendCompanySignIn` emails a link to `/sso?domain=…` through
    the mail provider (`MAIL_PROVIDER`), else nothing is sent (`reason: company_sign_in`) and the invitation waits for them.
- **UI:**
  - `Settings/SsoMode.jsx` on the Single sign-on card: Off / Optional / Required (required asks for the typed word "require", lists who will be
    blocked, warns when nobody is break-glass, and from a password session offers **Sign in with your company account** instead), the 12-hour
    note, the two-factor switch (optimistic), break-glass members (owners and admins with a password; optimistic), recent sign-ins and the history.
    Disconnect and Remove (verified domain) are switched off while single sign-on is in use.
  - `SsoRequired.jsx`: the blocked screen ("Acme requires your company sign-in", **Sign in with your company account**, **Use two-factor instead**
    for a break-glass member, Sign out), from `ProtectedRoute` when every organisation requires it, and in `App.jsx` on `qms:sso-required`
    (raised by `apiFetch` on `403 sso_required`).
  - The operator panel's organisations tab has a Single sign-on column with **Make optional** (`RecoverAccessDialog kind="sso"`).
- **Tests:** `supabase/tests/sso_enforcement.test.sql` (plus sweep seeds and the guardrails list), `api/test/sso.e2e-spec.ts` (SS3 block: tokens
  with `amr`), the API sweep allowlist for `recover-sso`, `invitation-mailer.service.spec.ts`, `SsoMode.test.jsx`, `SsoRequired.test.jsx`,
  `PlatformPanels.test.jsx`.
- **Not checked live:** a real company sign-in (the Pro plan). **Pushing the API before this migration breaks every organisation route** (the guard
  calls `app.sso_blocked_organisations` and `app.sso_session_method`) and `/me`.

## 16. SS4 as built (migration `20260319100000_sso_joining_and_moves.sql`)

- **Joining on the first company sign-in (SS4 b).** `app.set_sso_joining(org, invited|domain, role, department)` (`security.manage`): the role must
  be the organisation's **viewer or inspector**; the department is optional. `app.sso_joinable_organisations()` = organisations where this session
  came through their own provider, the address is at a verified domain, joining is on, single sign-on is not off, and there is no membership or
  waiting invitation (an invitation is accepted the usual way). `app.join_by_company_sign_in(org)` makes an active membership with the role (and
  the department as primary), **no seat**, and writes `sso_changes` kind `member_joined`, so owners and admins are told.
- **Every column that names a user is classified** in `app.user_reference_columns()`: `membership` (organisation_users: roles, departments, seat
  and 8D team places hang off the membership), `moved` (open work and standing responsibilities), `history` and `personal`. A column whose name ends
  in `_by` records who did something and is history unless listed as moved (`integration_import_settings.schedule_set_by`,
  `supplier_scorecard_schedules.set_by` are: they carry standing authority). **`supabase/tests/sso_joining_moves.test.sql` fails when a migration adds
  a column that refers to a user (a foreign key to `auth.users` / `profiles`, or a uuid named like one) and is not classified**, and when the list
  names a column that is gone (checked with a mutant: removing `gauges.custodian_id` fails it).
- **Moving a password member onto their company account (SS5).** `app.sso_do_account_move` checks one address (any case), the new account is a
  company account at a verified domain, the old one a password member here (active or suspended). It marks the company account's own membership (if
  it joined or accepted an invitation) removed, **re-points the old membership to the company account**, then moves the open work, each kind in its
  own sub-transaction so a record whose own rules refuse the change is left and reported (`skipped`), never half-done: employee link, expected
  auditor of audits in use, control plan owner, documents still to read / to review / to approve / to sign, document owner, gauge custodian, open
  review actions, attendees and chair of reviews not held, open NC owner, notification and reminder choices, quality alerts to acknowledge, objective
  owner, open risk actions, risk owner, saved filters, running SCAR owner, open tasks, schedule authorities. Finished records keep the old id.
  `sso_account_moves` keeps what moved (frozen, audited; `members.read` or either account); `sso_changes` kind `account_moved` tells owners and admins.
  - `app.move_member_to_sso_account(org, old, new)`: `members.manage` and `app.can_manage_membership`; never your own account.
  - `app.system_move_own_account(org, old, new)`: the API login only, after the API checked the old password (`PasswordVerifier`:
    `SupabasePasswordVerifier` asks Supabase Auth's password grant with the service key and closes the session the check opened; tests use a fake;
    `503 password_check_unavailable` without `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`).
  - `app.sso_member_matches(org)` (`members.manage`) = password members whose address is also a company account at a verified domain;
    `app.dismiss_sso_match` keeps "not the same person" in `sso_match_dismissals`; `app.my_sso_move_candidates()` for the person;
    `app.member_company_accounts(org)` for the "Company sign-in" mark.
- **API:** `PUT /security/sso/joining {join, roleId?, departmentId?}`; `GET /security/sso` adds `joining {roleId, departmentId, roleOptions}` and
  `moves`; `/me` `sso.joinable` and `sso.moveCandidates`; `POST /me/sso-join {organisationId}`, `POST /me/move-to-sso {organisationId, password}`
  (not organisation-scoped: the person is not yet a member; on the sweep allowlist); `GET /members/sso-matches`, `POST /members/sso-matches/dismiss
  {passwordUserId, ssoUserId}`, `POST /members/{id}/move-to-sso {userId}` (answers the member, `moved`, `skipped`); members carry `companyAccount`.
- **UI:** "Who can join" (Invited people only / Anyone at your domains, then They start as / In the department; optimistic) and "Accounts moved"
  in `Settings/SsoMode.jsx`; `CompanyAccountCards.jsx` on the Start your organisation page (**Join Acme**, and **Bring my account across** with the old
  password); `Settings/SsoMatches.jsx` on Settings → Users (**Move** with a confirmation, **Not the same person**; optimistic) and a **Company sign-in**
  mark on member cards.
- **Tests:** `supabase/tests/sso_joining_moves.test.sql` (+ sweep seeds, guardrails list), `api/test/sso.e2e-spec.ts` (SS4 block),
  `password-verifier.spec.ts`, the API sweep, `SsoMode.test.jsx`, `CompanyAccountCards.test.jsx`, `SettingsUsers.test.jsx`.
- **Not built:** a moved account's old name shown as "now signs in with SSO" on old records; moving 8D actions owned through a team member who is not
  the membership (external contacts); members whose sign-in has not been used for 90 days listed for review (SS9). **Pushing the API before this
  migration breaks `/me` and the member list** (they call the new functions).

