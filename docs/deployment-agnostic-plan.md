# Deployment-agnostic Fortress — Phase 0 audit and plan

Status: **Phase 0 report for review. Nothing has been changed in the product.** No code, migration or configuration was edited to produce it.
Source brief: `fortress-deployment-agnostic-design-brief.md` (supplied 2026-11-23). Repository state: `Dev` at `ccaa9da`.

How this was produced: static inspection of the repository (greps and reading source, counts taken from the files as they are today). **Nothing was run** against a
self-hosted stack, and no Docker image was built. Every "works on plain Postgres" statement below rests on the existing `npm run db:check` setup, which already applies
all 193 migrations to a throwaway local PostgreSQL 16 using stand-ins for the Supabase schemas (`supabase/tests/supabase_stubs.sql`). Where a claim needs a spike to confirm, it says so.

---

## 1. Short version

1. **Most of the product is already portable.** The API is a plain NestJS/Node service, the frontend is a static Vite build, the data is plain PostgreSQL 16 (no Supabase-only
   extensions in the schema; `pgcrypto` functions are not used), and the whole migration history already applies to a local Postgres in CI-style checks.
2. **The Supabase coupling is concentrated in five places**, and each is a bounded piece of work: **Auth** (the hard one), **Storage**, **Vault** (integration credentials),
   **pg_cron/pg_net** (the worker's clock) and **Supabase-specific HTTP calls in the API** (invitations, SSO, password check, file links).
3. **Vercel coupling is small:** `vercel.json` crons, one `waitUntil` import, response headers in `vercel.json`, and the entry-file convention. There is no Dockerfile and no
   reverse-proxy configuration yet; those are new work, not refactoring.
4. **The brief's assumptions differ from the repository in ways that change the plan** (§2). The two that matter most: business logic lives **in PostgreSQL** (1,242 `SECURITY DEFINER`
   definitions, 343 policies, 569 triggers), so "move business-critical operations into NestJS" must not be taken literally; and the **supplier/customer portal already exists inside the
   product**, so the brief's separate shared portal is a new build beside it, not a refactor of it.
5. **Recommended direction:** keep Postgres as the home of the rules; make Supabase's `auth`, `storage` and `vault` schemas a *documented compatibility contract* rather than a hosting
   dependency; put the five coupled areas behind ports; **spike a self-hosted GoTrue (Supabase Auth) before choosing any other identity provider**. Details and alternatives in §7.
6. **Seven decisions need you** (§10) before Phase 1, the most important being identity (§7.1) and whether the on-prem portal is a separate service at all in the first release (§7.7).

---

## 2. Where the brief and the repository disagree

| Brief says | Repository says | Consequence |
|---|---|---|
| PostgreSQL "accessed through Drizzle ORM" (§2, §6.1) | `drizzle-orm` is a dependency and wraps the connection (`DatabaseService.asUser`), but queries are almost all raw SQL: ~435 `db.execute(`, 58 `client.query(`, 2,062 `sql` template uses, against 81 query-builder calls. `src/database/schema.ts` is 204 lines for ~309 tables. **The SQL migrations are the schema source of truth**, not Drizzle. | There is no ORM migration path to lean on or to port. Portability work is about the SQL and the roles, not about Drizzle. |
| "Move business-critical operations into the NestJS API where appropriate; remove reliance on Supabase-only database behaviour" (§6.1) | The product is deliberately Postgres-first (`docs/design-brief.md`: RLS plus `SECURITY DEFINER` functions, append-only audit, transactional outbox). 1,242 `SECURITY DEFINER` definitions, 1,475 function definitions, 343 policies, 569 triggers, 53,075 lines of migrations. | Moving the rules into NestJS would be a rewrite of the product, which the brief itself forbids (§14). **Recommendation: keep Postgres as the home of the rules** (it is the one thing common to all three deployment models) and remove only what is *Supabase-hosted* rather than *Postgres*. Needs your confirmation (§10, D2). |
| Supabase "authentication and file storage"; Vercel hosting | Also: **MFA, SAML single sign-on, password grant, admin invite links and storage signing** are Supabase HTTP APIs called by the API; **`auth.users` is referenced by 599 foreign keys**; **Vault** holds integration credentials; **pg_cron + pg_net** run the worker. | Auth is a data-model dependency (identity table), not just a login screen. See §7.1. |
| The portal is "a shared cloud-hosted service" separate from the QMS | The portal is built (PT1–PT6) **inside** the same API and database, as `portal_*` tables and curated `SECURITY DEFINER` views (`app.portal_get_ncr` etc.), for people with no membership in the organisation. | For cloud customers nothing needs to change. For on-premises, the portal cannot live in the customer's database (their database is not reachable from the internet), so a *second* deployment of portal-facing data is needed. See §7.7. |
| A new "Fortress Connect / Sync Agent" | A **Fortress Connector Agent** already exists (`connector-agent/`, .NET, outbound-only, signed requests, jobs, resumable batches, updates, MSI). It moves data **from the customer's systems into Fortress** (databases, folders, internal APIs). | Different job, same hard problems (outbound-only, signed polling, replay protection, key rotation, updates). Reuse the *protocol and guard patterns*; decide whether the new agent is the same binary (§10, D6). Naming will collide: suggest "Fortress Connect" only for the portal sync. |
| PWA is a Phase 4 deliverable | Already partly done: `public/manifest.webmanifest`, icons, `public/sw.js` registered **in production builds only**, offline page, no API answers cached. | Phase 4's PWA item reduces to verifying installability on a LAN/internal HTTPS origin. |
| Docker Compose as the first on-premises mechanism | No Dockerfile, no Compose file, no reverse-proxy config, and **no CI for the main app** (the only workflow is `connector-agent.yml`). | Containerisation and a CI matrix are new work (Phase 2). |
| Project path `C:\Dev\...` | Work is in `/home/user/React-QMS-App`. | Nothing to do; no path is hard-coded. |

---

## 3. Current-state architecture

```
Browser (Vite + React 19, static)
  ├── supabase-js ──► Supabase Auth  (sign-in, MFA, SSO, sessions, password reset, verifyOtp)       [15 files]
  ├── supabase-js ──► Supabase Storage (avatars; uploads to API-signed URLs)                         [6 call sites]
  └── fetch ────────► NestJS API  /api/v1   (all business data; JWT from Supabase Auth)

NestJS API (Node, one process; Vercel Function today)
  ├── verifies JWT with jose (JWKS or legacy HS256 secret)           → src/auth/jwt-verifier.service.ts
  ├── DatabaseService.asUser(): one transaction as role `authenticated`,
  │     claims in `request.jwt.claims` ⇒ RLS + auth.uid() + audit apply
  ├── calls Supabase: Auth admin (invite, generate_link, otp, token grant, SAML), Management API (SSO providers),
  │     Storage (sign, download, remove)
  ├── calls others: Stripe, Resend, Frankfurter (rates), DNS TXT (SSO domains)
  └── worker tick, crons: HTTP endpoints, called by pg_cron/pg_net (every minute) and Vercel Cron (daily)

PostgreSQL 16 (Supabase-managed today)
  ├── public / app / audit schemas: ~309 tables, RLS everywhere, functions + triggers hold the rules
  ├── auth schema (Supabase): users, JWT helpers auth.uid()/auth.jwt()/auth.role()
  ├── storage schema (Supabase): buckets, objects + policies
  ├── vault schema (Supabase): integration credentials
  └── extensions: pg_cron, pg_net (worker clock only)

Connector Agent (Windows service, .NET, customer network, outbound only) ──► API (signed requests)
```

Tenancy: `organisation_id` on every business table, RLS with `app.is_member` / `app.has_permission`, server-side check in `OrganisationGuard`. External portal people are not members
and see only curated functions. All of this is independent of hosting.

---

## 4. Dependency map

"Effort" is a rough relative size for the *adapter work*, not for rebuilding the feature: S = days, M = 1–2 weeks, L = several weeks, XL = a project in itself.

### 4.1 Database

| Dependency | Where | Evidence | Portable? | Effort |
|---|---|---|---|---|
| Plain PostgreSQL 16 features (`NULLS NOT DISTINCT` (needs 15+), `SKIP LOCKED`, `jsonb_path_query`, generated columns, advisory locks) | migrations | counts: 2 / 10 / 1 / 8 / 5 | Yes — Postgres 15+ (the check cluster is 16) | none |
| Roles `anon`, `authenticated`, `service_role`, login `qms_api` | 193 migrations (1,209 `authenticated`, 465 `anon`, 48 `qms_api`, 13 `service_role`) | `20251103120000_api_role.sql` | Yes — plain roles; the test stubs create the three Supabase ones on stock Postgres | S (script role creation) |
| `auth` schema: `auth.users`, `auth.uid()`, `auth.jwt()`, `auth.role()` | 599 `REFERENCES auth.users`, 645 mentions, 825 `auth.uid()`; triggers `on_auth_user_created`, `on_auth_user_signup`, `on_auth_user_verified` on `auth.users`; member directory reads `email`, `email_confirmed_at`, `invited_at`, `raw_user_meta_data`, `last_sign_in_at` | `tenancy_core`, `onboarding_accounts`, many | **Not by itself** — a contract is needed (§7.1) | L–XL |
| `storage` schema: `storage.buckets`, `storage.objects` + policies | 17 migrations, 61 + 28 references | `storage_through_api.sql` (`app.storage_file_allowed` is the one rule) | Via a compatibility schema (as the tests already do) or refactor | M |
| `vault` schema (`vault.create_secret`, `vault.decrypted_secrets`) | `integrations_core`, `integration_oauth_client` | only the API login can read | Replaceable (§7.4) | M |
| `pg_cron`, `pg_net` | `supabase/runbooks/worker-schedule.sql` (not a migration) | they only call `POST /internal/worker/tick` | Yes — any scheduler can call the same endpoint | S |
| `pgcrypto`/`uuid-ossp` | none used (`gen_random_uuid()` is built in) | grep found no `digest(`/`crypt(`/`hmac(` | Yes | none |
| Realtime publications | none | grep | n/a | none |

### 4.2 Authentication and identity

| Dependency | Where | Notes |
|---|---|---|
| Token verification | `api/src/auth/jwt-verifier.service.ts` (`jose`; JWKS from `SUPABASE_URL/auth/v1/.well-known/jwks.json` or HS256 `SUPABASE_JWT_SECRET`) | Already provider-neutral in shape: any issuer with a JWKS works (`JWT_ISSUER`, `JWT_AUDIENCE`). |
| Claims the database relies on | `sub`, `role`, `email`, `aal` (12 uses), `amr` (2 uses, the SSO check) | `app.session_aal()`, `app.mfa_satisfied`, the SSO-required rule. Any identity provider must emit equivalent claims. |
| Browser auth | 15 files import `supabase-client`: sign-in, sign-up, MFA enrol/challenge/unenrol, password reset/update, `verifyOtp` (email links), `signInWithSSO`, session refresh, `onAuthStateChange` | ~270 lines across `authService.js`, `AuthProvider.jsx`, `mfa.js`, `sso.js` plus the pages. |
| API → Supabase Auth | `members/invitation-mailer.service.ts` (`/auth/v1/invite`, `/admin/generate_link`, `/otp`), `sso/password-verifier.ts` (`/token?grant_type=password`, `/logout`), `sso/supabase-sso-admin.ts` (**Management API** `api.supabase.com`, SAML metadata) | The Management API is a Supabase *platform* service; it does not exist when self-hosting. |
| Email templates | `supabase/templates/*.html` (generated by `scripts/email-templates.cjs`) | Only used when no mail provider is configured; with `MAIL_PROVIDER=resend` the API sends its own mail and uses `generate_link`. |
| SAML SSO | Supabase Auth SAML (needs Pro on the hosted service); live check not yet done | Self-hosted GoTrue supports it; the *admin path* differs (§7.1). |

### 4.3 File storage

| Dependency | Where |
|---|---|
| Server: five separate Supabase Storage HTTP clients | `files/file-links.ts` (`FileLinkSigner`: sign download, sign upload, remove), `integrations/core/file-store.ts`, `measurement-imports/file-store.ts`, `documents/controlled-copy.ts` (`DocumentFileStore`), plus SSO/other callers that need the service key |
| Browser: Supabase upload protocol | `src/api/supabaseApi.js` (`uploadToSignedUrl` ×3) — the browser talks to Supabase Storage with a token the API signed |
| Browser: direct storage | `ModalImageUploader.jsx` (avatars/logos: `upload`, `remove`), `useSignedAvatarURL.jsx` (`createSignedUrl`) |
| Buckets | 14 private buckets named in code and migrations (`nc-files`, `calibration-files`, `capa-files`, `audit-files`, `quality-alert-files`, `supplier-files`, `integration-files`, `inspection-files`, `competence-files`, `document-files`, `scar-files`, `lot-evidence`, `org-logos`, `avatars`) |
| Authorisation | already centralised: `app.storage_file_allowed(bucket, name, write)` is called by both storage policies and the API; direct access can be refused while an organisation enforces network rules |

### 4.4 Email and notifications

`api/src/email/`: `MailTransport` abstraction with `none` (outbox only) and `resend`; `email_outbox` is durable, idempotent, retried, never mails a notice over a day old,
and shows failures on the operator panel. **A third adapter (SMTP) is the whole job here** (S). `waitUntil` from `@vercel/functions` in `email.service.ts` already degrades to a background promise elsewhere.
Auth emails (invite, confirm, reset) come from Supabase Auth unless the API sends its own (resend path), so self-hosted auth needs its own SMTP configuration (§7.1).

### 4.5 Scheduling and background work

The worker is already HTTP-driven (`POST /internal/worker/tick`, one tick at a time, leased, jobs with back-off), so **the clock is replaceable**: today `pg_cron` + `pg_net` every minute (production
address chosen in the runbook; **still to be checked against production**, see CLAUDE.md go-live item) and six daily Vercel crons in `api/vercel.json` as a safety net. On-premises needs an in-process timer
or a container cron calling the same endpoints (S). The tick address and `CRON_SECRET` sit in Vault in the hosted setup (runbook).

### 4.6 Hosting (Vercel)

| Item | Where | Replacement |
|---|---|---|
| Frontend static build with SPA rewrite and security headers (HSTS, frame, referrer, CSP report-only) | root `vercel.json` | A static server (nginx/Caddy) config carrying the same headers and rewrite |
| API as one Vercel Function, entry `api/src/main.ts`, region `lhr1`, six crons | `api/vercel.json`, `api/src/main.ts` | A normal Node process in a container (`main.ts` already calls `app.listen(PORT)`) |
| `waitUntil` | `email/email.service.ts` | already optional |
| `TRUST_PROXY_HOPS` (Vercel = 1) | `config/env.ts` | set per topology (documented in `security-exit-report.md`) |
| CORS origins incl. Vercel preview wildcard | `config/env.ts` | configured per deployment |
| Hosting notes | `docs/deployment-vercel.md` | itself says Vercel was a dev environment and production hosting "is a separate decision" |

### 4.7 External services

| Service | Used for | Offline/on-prem behaviour today |
|---|---|---|
| Stripe | billing, seats, checkout, portal, webhooks (`api/src/billing/`) | Billing is **cloud-only**; organisations that are not `billing_required` ignore it, but entitlement tables remain (§7.6) |
| Resend | email | `none` keeps an outbox; SMTP adapter to add |
| Frankfurter (exchange rates) | cost currency | `EXCHANGE_RATES=off` exists; `FRANKFURTER_URL` allows a self-hosted copy |
| DNS TXT | SSO domain proof | needs outbound DNS; irrelevant if SSO is local |
| Supabase Management API | SAML provider registration | **no equivalent self-hosted** — replace with GoTrue's own admin API or a different IdP flow |
| Stripe/Resend/Frankfurter hosts | outbound HTTPS | all are failure-tolerant and optional by env |

### 4.8 Existing features whose assumptions break on a private network (found while auditing)

1. **Network access policy (`organisation_networks`, security S1–S12).** It *refuses private ranges* (`10/8`, `172.16/12`, `192.168/16`, …) because "the server only ever sees public addresses".
   On an internal deployment the API sees LAN addresses, so this feature either needs a mode that accepts private ranges or must be off. Also `TRUST_PROXY_HOPS`/`X-Forwarded-For` assumptions.
2. **SSRF defence in `SafeHttpClient`** refuses private addresses by design (https, 443, public only). Correct for the cloud REST connector; on-premises, internal systems are reached through the Connector Agent, which already allows private addresses. No change needed, but it must be documented.
3. **Platform operator concepts** (`platform_admins`, `/platform`, MRR, webhooks panel) are SaaS-operator features; on-prem has no operator. They must be absent or inert without error.
4. **Onboarding and the billing gate** (`billing_required`, Stripe checkout step in the wizard) assume a paid cloud subscription; on-prem needs a licence-based path that satisfies the same checks (§7.6).
5. **Member invitation emails and "company sign-in" routing** call the Supabase Auth API directly.
6. **Time and sizing:** the API assumes a short round trip to the database (the dashboard speed work was tuned for same-region). A LAN is fine; a remote database is not tested.

### 4.9 Tests and tooling that already help

- `npm run db:check`: all migrations plus 167 SQL test files on a throwaway local Postgres 16 with Supabase stubs. This is the strongest asset: **database portability is already continuously tested** (on one version, with stubs).
- API e2e tests mint HS256 tokens locally (`api/test/helpers.ts`), so the API is already testable without Supabase Auth; the sweeps (`tenancy-sweep`, guardrails) will protect a refactor.
- `npm run journey`: the real app + real API + migrated throwaway Postgres, with a fake Supabase auth/REST and fake Stripe. It shows auth can be stood in for, which makes it a good vehicle for proving any replacement identity adapter.
- Gap: **no CI** runs any of this for the main app.

---

## 5. Findings by severity (migration risk register)

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Identity coupling.** 599 FKs and three triggers on `auth.users`; any non-GoTrue IdP means either re-creating `auth.users` semantics or a large live-data migration of every FK. | Certain if a new IdP is chosen | Very high (touches every table; live production data) | Treat `auth.users` as the internal identity contract (§7.1); prefer self-hosted GoTrue; if another IdP, **provision into an `auth.users`-shaped table** rather than changing FKs. No FK rewrite in this programme. |
| R2 | **MFA/SSO semantics tied to Supabase tokens** (`aal`, `amr` containing the provider id; `app.mfa_satisfied`; SSO-required mode; break-glass rule). A different IdP must emit equivalent claims or security guarantees silently weaken. | Medium | High (security) | Define the claim contract in the plan, add contract tests (token fixtures → expected `app.mfa_satisfied` results) before any adapter lands. |
| R3 | **Supabase-only APIs** (Management API for SAML, `generate_link`, token grant for password check, MFA enrol in the browser). | Certain | High | Isolate behind `IdentityProvider` and `IdentityAdmin` ports; the Supabase adapter stays as is for cloud. |
| R4 | **Frontend talks to Supabase directly** for auth and storage in 15 files / 6 call sites. | Certain | Medium | Introduce a small `auth` and `files` facade in `src/` first (no behaviour change); then swap its implementation by build/runtime config. |
| R5 | **Storage protocol leaks to the browser** (`uploadToSignedUrl`). A local filesystem adapter must offer an equivalent signed upload (or API-streamed upload) with the same file rules (size, content type, folder). | Certain | Medium | Neutral upload contract: `POST /files/upload-url` already returns `{ bucket, path, token, signedUrl }`; make the response provider-neutral and let the adapter decide. |
| R6 | **Vault** holds integration credentials and the cron secret. Re-encrypting is a data migration of secrets. | Certain | Medium | Port with two adapters; migrate by re-wrapping on first use; never log values. |
| R7 | **Business logic in 1,242 definitions**: a refactor to the API layer (as the brief's wording suggests) would rewrite the product and risk the audit/tenancy guarantees. | Only if D2 is answered "move" | Very high | Decide D2 now; recommended answer: keep. |
| R8 | **Portal architecture**: the existing portal reads curated functions in the *same* database as the QMS. A separate cloud portal for on-prem customers duplicates the publication, identity and attachment machinery. | Certain for on-prem | High | Decide scope of the first on-prem release (D5): ship on-prem *without* the portal first, or build the portal service in a later phase on top of the existing curated-view definitions. |
| R9 | **Licensing**: entitlements are driven by Stripe-backed tables (`organisation_subscriptions`, seats, packages), enforced in `app.has_permission`. On-prem needs a signed offline licence feeding the *same* checks. | Certain | High | Add a licence source behind the existing entitlement functions rather than a second enforcement path (§7.6). |
| R10 | **Upgrades and migrations on customer hardware.** 193 migrations are forward-only and written for a database already in place; they use `pg_temp.patch` text rewriting of live definitions. | Medium | High | An on-prem upgrade path must apply them in order, with a pre-upgrade backup and a refusal on unknown history; add a migration-version table independent of Supabase's `schema_migrations`. |
| R11 | **Network policy and "who is on my network"** features assume public addresses (§4.8). | Certain | Medium | Explicit `deployment mode` handling for these features; document unsupported ones. |
| R12 | **No CI** for the main app; a portability claim is only as good as the last local run. | Certain | Medium | Add a CI matrix (hosted-Supabase-shaped DB and plain-Postgres DB) in Phase 2. |
| R13 | **Offline claims.** DNS TXT, Stripe, Resend, Frankfurter, Supabase and the website's help links all assume the internet. | Certain | Low | Table of degradation behaviour per service in the operations guide; test with egress blocked. |
| R14 | **Dual deployment of the same code** where cloud keeps Supabase Auth and on-prem uses another: *two* identity paths to test and secure for ever. | Certain | Medium | Prefer one wire protocol (GoTrue's) for both so there is one adapter in practice. |
| R15 | **Secrets in tests/docs**: none found in source; production secrets live in Vercel and Supabase and cannot be read back. | n/a | n/a | Keep `.env.example` placeholder-only (existing rule). |

---

## 6. What is already good enough (do not touch)

- Tenancy, authorisation and audit design (RLS, `app.has_permission`, `OrganisationGuard`, append-only `audit.events`, outbox, edit-conflict versions).
- `DatabaseService.asUser` model: it needs only `request.jwt.claims` and the `authenticated` role; both exist on any Postgres.
- API configuration validation at start-up (`config/env.ts`, zod, no secrets echoed).
- The connector agent protocol, the email outbox, the worker/job queue, `CronGuard`, the `FileLinkSigner` abstract class and the three store abstract classes (the seams exist; they just have only one implementation each).
- Release signing, update and rollback design in the connector agent.

---

## 7. Proposed target interfaces and adapters

Principle (brief §3.2): a port only where a real infrastructure dependency exists. Seven ports; everything else stays as is.

### 7.1 Identity — the decision that shapes everything

**What the system needs from an identity provider (the contract).** Write this down and test it:
1. A table shaped like `auth.users` (`id uuid`, `email`, `email_confirmed_at`, `invited_at`, `created_at`, `last_sign_in_at`, `raw_user_meta_data`, `is_sso_user`) that the database may reference and join.
2. Tokens (JWT) carrying `sub`, `email`, `role = authenticated`, `aal` (`aal1`/`aal2`) and `amr` that names the SAML provider for company sign-ins, signed with a key the API can fetch (JWKS) or share (HS256).
3. Browser flows: password sign-in, sign-up with metadata, email confirmation and reset links (`verifyOtp` with a token hash), TOTP MFA enrol/challenge/unenrol, SAML sign-in by domain or provider id, refresh and sign-out.
4. Admin flows used by the API: invite a user, make a sign-in link without sending mail, verify a password without keeping a session, register / disable a SAML provider and map its domains.

**Options**

| Option | What changes | Pros | Cons |
|---|---|---|---|
| **A. Self-hosted GoTrue (the open-source Supabase Auth server)** for private cloud and on-prem; hosted Supabase Auth stays for cloud. | Run one extra container with its own SMTP and signing key. Change `SUPABASE_URL` and keys; **replace only the Management API calls** (SAML provider registration) with GoTrue's own admin endpoints. | Same wire protocol, same `auth.users`, same claims, same browser SDK → the 599 FKs, triggers, `aal`/`amr` logic and 15 frontend files stay. Cloud and on-prem share **one** adapter. | Must be **spiked**: confirm GoTrue's SAML admin endpoints, MFA, `generate_link`, JWKS/key rotation and `auth.users` columns match what we read; operate a Go service we do not write; version-pin it. |
| **B. Another IdP (Keycloak, Entra ID, Authentik) via OIDC**, with just-in-time provisioning into an `auth.users`-shaped table. | New browser login flow, claim mapping for `aal`/`amr`, our own MFA (or the IdP's) mapped to `aal2`, provisioning job, replace every Supabase auth call. | Fits enterprises that already run Entra; no extra Go service. | Largest change: rewrite of 15 frontend files and 3 API services; MFA/SSO enforcement semantics (R2) must be re-proven; two paths if cloud keeps Supabase. |
| **C. Local username/password only, written by us.** | New credential store, hashing, reset, lockout, MFA. | None. | Security-critical code we should not write; brief §6.2 says "only where explicitly supported and securely implemented". **Not recommended.** |

**Recommendation:** A as the first spike (Phase 1). If the spike fails any contract item, fall back to B with the contract tests from R2 as the acceptance gate. Either way, the API and database depend only on the contract above, never on Supabase by name.

### 7.2 Ports (mapped to existing files)

| Port | Today | Adapters needed | Files that change |
|---|---|---|---|
| `TokenVerifier` | `JwtVerifierService` | JWKS (exists), HS256 (exists) | none functionally; document claim contract |
| `IdentityAdmin` (invite, sign-in link, password check, SAML provider admin) | `InvitationMailer`, `PasswordVerifier`, `SupabaseSsoAdmin` call Supabase directly | Supabase (hosted), GoTrue (self-hosted) | `members/invitation-mailer.service.ts`, `sso/password-verifier.ts`, `sso/supabase-sso-admin.ts` |
| `ObjectStorage` (sign upload/download, read, write, remove, exists) | `FileLinkSigner`, `IntegrationFileStore`, `InspectionFileStore`, `DocumentFileStore` — four classes, all Supabase | Supabase, **local filesystem / mounted volume**, S3-compatible (later) | `files/file-links.ts`, `integrations/core/file-store.ts`, `measurement-imports/file-store.ts`, `documents/controlled-copy.ts` (collapse into one port; keep the abstract-class seams) |
| `MailTransport` | exists (`none`, `resend`) | **SMTP** | `email/` |
| `SecretStore` (integration credentials, cron secret) | Supabase Vault via SQL functions | Vault (hosted), **API-side AES-GCM envelope with a master key from the deployment secret store** | `integrations_core` functions, `app.set_integration_credential`, `integration_credential_secret`; a migration to re-wrap |
| `Scheduler` | pg_cron+pg_net → HTTP; Vercel Cron | external (as today), **in-process timer** | `worker/`, `cron/`; `vercel.json` is only one caller |
| `EntitlementSource` | Stripe-backed subscription rows | Stripe (exists), **signed licence file/token** | the `app.organisation_subscription_valid` / `app.check_entitlement` seam, not a new check path |

Frontend facades (no behaviour change first): `src/lib/identity.js` wrapping the 15 `supabase-client` call sites; `src/lib/files.js` for the 6 storage call sites. Selection by runtime config
(`/config.json` served by the web server, not `VITE_` build-time constants, so one image works in every deployment).

### 7.3 Database

Keep Postgres 15+ as the single engine. For self-hosted installs ship a **compatibility bootstrap** (`deploy/db/bootstrap.sql`) that creates roles and, depending on the identity choice, the `storage` and `vault` compatibility schemas. The existing test stubs prove this works; they become a supported artefact instead of a test helper (with the `vault` stub replaced by a real encrypted implementation or the port in §7.4). Add a migration history table that the on-prem upgrader owns (Supabase's `schema_migrations` is not guaranteed to exist).

### 7.4 Secrets (Vault)

Integration credentials are read **only** by the API login (`app.integration_credential_secret`). The simplest portable design: the API encrypts with AES-256-GCM using a master key from the environment or a mounted secret, and stores ciphertext in a normal table; SQL never sees plaintext. A migration re-wraps existing Vault secrets on first use. Do not move this to `pgsodium` (an extension we would have to install and operate ourselves).

### 7.5 Files

One `ObjectStorage` port with `put`, `get` (stream), `sign`, `remove`. The local adapter signs *API* URLs (short-lived HMAC tokens) and streams bytes through the API, so there are no permanent URLs and no direct filesystem exposure. The browser upload contract becomes provider-neutral (the existing `/files/upload-url` shape already carries `bucket`, `path` and a token). `app.storage_file_allowed` remains the single authorisation rule. Buckets map to directories (or prefixes) and are created by the adapter at start-up.

### 7.6 Licensing

The entitlement seam already exists in the database (`app.has_permission` = role AND two-factor AND single-sign-on AND seat AND entitlement). The licence adapter should **populate the same tables** (organisation subscription state, seats per package, enabled features) from a signed document (ECDSA, the project already verifies ECDSA P-256 signatures in the agent release and request paths) with an offline grace period, instead of adding a second enforcement path. Required properties (brief §6.5): bound to an instance id, cached, never blocks reading customer records on expiry (reduces to read-only), separate from roles and approval authority. No prices or plans in code (they are already data in `subscription_prices`).

### 7.7 Portal and sync (Phases 5–6, deliberately last)

- **Cloud and private cloud:** keep the portal as built. It is already tenant-isolated, curated by named-field functions and heavily tested.
- **On-premises:** a separate **portal service** is needed only when an on-prem customer wants supplier/customer collaboration. Reuse, do not rewrite: the *publication shapes* are the existing curated views (`portal_get_ncr`, `portal_get_capa`, `portal_get_scar`, …); the *transport* pattern is the Connector Agent's (outbound polling, ECDSA-signed requests, nonces, resumable batches, key rotation, signed updates); the *response path* is the existing "portal writes land as pending, internal staff review" rule. The new work is an event envelope with idempotent consumption, an attachment transfer with checksums and malware scanning at the boundary, the instance-registration flow, and a **portal-side database** holding only published projections.
- **Recommendation:** do not include this in the first on-premises release. Ship Core on-prem first (Phases 1–4), and treat the portal sync as its own project with its own plan once a customer commits (D5).

---

## 8. Revised phased plan (maps to the brief's phases)

| Phase | Scope | Exit evidence | Depends on |
|---|---|---|---|
| **0** (this report) | Audit, risk register, decisions | Your review of §10 | — |
| **1a Identity spike** (timeboxed, no production change) | Stand up GoTrue against a plain Postgres; run `npm run journey` and the auth e2e against it; check each contract item in §7.1; document gaps | Written spike result; pass/fail per contract item | D1 |
| **1b Boundaries** | Frontend facades; `IdentityAdmin`, `ObjectStorage` (collapsing four classes), `SecretStore`, `Scheduler`, SMTP `MailTransport`; runtime config; `DEPLOYMENT_MODE` validation at start-up. Hosted Supabase behaviour unchanged. | Existing suites unchanged and green; contract tests for each adapter; **no change in the hosted deployment** | 1a |
| **2 Containerise** | API and web Dockerfiles, nginx/Caddy config carrying the current headers and SPA rewrite, Compose for dev and production-like; **CI for the main app** (lint, unit, `db:check`, API e2e, journey) with a Postgres matrix | CI green; the image runs against hosted Supabase and against a local DB | 1b |
| **3 Local adapters and bootstrap** | `deploy/db/bootstrap.sql`, own migration history table, filesystem storage adapter, API-encrypted secrets, licence adapter (basic), network-policy mode for private networks, operator features inert | Clean install on an empty host from documented steps; restart persistence; backup + **restore drill** | 2 |
| **4 On-prem packaging** | Compose package, internal HTTPS guidance (trusted certificate), PWA installability check, health/readiness, upgrade/rollback with pre-upgrade backup, multi-workstation test | Brief §13.1 and §13.4 checklists | 3 |
| **5 Portal contract** | Event envelope, publication schemas from the existing curated views, attachment protocol, instance registration | Contract tests; cloud-to-cloud validation | D5 |
| **6 Fortress Connect** | Outbound agent, durable queue, idempotent import through a local API endpoint, health UI | Brief §13.3 checklist, including duplicate delivery and network interruption | 5, D6 |
| **7 Hardening** | Security review, tenant-isolation tests on the portal, load/resilience, upgrade drills | Exit report | all |

Each phase: small reviewable commits, tests with the change, `CLAUDE.md` updated, nothing pushed without your say-so, and a phase report using the brief's template (files changed, decisions, tests, configuration, limitations, manual steps, risks).

**Test strategy.** (1) *Adapter contract tests* — one suite per port run against every adapter (fake, Supabase-shaped, local). (2) *Claim-contract tests* — token fixtures against `app.mfa_satisfied` / SSO-required behaviour. (3) *Database matrix in CI* — migrations + SQL tests on plain Postgres 15 and 16; hosted-shaped (with stubs) and local-bootstrap. (4) *Journey in both topologies*. (5) *Egress-blocked run* for the offline behaviour table. (6) *Restore drill* is a scripted test, not a document.

---

## 9. Phase 0 deliverables checklist (brief §15)

- [x] Current-state architecture report — §3.
- [x] Every deployment-specific dependency and where it is used — §4.
- [x] Highest-risk migration blockers — §5 (R1, R2, R3, R7, R8, R9, R10).
- [x] Target interfaces and adapters mapped to files — §7.
- [x] Phased plan with dependencies and test strategy — §8.
- [x] Decisions requiring product-owner approval — §10.

---

## 10. Decisions needed from you

| # | Decision | My recommendation |
|---|---|---|
| D1 | **Identity route.** Timebox a self-hosted GoTrue spike first (option A) with OIDC (option B) as the fallback, never a home-grown local login (option C)? | Yes: spike A in Phase 1a. |
| D2 | **Where the rules live.** Keep Postgres (`SECURITY DEFINER`, RLS, triggers) as the home of business rules in every deployment, instead of moving them into NestJS as brief §6.1 reads? | Keep. Moving them is a rewrite and loses the tested guarantees. |
| D3 | **Supported Postgres versions and sources.** Postgres 15 and 16 (we use `NULLS NOT DISTINCT`), self-installed or the Compose-provided container; no managed-service guarantees beyond "stock Postgres 15+ with the bootstrap". | Agree 15–16. |
| D4 | **Private networks.** For on-premises, is the "allowed networks" security feature (which today rejects private ranges) to be off, or to support private ranges with a different trust model? | Off by default on-prem; revisit on demand. |
| D5 | **First on-prem release without the portal.** Ship Core on-prem (Phases 1–4) first and plan the portal sync separately? | Yes. The existing in-product portal serves cloud customers meanwhile. |
| D6 | **Agent identity.** Build Fortress Connect as a new containerised service that reuses the Connector Agent's protocol and guard code patterns, or extend the .NET agent? The brief wants a container first; the existing agent is Windows-service-first. | New small Node service (containerised), same signing protocol; revisit later. |
| D7 | **Licensing source.** Signed licence file validated offline (ECDSA) that populates the existing entitlement tables, with a configurable grace period and read-only on expiry? | Yes; commercial terms (grace length, read-only versus full access on expiry) are yours. |

Additional product-owner confirmations (smaller): the product names *Fortress Cloud / Private Cloud / On-Premises*; whether Windows Server hosting (rather than Linux containers) is a requirement for any prospective customer; whether a customer-supplied SMTP relay and an internal CA certificate can be assumed.

---

## 11. Data residency: one organisation across several countries

Added after the audit as a design note. **Nothing here is built, and none of it is legal advice.** It answers: *an organisation with sites in the USA, UK and India must keep its data at rest in each country; how would that work, and how would a combined dashboard be shown?*

### 11.1 What is true today

An organisation can already have several sites (own time zone, currency, site-scoped roles; the NC dashboard has a site picker). But the whole product is **one Supabase project (London)**, so all sites' data rests in one place. Residency per site is not possible without more than one stack.

### 11.2 The rule to confirm with the customer

The working assumption is **data at rest**: stored data must stay in-country; showing or processing it for a viewer in another country is acceptable. This must be confirmed in writing with each customer, together with: whether user names and emails count; whether summary figures may rest elsewhere; whether in-transit viewing from another country is accepted. Many such requirements are contractual rather than legal, so the customer's own wording governs.

### 11.3 Design: a regional stack per country (a "cell")

```
 US stack            UK stack            India stack
 (API, DB, files,    (API, DB, files,    (API, DB, files,
  backups, logs)      backups, logs)      backups, logs)
   own org row         own org row         own org row
        \                  |                  /
         \—— small global layer: no quality data ——/
             group, which region holds which organisation,
             and (only if agreed) a minimal user directory
```

- Each country is an ordinary Fortress organisation in its own region's database. NC numbers, files and every record stay in that region. Check availability of Supabase regions (US, London, Mumbai) and of Vercel function regions for the API of each cell.
- A **group** record in the global layer links the organisations of one customer and tells the browser which regional API to call.
- Billing and licence for the group are checked centrally; each region caches the answer.

### 11.4 Combined dashboards under the data-at-rest rule

| Option | Stores anything outside the region? | Notes |
|---|---|---|
| **Read-time merge** (a group service or the browser asks each region for summary figures and combines them) | **No** | Always current; depends on every region being reachable. **Recommended default.** |
| Merge in the browser | **No** | Simplest; the user's token must be accepted by every region; CORS per region. |
| Daily snapshots into a global database | Yes (summary numbers) | Fast and resilient, but only with the customer's agreement. |

Rules for any group view: **summary figures only** (counts, sums, rates as numerator and denominator, never averages of averages); no record titles or lists (several current dashboards list suppliers, items or titles, which must be omitted from the group view); costs converted to one reporting currency using the existing exchange rates (rate source is public data); drill-through opens the regional application and shows record data only to people entitled to it there.

### 11.5 Places data comes to rest (checklist for a residency customer)

1. **Database, files and backups/point-in-time recovery**: in-region.
2. **Email**: notification emails carry record text and are kept by the provider and in mailboxes. Reuse the existing restricted body ("You have a new notification in Fortress", link only), which today applies when network rules are enforced, as a per-organisation option.
3. **Logs**: API and platform logs must contain no record content (logger redaction exists; **not verified end to end**).
4. **Global directory**: user emails and the organisation-to-region map would rest outside the region. Ask whether that is acceptable; if not, keep it to a minimum or resolve the region by the user's company domain.
5. **Stripe**: holds billing contacts only; confirm acceptable.
6. **Browser**: data is held in memory only; the service worker caches no API answers (checked in `public/sw.js`).
7. **Outbox, job queue, audit events**: tables in each region's database, so in-region by construction.

### 11.6 What the current code lacks for this

1. A global layer (there is none; billing, organisations and the operator panel read the one database).
2. Identity across regions: each regional database needs its own `auth.users` rows (the 599 foreign keys). Customer SSO makes this painless (same company identity, an account per region); without SSO people would need three logins, or a single token issuer that every region trusts (the claim contract in §7.1) with an account row created on first visit.
3. A migration runner for several databases and a version-skew rule (migrations are applied through the SQL editor today).
4. A frontend that looks up the regional API (`VITE_API_URL` is one value today).
5. Sharing of master data (parts, suppliers, categories) if the customer wants common definitions; drawings may be export-controlled.

### 11.7 Recommendation

Do not build it now. Adopt three cheap rules: the organisation is the unit of data residency; no joins across organisations; no new hard-coded single API address. If a customer commits, build in order: (1) regional stacks, SSO and the migration runner with plant dashboards only; (2) a read-time group dashboard; (3) master-data sync only if required. This also bears on **R14** (one identity wire protocol for every cell) and favours the GoTrue spike in §7.1.

---

## 12. Limits of this audit

- Static analysis only. No on-premises stack was built or run; GoTrue, Docker, nginx, a local filesystem adapter, SMTP and a licence adapter are all untried.
- Counts (functions, policies, FKs) come from grepping the migration files. They count *definitions across history*, not the live objects (a function replaced many times is counted each time), so they overstate the live inventory but are the right size for effort estimates.
- I did not inspect the live Supabase project in this pass. Production-only facts (installed extensions beyond `pg_cron`/`pg_net`/`vault`, Auth configuration such as SAML or password policy, the worker's current tick address) are taken from `CLAUDE.md` and the repository, not re-checked.
- Frontend call-site counts exclude tests; I did not trace every consumer of `AuthProvider`.
- Self-hosting Supabase Auth's behaviour (§7.1 option A) is from general knowledge of the open-source project and **must be confirmed by the spike**; do not treat it as established.
- The website (`site/`), the connector agent code and the Stripe/Vercel account configuration are out of scope for this audit except where named.
