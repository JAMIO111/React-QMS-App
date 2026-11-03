# Phase 1 — Platform Foundation: Implementation Plan

**Status:** draft for agreement · **Date:** 2026-11-03 · **Brief:** `docs/design-brief.md` §3, §5, §10, §11, §12
**Builds on:** `docs/phase-0-assessment.md` (decisions D1–D5, Step 0 done)

**Exit criterion (brief §12):** a user can securely work within an organisation and cannot access
another tenant's data — proven by automated tests at the database and API layers.

---

## 1. Scope

**In scope**
1. Tenancy schema: organisations, sites, departments, profiles, memberships, roles, permissions,
   scoped role assignments, organisation settings.
2. `organisation_id` on every retained business table, backfilled; lookups become per organisation.
3. Row Level Security on every table, views and functions hardened, storage locked down by organisation.
4. Append-only quality audit events.
5. NestJS + TypeScript API (`/api/v1`, OpenAPI): auth, tenant context, permissions, conventions.
6. Frontend: organisation context and switcher, onboarding, organisation/sites/users/roles settings,
   permission-aware navigation, shared API client.
7. Cross-tenant test suite (database + API).

**Out of scope (later phases)**
- NCR redesign, CAPA, inspection, workflows, domain events/outbox → Phase 2.
- Renaming the legacy tables (`"NCM"`, `"Failure Mode"`, …) to the brief's model → Phase 2, when the
  NCR module is rebuilt. Phase 1 only adds tenancy and security to them.
- Moving the existing NC screens from direct Supabase calls to the API → Phase 2 (RLS protects them
  in the meantime).
- SSO, advanced multi-site permissions → Phase 7.

---

## 2. Data model

New platform tables use `snake_case`, UUID ids and the brief's tenant convention
(`id, organisation_id, created_at, created_by, updated_at, updated_by`).

### 2.1 Tables

| Table | Key columns | Notes |
|---|---|---|
| `organisations` | `id`, `name`, `slug` (unique), `status` (active/suspended) | Existing `"Organisations"` row is moved here (same id) |
| `organisation_settings` | `organisation_id` PK, `base_currency`, `vat_rate`, `ncr_reference_prefix` | 1:1; moves `base_currency` / `vat_rate` off organisations |
| `sites` | `id`, `organisation_id`, `code`, `name`, `timezone`, `active` | unique `(organisation_id, code)` |
| `departments` | `id`, `organisation_id`, `site_id`, `code`, `name`, `active` | unique `(site_id, code)`; production areas deferred until needed |
| `profiles` | `id` = `auth.users.id`, `first_name`, `surname`, `avatar_path`, `job_title` | One per login identity, not tenant-owned |
| `organisation_users` | `id`, `organisation_id`, `user_id` (nullable until accepted), `invited_email`, `status` (invited/active/suspended/removed), `invited_by`, `invited_at`, `joined_at` | unique `(organisation_id, user_id)`, unique `(organisation_id, lower(invited_email))` |
| `permissions` | `code` PK (e.g. `members.manage`), `description` | Global catalogue, seeded by migration |
| `roles` | `id`, `organisation_id` (null = system role template), `key`, `name`, `is_system` | System roles copied into each new organisation so they can be customised later |
| `role_permissions` | `role_id`, `permission_code` | |
| `user_role_assignments` | `id`, `organisation_id`, `membership_id`, `role_id`, `site_id` null, `department_id` null | null scope = whole organisation |
| `audit.events` | per brief §11 (see §2.4) | Separate `audit` schema, append-only |

`"Employees"` stays, renamed in meaning to **personnel** (operators who may never log in), with
`organisation_id NOT NULL`. Its `auth_id` becomes an optional link to `profiles`. User profile data
moves to `profiles`; the frontend stops reading the current user from `"Employees"`.

### 2.2 Seeded permissions and system roles

| Permission | Owner | Admin | Quality manager | Quality engineer | Inspector | Viewer |
|---|---|---|---|---|---|---|
| `organisation.manage` (settings, sites, departments) | ✓ | ✓ | | | | |
| `members.read` | ✓ | ✓ | ✓ | ✓ | | |
| `members.manage` (invite, suspend, assign roles) | ✓ | ✓ | | | | |
| `roles.manage` | ✓ | | | | | |
| `audit.read` | ✓ | ✓ | ✓ | | | |
| `lookups.manage` (statuses, failure modes, processes) | ✓ | ✓ | ✓ | | | |
| `master_data.read` / `master_data.manage` (parts, customers, suppliers, personnel) | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/ | ✓/ |
| `ncr.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `ncr.create` / `ncr.update` | ✓ | ✓ | ✓ | ✓ | ✓ / | |
| `ncr.delete` | ✓ | | ✓ | | | |

Rules: every organisation must keep at least one active Owner (enforced in the database). Site- and
department-scoped assignments are stored and honoured by `has_permission(org, perm, site)`; business
records don't carry `site_id` until Phase 2, so in Phase 1 scoped assignments only affect
site/department administration.

### 2.3 Legacy tables gaining tenancy

`"NCM"`, `"8D"`, `"Costs"`, `"NC Files"`, `"Part"`, `"Customers"`, `"Suppliers"`, `"Addresses"`,
`"Process"`, `"Failure Mode"`, `"Sub-Failure Mode"`, `"Status"`, `"Employees"`, `"Notifications"`,
`"Notification Recipients"`:

- add `organisation_id uuid NOT NULL REFERENCES organisations`, backfilled to the existing organisation;
- add `updated_at`, `created_by`, `updated_by` where missing, maintained by trigger;
- replace global uniques with tenant-scoped ones: `"NCM"(organisation_id, ncm_id)`,
  `"Status"(organisation_id, name)`;
- `"Notifications".org` is superseded by `organisation_id` (kept until Phase 2, then dropped).

### 2.4 Audit events

`audit.events(id, organisation_id, actor_user_id, entity_type, entity_id, action, previous_values,
new_values, changed_fields, reason, source, correlation_id, created_at)`

- Written by a generic `SECURITY DEFINER` trigger on: all tenancy tables (memberships, roles,
  assignments, settings) and quality-critical tables (`"NCM"`, `"8D"`, `"Costs"`, `"NC Files"`,
  `"Status"`, `"Part"`).
- Actor = `auth.uid()`; `source`, `reason` and `correlation_id` come from transaction settings
  (`app.source`, `app.reason`, `app.correlation_id`) that the API sets per request.
- `INSERT` only via the trigger; `UPDATE`/`DELETE`/`TRUNCATE` revoked from every role and blocked by
  trigger. Readable through RLS by members with `audit.read`.
- This is the formal quality trail; the existing notifications remain the activity feed (brief §3.5).

---

## 3. Security model

### 3.1 RLS (defence in depth, decision D5)

Helper functions in a private `app` schema (`SECURITY DEFINER`, fixed `search_path`, not exposed
through the Data API):

- `app.is_member(org uuid) → bool` — active membership of `auth.uid()`.
- `app.has_permission(org uuid, perm text, site uuid default null) → bool`.
- `app.member_org_ids() → setof uuid`.

Policies (every table, `ENABLE ROW LEVEL SECURITY`; not `FORCE`, so the `SECURITY DEFINER` helpers owned by
`postgres` can read the membership tables without recursing through their policies):

| Operation | Rule |
|---|---|
| select | `app.is_member(organisation_id)` (+ `audit.read` for audit events) |
| insert / update | member **and** the matching permission (e.g. `ncr.update`, `lookups.manage`) |
| delete | specific permission (`ncr.delete`); none for audit events |
| `profiles` | own row, plus rows of users sharing an organisation (read-only) |

Also in the same migration:
- revoke all table privileges from `anon`; `authenticated` keeps only what policies allow;
- recreate the 4 views with `security_invoker = true`;
- `set search_path = ''` on all functions and make the reporting functions filter by the caller's
  organisation (`organisation_id` parameter, checked with `app.is_member`);
- drop the broken, unused `get_top_customers_by_rejects`.

### 3.2 Storage

- New object paths: `<organisation_id>/<entity>/<id>/<filename>`.
- Policies: read/write only when the first path segment is an organisation the user belongs to
  (with the matching permission for writes).
- `avatars` becomes private; avatars are served by short-lived signed URLs (brief §11).
- The 17 existing objects are test data: re-keyed into the new layout by a one-off script (or
  deleted — you choose, §8 Q4).

### 3.3 API ↔ database

- The API verifies the Supabase access token (JWT) itself, then for each request opens a transaction
  that runs `set local role authenticated` and `set_config('request.jwt.claims', …)`, plus
  `app.source = 'api'` and `app.correlation_id`. RLS therefore applies to API queries exactly as it
  does to direct client queries; API permission checks are a second, explicit layer.
- The API uses a dedicated database login (not `postgres`, not the service-role key) for queries.
  The Supabase service-role key is used only for Auth admin calls (invitations).

---

## 4. API (decision D1)

**Layout:** new top-level `api/` folder with its own `package.json` (NestJS 11, TypeScript, strict),
root made an npm workspace so `npm install` covers both. The frontend stays at the repository root
— no restructure.

**Stack:** NestJS, Drizzle ORM + `node-postgres` (brief §4; schema in TypeScript, SQL migrations stay
in `supabase/migrations` as the single source of truth), `zod` for request validation (shared style
with the frontend), `@nestjs/swagger` for OpenAPI, `jose` for JWT verification, `pino` structured logs.

**Modules (Phase 1):** `health`, `auth`, `tenancy` (organisation context guard), `organisations`,
`sites`, `members`, `roles`, `audit`.

**Conventions (brief §10):**
- Base path `/api/v1`; OpenAPI JSON at `/api/v1/openapi.json`, UI at `/api/v1/docs`.
- Tenant context from the `X-Organisation-Id` header; guard rejects non-members with 404 (no
  existence leak) and missing permissions with 403.
- Errors: `{ "error": { "code", "message", "details", "correlationId" } }`.
- Pagination: `?limit=&cursor=` returning `{ data, nextCursor }`.
- `X-Correlation-Id` accepted or generated, echoed and logged; written into audit events.
- `Idempotency-Key` honoured on create endpoints (organisation creation, invitations).
- Controllers thin; logic in application services; services run inside the RLS-scoped transaction.

**Endpoints (Phase 1):**

| Method & path | Permission |
|---|---|
| `GET /health` | public |
| `GET /me` — profile + memberships + effective permissions per organisation | signed in |
| `PATCH /me` — update own profile | signed in |
| `POST /organisations` — create organisation, default site, owner membership, roles (one transaction) | signed in |
| `GET /organisations/current`, `PATCH /organisations/current` (+ settings) | member / `organisation.manage` |
| `GET/POST /sites`, `PATCH /sites/:id` | member / `organisation.manage` |
| `GET/POST /departments`, `PATCH /departments/:id` | member / `organisation.manage` |
| `GET /members`, `POST /members/invitations`, `PATCH /members/:id` (status) | `members.read` / `members.manage` |
| `POST /invitations/:id/accept` | invited user |
| `GET /roles`, `GET /permissions` | `members.read` |
| `POST /members/:id/role-assignments`, `DELETE /role-assignments/:id` | `members.manage` |
| `GET /audit-events?entityType=&entityId=` | `audit.read` |

Deactivate instead of delete for sites, departments and memberships.

---

## 5. Frontend

- **API client** `src/lib/api-client.ts`: attaches the Supabase access token, `X-Organisation-Id`
  and a correlation id; maps the error format; TanStack Query hooks per resource. New frontend files
  are TypeScript (`.ts/.tsx`, `allowJs` so existing files keep working).
- **Session/org context:** replace `UserProvider` + `OrganisationProvider` with a `SessionProvider`
  backed by `GET /me`; remove the `localStorage` profile cache. Selected organisation remembered per
  browser (convenience only — the server re-checks every request).
- **Organisation switcher** in the header; hidden when the user has one organisation. Site switcher
  deferred until records carry `site_id` (Phase 2).
- **Onboarding:** after sign-up, a user with no membership sees "Create your organisation" or their
  pending invitations. Fixes the dead `/Onboarding` flow.
- **Settings → Organisation:** name, currency, VAT, sites and departments.
- **Settings → Users & permissions:** members list, invite, suspend/reactivate, assign roles with
  optional site/department scope.
- **Permission-aware UI:** `usePermission('members.manage')`; menu items and actions declare required
  permissions; hidden when not allowed (server still enforces).
- **Existing NC screens:** keep direct Supabase reads, now filtered by the current organisation and
  protected by RLS. Delete in `ActionsModal` requires `ncr.delete`. File uploads use the new
  storage path layout.

---

## 6. Delivery slices

**Status:** 1.1–1.4 done (see §9–§12). Next: 1.5.

Each slice is one reviewable change that leaves `Dev` working, with its own tests and docs.

| # | Slice | Main contents | Verified by |
|---|---|---|---|
| 1.1 | **Tenancy schema + RLS lockdown** | Migrations: platform tables + seeds; backfill existing org, its users, owner role; `organisation_id` on legacy tables; RLS on everything; views/functions hardened; storage policies. Frontend: read profile from `profiles`, filter NC queries by org. | SQL tests: two orgs, every table — member sees own rows only; non-member sees nothing; anon sees nothing; writes need permissions; last-owner rule. Supabase security advisor clean. App still works for the existing user. |
| 1.2 | **Audit events** | `audit` schema, trigger, attachments, immutability. | SQL tests: insert/update/delete produce events with old/new values and actor; update/delete of events fails for every role; cross-tenant read blocked. |
| 1.3 | **API skeleton** | `api/` workspace, config, JWT verification, RLS-scoped transaction, org guard, errors, correlation id, OpenAPI, health, `GET/PATCH /me`. CI-style scripts. | API tests against the throwaway Postgres (extending `db:check`): token handling, 401/403/404 behaviour, RLS applied inside API queries. |
| 1.4 | **Organisations, sites, departments** | Endpoints + onboarding + settings screens + org switcher + API client. | API tests incl. cross-tenant attempts via direct ids and nested ids; component tests for onboarding/switcher. |
| 1.5 | **Members, invitations, roles** | Endpoints + Supabase invite email + accept flow + Users & permissions screens + permission-aware nav. | API tests: invite → accept → role → permission effective; suspended member loses access; scoped assignment honoured; last owner protected. |
| 1.6 | **Exit check** | Full cross-tenant suite (direct, nested, list/search, views, RPCs, storage, audit), definition-of-done review (brief §14), docs, Supabase advisors. | All suites green; written report of what was verified. |

Order is fixed by risk: 1.1 closes the open-database problem first and touches the least code.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Enabling RLS breaks the current app | Backfill memberships + owner role in the same migration; run the app against a Supabase branch or after `db:check` before applying remotely; policy tests per table |
| Policy helper functions slow down queries | `SECURITY DEFINER` + `STABLE`, indexes on `organisation_users(user_id, status)` and every `organisation_id`; check with `EXPLAIN` and the performance advisor |
| Recursive RLS (policies on membership tables calling helpers that read them) | Helpers are `SECURITY DEFINER` owned by a role that bypasses RLS on those tables |
| JWT verification method differs by project (legacy secret vs asymmetric keys) | Support JWKS first, legacy HS256 secret as fallback; covered by tests |
| Supabase connection pooling (transaction mode) and `SET LOCAL` | All per-request settings are transaction-local; verified in API tests |
| Default Supabase SMTP is rate-limited | Custom SMTP needed before real invitations (§8 Q3) |
| Applying migrations to the only project | Use a Supabase branch or a second "staging" project for rehearsal (§8 Q2) |

---

## 8. Decisions needed

1. **API hosting** — where the NestJS API runs for real use (brief: "AWS or equivalent"). Options:
   Render / Railway / Fly.io (simplest), AWS App Runner or ECS (most aligned with the brief).
   Phase 1 can be built and tested locally before this is decided, but the frontend can't depend on
   the API in production until it is.
2. **Rehearsal environment** — Supabase branching (paid add-on) or a second free "React QMS staging"
   project to apply migrations to before production.
3. **Email for invitations** — Supabase's built-in email is heavily rate-limited; real invitations
   need custom SMTP (e.g. Resend, Postmark, SES).
4. **Existing storage objects** — re-key the 17 test files into the new layout, or delete them.
5. **Secrets needed from you** (never committed): database connection string for a dedicated API
   role (I can create the role via migration; you set its password), Supabase service-role key and
   JWT settings, stored as environment secrets for the API.

### Agreed (2026-11-03)

| # | Decision |
|---|---|
| Q1 | API hosting **decided later**; build and test locally through 1.1–1.6, choose before the frontend depends on the API in production. |
| Q2 | **Local check only**: `npm run db:check` + review, then apply directly to `xvpgrmujayytbbmhnoan` (its data is test data). Rehearsal environment can be added later if real data arrives. |
| Q3 | **Supabase built-in email** for invitations during development; custom SMTP before real users. |
| Q4 | **Delete** the 17 existing storage objects when storage moves to the organisation-scoped layout (slice 1.1). |

Q5 (secrets) is needed from slice 1.3 onwards.

---

## 9. Slice 1.1 — done (2026-11-03)

Migrations `20251103100000_tenancy_core`, `20251103100100_tenant_columns`,
`20251103100200_rls_lockdown` applied to `xvpgrmujayytbbmhnoan` in one transaction via the
SQL editor, with the migration history recorded for all four files.

**Verified on the live project**
- Schema identical to the tested local build in every fingerprint category (columns,
  constraints, indexes, functions, views, policies, triggers, table/column/function grants, RLS
  flags, seeds, buckets). Function bodies differ only by CRLF line endings from the paste.
- Backfill: JDigital (slug `jdigital`), settings GBP / 0.20, default site, the existing user is an
  active Owner with a profile; 20 NCRs, 11 employees and all lookups kept.
- As that user through RLS: 1 organisation, 20 NCRs, all lookups, notification, KPIs.
- Supabase security advisor: RLS-disabled, security-definer-view and mutable-search-path findings
  cleared. Remaining warnings: signed-in users can see table *names* in the GraphQL schema (rows are
  still protected by RLS); leaked-password protection off; Postgres 15.8 patch available.
- Old storage objects, `NC Files` rows and employee avatar URLs removed as agreed.

**Verified locally (`npm run db:check`)**: backfill test, cross-tenant/permission suite (anon,
outsider, owner, dual member, inspector, suspended member, notifications, privilege escalation,
last owner, storage, TRUNCATE), plus mutation checks showing the suite fails when a policy is weakened.

**Lessons**
- The first live apply failed (and rolled back): the live `NCM -> 8D` foreign key depended on
  `8D_id_key`, not the primary key. The baseline now reproduces that; all 21 foreign-key index
  bindings were compared with the live project.
- Supabase grants `authenticated` ALL on new tables by default (including TRUNCATE); the lockdown
  migration revokes what policies don't need.
- The Supabase connector's SQL tool times out waiting for approval on large/destructive scripts;
  applying through the SQL editor worked.

**Not verified yet:** the running app in a browser against the live project (sign-in, registers,
avatar upload, attachments). Please check these when you next run `npm run dev`.

---

## 10. Slice 1.2 — done (2026-11-03)

Migration `20251103110000_audit_events` applied to `xvpgrmujayytbbmhnoan` via the SQL editor and
recorded in the migration history.

- `audit.events` (append-only) with actor, entity, action, previous/new values, changed fields,
  reason, source, correlation id, transaction id and `seq` ordering. Read through
  `public.audit_events` (security_invoker) by members holding `audit.read`, own organisation only.
- One generic trigger (`audit.record_change`) on 17 tables: organisations, settings, sites,
  departments, memberships, roles, role permissions, role assignments, NCM, 8D, Costs, NC Files,
  Part, Status, Failure Mode, Sub-Failure Mode, Process. Updates store only changed fields and skip
  bookkeeping-only changes; system role templates are not audited.
- `source` is `client` for direct Supabase writes and `system` without a user; the API (1.3) will
  set `app.source = 'api'`, `app.reason` and `app.correlation_id` per request.

**Verified locally:** `supabase/tests/audit_events.test.sql` (recording, context, append-only for
every role including the owner, read isolation); mutation checks (removing the update guard,
widening the read policy, dropping a trigger) each make it fail. Rehearsed on the live-data copy.

**Verified on the live project:** trigger count, guard triggers, grants, RLS and the trigger
function match the tested build; an update made as the existing owner inside a rolled-back
transaction produced exactly one event (NCM, update, description, source client, actor set) and
left no event behind. Security advisor: no new findings beyond the GraphQL schema-visibility
warning for the two new objects (rows remain protected by RLS).

**Known limits:** the database owner can still disable the guard triggers; stronger tamper-evidence
(hash chaining, external retention) is deferred per brief §11. No UI yet — events are surfaced by the
API in 1.3/1.4.

---

## 11. Slice 1.3 — done (2026-11-03)

- `api/` npm workspace: NestJS 11, TypeScript strict, Drizzle (node-postgres), zod validation,
  jose token verification (JWKS or legacy HS256), nestjs-pino logs with redaction, throttler,
  OpenAPI. Details and conventions in `api/README.md`.
- Migration `20251103120000_api_role`: `qms_api` login, NOINHERIT, member of `authenticated` only.
  `supabase/tests/api_role.test.sql` proves it has no privileges of its own and cannot become
  `service_role`, `postgres` or `anon`.
- Endpoints: `GET /health`, `GET /me`, `PATCH /me`, `GET /organisations/current` (the last one pulled
  forward from 1.4 as the minimal read that exercises organisation scoping).
- Tests: 24 unit tests (env, token verification incl. wrong secret/issuer/audience/expiry/role,
  correlation ids, organisation guard) and 27 e2e tests against a migrated throwaway Postgres as
  `qms_api` (auth, error format, OpenAPI, /me, organisation scope 400/404, RLS inside the API, audit
  `source=api` + correlation id + reason, rollback, no role/claims leakage between requests,
  rate limiting). Mutation checks: removing `SET LOCAL ROLE` fails 6 e2e tests; removing the
  membership check fails the guard unit test (RLS still returned 404 end to end).

**Deviations:** jose 5 instead of 6 (v6 is ESM-only; Jest runs CommonJS). The service-role key is
not needed until invitations (1.5). Idempotency keys are accepted by CORS but first used by create
endpoints in 1.4/1.5.

**Live project:** `20251103120000_api_role` applied (first attempt failed and rolled back: Supabase's
`postgres` is not a superuser and cannot restate NOSUPERUSER/NOREPLICATION/NOBYPASSRLS; fixed). Verified:
migration history has all six versions; `qms_api` can log in, NOINHERIT, no elevated attributes,
member of `authenticated` only, timeouts set. The password was set by the user (not verifiable from SQL).

**Known gap:** `db:check` runs migrations as a real superuser, so superuser-only statements are not
caught locally; take extra care with role/attribute statements until the check emulates Supabase's
restricted `postgres` role.

**Not done / needs the user:** the API is not deployed (hosting decision pending) and has not yet
connected to the live project. To run it: provide `DATABASE_URL` (pooler user `qms_api.<project-ref>`)
and `SUPABASE_JWT_SECRET` (the project's JWKS endpoint is empty, i.e. it still uses the legacy secret).

---

## 12. Slice 1.4 — done (2026-11-03)

**Database:** migration `20251103130000_create_organisation` — `app.create_organisation(name, site
name, site code, idempotency key)` (SECURITY DEFINER, reachable only via the API) creates the
organisation, settings, default site, standard roles, four starter NCR statuses and the caller's
Owner membership in one transaction; per-user idempotency keys (`app.idempotency_keys`, private);
abuse limit of 10 new organisations per user per day. Tests: `supabase/tests/create_organisation.test.sql`.

**API:** `POST /organisations` (Idempotency-Key), `GET`/`PATCH /organisations/current`
(`organisation.manage`), `GET`/`POST /sites`, `PATCH /sites/:id`, `GET`/`POST /departments`,
`PATCH /departments/:id`. Keyset pagination (`limit`, opaque `cursor`, `{ data, nextCursor }`).
No deletes: sites/departments are deactivated. Database errors map to stable codes (409 `conflict`,
400 `invalid_reference`/`invalid_value`, 403, 429 `limit_reached`, 503 `timeout`). 33 unit and
45 e2e tests (e2e suites isolated with per-suite ids), incl. every write attempted across tenants
and without permission.

**Frontend:** `src/lib/api-client.js` (token, X-Organisation-Id, correlation id, X-Change-Reason,
Idempotency-Key, error mapping, "API unreachable"), `src/hooks/useQmsApi.js` (`useMe`,
`usePermissions`, organisation/site/department queries and mutations), onboarding on the
no-organisation screen (`CreateOrganisationForm`), header `OrganisationSwitcher` (hidden with one
organisation), Settings → Organisation (details, defaults, optional audit reason, sites and
departments; read-only without `organisation.manage`). 22 frontend tests.

**Browser check** (UI → local API → throwaway Postgres; Supabase session/profile/membership calls
stubbed): settings saved, site and department created, duplicate site code shows the API's message,
all four changes audited with `source = api` (reason on the settings change), onboarding created an
organisation with the new user as Owner, no console errors.

**Deviations:** new frontend files are JavaScript (the frontend has no TypeScript tooling yet; adding
it is deferred rather than mixed in). The rest of the app still reads Supabase directly (memberships
for the switcher, NC registers); only settings and onboarding need the API. A site switcher is
deferred until records carry `site_id` (Phase 2).

**Needs the user:** apply the migration (SQL editor). Settings → Organisation and onboarding only
work where the API runs (`npm run api:dev` locally) until API hosting is chosen; `VITE_API_URL`
points the frontend at it.
