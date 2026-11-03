# CLAUDE.md

## Project direction — read first

**`docs/design-brief.md` is the authoritative product and architecture brief for this project.**
Read it before planning or making any substantial change, and refer back to it whenever a
decision touches scope, data model, tenancy, security, integrations or roadmap phase.

Summary of the brief:
- Product: multi-tenant, API-first **manufacturing QMS** + connected quality data / integration platform.
- Architecture: modular monolith, Postgres with RLS + server-side authorisation, canonical data
  model, append-only quality audit events, transactional outbox, connector framework.
- Delivery: complete, tested vertical slices, phase by phase (Phase 0 assessment → Phase 1
  platform foundation → Phase 2 inspection → NCR → CAPA workflow → …). Don't build future
  phases early.
- Agent rules: inspect before changing, preserve working code, plan before substantial changes,
  incremental reversible migrations, never claim unverified results, keep secrets out of source
  control and client bundles. See brief §2 and §14 (definition of done) and §15 (non-goals).

## Current state of the repo (after Phase 1.1, Nov 2026)

- Vite + React 19 (JavaScript, not TypeScript), Tailwind v4, TanStack Query/Table,
  react-hook-form + zod, Recharts. Supabase (auth, DB, storage) called directly from the client
  via `src/api/supabaseApi.js` and `src/supabase-client.js`.
- `api/` (npm workspace): NestJS 11 + TypeScript API at `/api/v1` — see `api/README.md`. Connects as
  the `qms_api` login and runs every query via `DatabaseService.asUser()` as `authenticated` with the
  caller's JWT claims (RLS + audit apply). New data access must go through it. Not deployed yet.
- Routes in `src/main.jsx`; side menu in `src/MenuStructure.js`. Routed areas: Dashboard
  (simple overview), Non-Conformance registers (`/Non-Conformance/:type` — Internal, Customer,
  Supplier), Human Resources (employee list), Settings.
- Holiday-let code was removed; it is preserved on branch `archive/holiday-let`.
- Database schema is versioned in `supabase/migrations/`; the live project matches it (see
  `supabase/README.md`). Multi-tenancy is in place: organisations, sites, departments, profiles,
  memberships, roles/permissions; `organisation_id` on every business table; RLS on every table
  with `app.is_member` / `app.has_permission` helpers. Legacy table names ("NCM", "Failure Mode"…)
  stay until Phase 2.
- Append-only quality audit trail in `audit.events` (trigger `audit.record_change` on tenancy and
  quality tables), readable via `public.audit_events` with `audit.read`. New quality-critical tables
  must get the `audit_changes` trigger.
- Frontend → API: `src/lib/api-client.js` (`apiFetch`, `VITE_API_URL`) and hooks in
  `src/hooks/useQmsApi.js` (`useMe`, `usePermissions`, organisation/site/department hooks). Used by
  onboarding (`CreateOrganisationForm`, `PendingInvitations`), the header `OrganisationSwitcher`,
  Settings → Organisation and Settings → Users & permissions. Menu items declare a `permission`;
  `useCanSee` hides those the user lacks.
  New features should call the API, not Supabase tables.
- Frontend reads the current user from `profiles` and memberships via `OrganisationProvider`;
  every query filters by the current `organisationId`. Storage paths: `nc-files/<org_id>/...`,
  `avatars/users/<user_id>/...` (both private).
- `.env` is untracked; copy `.env.example`. Build passes; lint has 0 errors (warnings remain).

## Agreed plan

`docs/phase-0-assessment.md` holds the Phase 0 assessment and the agreed decisions (§8):
NestJS API added in Phase 1 alongside the Vite frontend; holiday-let code archived on
branch `archive/holiday-let` then removed; Supabase project `xvpgrmujayytbbmhnoan` ("React QMS") is
canonical and its data is test data; RLS enabled in the first Phase 1 migration with policies.
Step 0 (Stabilise) and Phase 1 slices 1.1 (tenancy + RLS), 1.2 (audit trail) and 1.3 (API
skeleton), 1.4 (organisations, sites, departments, onboarding) and 1.5 (members, invitations,
roles) are done. Plan and agreed decisions
in `docs/phase-1-plan.md` (API hosting decided later; migrations checked locally with
`npm run db:check`, rehearsed on a live-data copy, then applied via the SQL editor; Supabase
built-in email for now). Next: **slice 1.6 (Phase 1 exit check)**.
The project still signs tokens with the legacy HS256 secret (JWKS endpoint is empty), so the API
needs `SUPABASE_JWT_SECRET` until the project moves to signing keys.

## Commands

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm test` — Vitest unit/component tests (`src/**/*.test.{js,jsx}`)
- `npm run db:check` — apply all migrations to a throwaway local Postgres and run `supabase/tests/*.test.sql`

- `npm run api:build` / `npm run api:test` / `npm run api:test:e2e` — API build, unit tests, e2e tests against a migrated throwaway Postgres

Before committing: `npm run lint && npm test && npm run build`, plus `npm run db:check` for any
migration change and `npm run api:test && npm run api:test:e2e` for API changes.

## Git

- Working branch: `Dev` (capital D). `main` is the other long-lived branch.
