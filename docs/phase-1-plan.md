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

Policies (every table, `ENABLE` + `FORCE ROW LEVEL SECURITY`):

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
