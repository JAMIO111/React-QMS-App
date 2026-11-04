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

## Current state of the repo (after Phase 1, Nov 2026)

- Vite + React 19 (JavaScript, not TypeScript), Tailwind v4, TanStack Query/Table,
  react-hook-form + zod, Recharts. Supabase (auth, DB, storage) called directly from the client
  via `src/api/supabaseApi.js` and `src/supabase-client.js`.
- `api/` (npm workspace): NestJS 11 + TypeScript API at `/api/v1` — see `api/README.md`. Connects as
  the `qms_api` login and runs every query via `DatabaseService.asUser()` as `authenticated` with the
  caller's JWT claims (RLS + audit apply). New data access must go through it. Deployed with the
  frontend to a Vercel dev environment from `Dev` (`docs/deployment-vercel.md`).
- Routes in `src/main.jsx`; side menu in `src/MenuStructure.js`. Routed areas: Dashboard
  (simple overview), NC dashboard (`/Non-Conformance`, `NcDashboard.jsx`, data from `GET /ncr-dashboard?from&to&source`;
  chart colours are the validated `--chart-*` variables in `src/index.css`), Non-Conformance registers (`/Non-Conformance/:type` — Internal, Customer,
  Supplier; NC form at `/Non-Conformance/:type/:id`, `new` creates; hooks in `src/hooks/useNcr.js`), Human Resources (employee list), Settings.
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
  `avatars/users/<user_id>/...`, `org-logos/<org_id>/logo/...` (all private).
- Product name: **Fortress QMS** (tab title `Fortress QMS | <organisation>` set in `App.jsx`; mark in
  `public/fortress-qms.svg` / `src/assets/fortress-qms.svg`). Organisation logo: `organisation_settings.logo_path`
  → private `org-logos` bucket at `<org_id>/logo/...` (members read, `organisation.manage` writes); shown in the
  side menu via `useOrganisationLogo()`, managed in Settings → Organisation (`OrganisationLogo.jsx`).
- Theme colour: `organisation_settings.theme_colour` (blue/red/yellow/green/orange/purple/pink, set in
  Settings → Organisation) → `<html data-theme-colour>` (`src/lib/theme-colours.js`,
  `ThemeColourSync`). `src/index.css` gives each mode three shades (`theme-light`, `theme`,
  `theme-dark` utilities) and derives `brand-*`/`cta-*` from them — use those tokens, not fixed
  purple/violet classes, for accent colour.
- Tables: reuse `src/components/Table.jsx` with a TanStack table instance (see its header comment and
  `TableWrapper.jsx`): one `<table>` + `<colgroup>`, so header and rows always line up. Sorting
  (header click, `sortDescFirst: false`), resizing (`columnResizeMode: "onChange"`, min/maxSize,
  double-click resets), show/hide via `ColumnVisibilityMenu`, `meta.pin: "left" | "right"` keeps a column fixed
  while the rest scroll sideways (row select / actions in `TableWrapper`). Persist with
  `useTablePreferences(key)`; when `columnSizing` is controlled also use `useColumnSizingInfo()`
  or resizing lags one mouse move. Column meta: `align`, `sortKey` (server sort field).
- Auth: `/forgot-password`, `/set-password` (invite/reset landing), `/mfa` (code or set-up).
  `AuthProvider` exposes `assurance` (`aal1`/`aal2`); `ProtectedRoute` sends users to `/mfa` when
  needed. `organisation_settings.require_mfa` is enforced in the DB membership helpers
  (`app.mfa_satisfied`); API answers `403 mfa_required`.
- Master data (2.1): `units` (global), `customers`, `suppliers`, `parts`, `part_revisions` via API
  (`src/hooks/useMasterData.js`, pages in `src/components/master-data/`). Revision lifecycle and
  outbox events are enforced by DB triggers; emit new events with `app.emit_event` from SECURITY
  DEFINER triggers only. New tenant tables: table-level INSERT + `app.stamp_created()`,
  column-level UPDATE, no DELETE, `audit_changes`, add to guardrails + both sweeps.
- Form pickers: dropdowns use `src/components/ui/RHFComboBox.jsx` and dates use
  `RHFDatePickerPopout.jsx` (value/onChange, so wrap in react-hook-form `Controller`; both take
  `label`, `required`, `disabled`, `hint`, `error`). Options are `{ id, name, hint?, disabled? }`;
  `sort={false}` keeps your order; server search via `filterLocally={false}` + `onSearchChange`
  (see `RemoteComboBox`, `PartPicker`, `PartyPicker` in `src/components/ncr/Pickers.jsx`). Dates:
  `valueFormat="iso"` for date-only API fields, `minDate`/`maxDate`, `clearable`.
  The calendar opens in a portal (`data-popover`), so panes that close on outside clicks must ignore
  `[data-popover]`. Ranges: `src/components/ui/RangeSlider.jsx` (two handles, `value=[lo, hi]`, `format`).
- NC register filters live in the URL (`FILTER_KEYS` in `src/hooks/useNCMFilters.jsx`); `/ncrs` takes
  stage, severity, from/to, partId, customerId, supplierId, costMin/costMax, qtyMin/qtyMax; slider limits from
  `GET /ncrs/ranges`. List parameters go to SQL as one text value (`string_to_array`), never a JS array.
- NCR files: upload to `nc-files` at `<org>/ncr/<ncr id>/<uuid>-<name>` (`uploadFileToSupabase`), then
  `POST /ncrs/{id}/attachments`; storage policies allow uploads only into an existing NCR's folder and
  never delete. Forms built with react-hook-form use `noValidate` (TextInput sets native `required`).
- Icons: **Lucide only**, imported from `@/components/icons` (`<Name>Icon`, default size 1em so
  icons follow text size). Add new icons there; ESLint rejects `react-icons` and direct
  `lucide-react` imports elsewhere.
- `.env` is untracked; copy `.env.example`. Build passes; lint has 0 errors (warnings remain).

## Agreed plan

`docs/phase-0-assessment.md` holds the Phase 0 assessment and the agreed decisions (§8):
NestJS API added in Phase 1 alongside the Vite frontend; holiday-let code archived on
branch `archive/holiday-let` then removed; Supabase project `xvpgrmujayytbbmhnoan` ("React QMS") is
canonical and its data is test data; RLS enabled in the first Phase 1 migration with policies.
Step 0 (Stabilise) and Phase 1 slices 1.1 (tenancy + RLS), 1.2 (audit trail) and 1.3 (API
skeleton), 1.4 (organisations, sites, departments, onboarding) and 1.5 (members, invitations,
roles) and 1.6 (exit check) are done — Phase 1 is complete; see `docs/phase-1-exit-report.md`. Plan and agreed decisions
in `docs/phase-1-plan.md` (API hosting decided later — a Vercel dev environment for `Dev` is described in `docs/deployment-vercel.md`; migrations checked locally with
`npm run db:check`, rehearsed on a live-data copy, then applied via the SQL editor; Supabase
built-in email for now). **Phase 2** (first complete QMS workflow) is planned and agreed in `docs/phase-2-plan.md`
(slices 2.0 auth gate → 2.1 parts → 2.2 inspection plans → 2.3 results → 2.4 NCR core → 2.5
containment/investigation/disposition → 2.6 CAPA → 2.7 exit check); slices 2.0 (password flows, MFA), 2.1 (master data: units, customers, suppliers, parts,
revisions, outbox) and 2.4 (NCR core, brought forward: `nonconformances`, `ncr_classifications`,
stages, soft delete, legacy NCM copy; NC registers and form on the API) are done, plus NCR costs and
attachments with the NC page in the original form layout (`ncr_costs`, `ncr_attachments`, `FileDrop`,
`NcrCosts`) — see plan §9–§12;
next: 2.2 inspection plans.
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

Guardrails that will fail on purpose when something new is added without tenancy:
- `supabase/tests/guardrails.test.sql` (new table without RLS/policy/organisation_id, view without
  security_invoker, function without search_path, anon privileges, missing audit trigger);
- `supabase/tests/tenancy_sweep.test.sql` (new tenant table must be seeded for the sweep);
- `api/test/tenancy-sweep.e2e-spec.ts` (new route must be `@OrganisationScoped` or allowlisted;
  new `{id}` route needs a sample body).
`supabase/checks/guardrails.sql` can be run read-only against the live project.

## Git

- Working branch: `Dev` (capital D). `main` is the other long-lived branch.
- **Do not push to `Dev` (or any branch) until the user says so** — every push triggers Vercel
  builds. Commit locally and tell the user what is waiting to be pushed.
