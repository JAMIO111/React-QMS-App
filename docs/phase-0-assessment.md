# Phase 0 — Repository Assessment and Architecture Alignment

**Date:** 2026-11-03 · **Branch inspected:** `Dev` @ `7b80b5b` (same as `main`) · **Brief:** `docs/design-brief.md`

This document covers brief §12 Phase 0: current architecture, reusable functionality, mapping of
existing entities to target domains, security/tenancy/audit gaps, and a proposed implementation
order. Its exit criterion is an **agreed plan** — see §7 for the decisions needed.

Everything below was verified by reading the code and querying the database unless marked
*(unverified)*.

---

## 1. Current architecture

| Aspect | Current state |
|---|---|
| Frontend | Vite 6 + React 19, **JavaScript** (no TypeScript), React Router 7 (routes in `src/main.jsx`) |
| UI | Tailwind v4, partial shadcn-style components in `src/components/ui/`, react-icons + lucide, styled-components also installed |
| Forms / data | react-hook-form + zod (`src/validationSchema.js`), TanStack Query + TanStack Table, Recharts |
| Backend | **None.** The browser talks to Supabase directly with the anon key (`src/supabase-client.js`, `src/api/supabaseApi.js`, plus `.from()` calls scattered across ~20 hooks/components) |
| Auth | Supabase Auth, email + password (`src/authService.js`). Profile = `Employees` row keyed by `auth_id`, cached in `localStorage`. Sign-up redirects to a hard-coded `http://localhost:5173/Onboarding` route that does not exist |
| Database | Supabase Postgres. **No migrations in the repo, none recorded in the database.** Schema was built in the Supabase dashboard |
| Files | Supabase Storage: `nc-files` (private, signed URLs) and `avatars` (public) |
| Tests | None. No test runner installed |
| Build / lint | `npm run build` **fails** (`useStatusOptions` not exported by `src/hooks/useCategoryOptions.jsx`). `npm run lint`: 139 errors, 29 warnings |
| Deployment | No deployment config in the repo *(hosting unverified)* |
| Secrets | `.env` committed to git (Supabase URL + anon key, UniRate API key) |

### Two products in one codebase

- **Original QMS (May–Jun 2025):** non-conformance (internal / customer / supplier), 8D, costs,
  files, failure-mode taxonomy, status management, NC dashboard and KPIs.
- **Holiday-let management (Jun–Nov 2025):** bookings, properties, owners, leads, meetings,
  key codes, packages, job sheets, calendar. This is what the router and menu currently expose.

The NC screens are still in the code but **not routed** (`NonConformance` is imported in
`src/main.jsx` and never used).

### Two Supabase projects — needs resolving

- The committed `.env` points at project `hkyidvdvwglksebccsoh`. That project is **not in the
  Supabase account connected to this session**, so I could not inspect it. The holiday-let tables
  (`Bookings`, `Properties`, `Owners`, `PropertyOwner`, `Leads`, `Meetings`, `KeyCodes`,
  `Packages`, view `v_bookings`) presumably live there.
- The account's **"React QMS"** project (`xvpgrmujayytbbmhnoan`, Postgres 15) holds the original
  QMS schema — inspected below.

---

## 2. Existing database ("React QMS" project)

16 public tables, 4 views, 9 SQL functions, 0 triggers, 0 edge functions, 0 migrations.

| Table | Rows | Notes |
|---|---|---|
| `NCM` | 20 | NCR register. `type` text = Internal / Customer / Supplier. Human ref `ncm_id` (e.g. `NCM-25-001`, globally unique). FKs to Part, Customers, Suppliers, Employees, Process, Status, Failure Mode, Sub-Failure Mode, 8D. `work_order` / `purchase_order` are free text. No `organisation_id` |
| `8D` | – | D2 problem-description fields only (who/what/where/when/why/how) + closure request |
| `Costs` | – | NC cost lines, multi-currency with base-currency conversion. Linked by **text** `nc_ref`, not FK |
| `NC Files` | 4 | File metadata, linked by **text** `id_ref` |
| `Part` | 6 | `part_number`, name, description. **No revisions** |
| `Customers`, `Suppliers`, `Addresses` | – | Basic party master data. `Addresses.party_id` has no FK |
| `Failure Mode`, `Sub-Failure Mode`, `Process` | – | Classification lookups (bigint ids) |
| `Status` | 9 | Configurable statuses with enum type `initial / in_progress / terminal / omit`. Global, not per-organisation |
| `Organisations` | 1 | name, base currency, VAT rate |
| `Employees` | 11 | Doubles as user profile (`auth_id`) **and** operator list. 10 of 11 have no `organisation_id` |
| `Notifications`, `Notification Recipients` | – | In-app notifications (`org` FK on Notifications) |

Views `v_ncm_internal`, `v_ncm_customer`, `v_ncm_supplier`, `v_nc_files` are **SECURITY DEFINER**.
Functions `get_nc_kpi_json`, `get_nc_date_trend`, `get_top_customers_by_rejects`, etc. power the
NC dashboard.

Only one auth user exists and the 20 NCRs look like development data *(confirm — decision D3)*.

---

## 3. Mapping existing entities to target domains

| Brief domain (§5–§6) | Existing | Fit | Action |
|---|---|---|---|
| Organisations & sites | `Organisations` | Partial | Keep, rename to `organisations`, add `sites`, `departments` |
| Users, membership, roles | `Employees` (profile + org FK) | Poor | Split into `profiles` + `organisation_users` + `roles` / `permissions` / `user_role_assignments`. Operators who never log in become a separate personnel concept later |
| Customers / suppliers | `Customers`, `Suppliers`, `Addresses` | Good base | Add `organisation_id`, tenant-scoped unique refs, FK on addresses |
| Parts & revisions | `Part` | Partial | Add `organisation_id`, create `part_revisions` |
| Processes | `Process` | Good | Add `organisation_id` |
| NCR | `NCM`, `NC Files`, `Costs` | Partial — best reusable asset | Evolve into `nonconformances` + containment / investigation / disposition / affected items, with real FKs instead of text refs |
| NCR classification | `Failure Mode`, `Sub-Failure Mode` | Good | Becomes `ncr_classifications` (keep the two-level hierarchy), per organisation |
| Workflow status | `Status` (+ type enum) | Good idea | Keep the concept, make it per organisation, add server-enforced allowed transitions |
| CAPA | `8D` (D2 only) | Weak | Model CAPA as its own domain (§6.3); 8D becomes one CAPA method/template |
| Inspection & measurement | — | Missing | New (Phase 2) |
| Document control, audits, calibration, training, supplier quality | — | Missing | Phase 4 |
| Production orders, lots, serials, equipment | — (free-text `work_order`) | Missing | Phase 3 |
| Notifications | `Notifications`, `Notification Recipients` | Good base | Keep, add `organisation_id` scoping |
| Quality audit trail | — | Missing | New (Phase 1) |
| Integrations | — | Missing | Phase 5 |

**Holiday-let tables** (`Bookings`, `Properties`, `Owners`, `Leads`, `Meetings`, `KeyCodes`,
`Packages`, …) have **no mapping** to the brief and should be retired from this product
(decision D2).

---

## 4. Reusable frontend assets

Worth keeping and adapting to the brief's UI patterns (§9):

- App shell: `App.jsx`, `Navbar`, `Header`, `Breadcrumb`, `SideMenuItem`/`SubMenuItem`, `ThemeToggle`, light/dark theming in `index.css`
- Providers: `AuthProvider`, `ToastProvider`, `ConfirmationModalProvider`, `ModalContext`, `SearchProvider`
- Tables: `Table.jsx`, `TableWrapper.jsx`, `lib/ColumnDefs.jsx`, `FilterPane`, `SortPane`, `DataNavBar`, `lib/csvHelper.jsx`
- Form controls: `src/components/ui/*` (ComboBox, RHF wrappers, DatePicker, DateRangePicker, NumericInput, TextInput, TextArea, FileDrop, StatusComboBox, UserComboBox, ToggleButton, SlidingSelector)
- Charts: `charts/AreaChart`, `PieChart`, `StackedBarChart`, `ui/chart.jsx`, `DashboardCard`
- Status/badge patterns: `StatusPill`, `Pill`, `BadgeGroup`, `ShieldBadge`, `Skeleton`, `LoadingSpinner`
- NC feature: `NonConformance.jsx`, `NonConformanceCard/Grid`, `CostInputForm`, `CostData`, `useNCM*` hooks, `Settings/SettingsStatus` — reference implementation for the new NCR module, but needs a redesign (NCR detail tabs, workflow stages)

Several components have duplicates (`NonConformance3.jsx`, `DataNavBar2.jsx`,
`RHF*` vs plain variants) to consolidate.

---

## 5. Security, tenancy and audit gaps

Ranked by severity.

**Critical — now**
1. **RLS is disabled on all 16 tables** in the React QMS project. Anyone with the anon key (which is
   shipped in every browser bundle) can read, change or delete every row. *(Supabase advisor: critical.)*
2. **4 SECURITY DEFINER views** bypass the querying user's permissions.
3. **`.env` committed** to git history. The Supabase anon key is designed to be public, but only
   when RLS is on — which it is not (point 1). The UniRate key is exposed in client bundles regardless.
4. `avatars` bucket is public. `nc-files` is private with 4 storage policies *(policy contents unverified)*.

**Tenancy (brief §3.1, §5)**
5. No `organisation_id` on any business table except `Employees` and `Notifications`. No tenant isolation.
6. A user can belong to only one organisation (single FK on `Employees`). No sites / departments.
7. No roles or permissions. Every signed-in user can do everything.
8. Tenant context is resolved client-side only; profile cached in `localStorage`.
9. Lookups (`Status`, `Failure Mode`, `Process`) and reference numbers (`ncm_id`) are global, not per organisation.

**Data integrity and audit (brief §3.5, §11)**
10. No audit history: no triggers, no audit table. Updates overwrite in place; `created_by` / `updated_by` mostly absent.
11. Status changes are free-form client updates — no server-side transition rules.
12. NCR reference numbers are generated client-side (`getNextNCId`) with a read-then-check loop — race condition under concurrent creation.
13. Files and costs link to NCRs by text reference, not FKs. Deleting files removes the metadata row (no history).
14. Database functions have a mutable `search_path` (9 functions).

**Platform hygiene**
15. Schema exists only in the dashboard: no migrations, so it cannot be reviewed, reproduced or rolled back.
16. No tests, failing build, many lint errors.
17. Postgres 15.8 has outstanding security patches; leaked-password protection is off.

---

## 6. Proposed implementation order

Follows brief §12 and §13. Each step is a reviewable, reversible change.

### Step 0 — Stabilise (before Phase 1, small)
- Fix the build (`useStatusOptions`) and the worst lint errors.
- Stop tracking `.env`; add `.env.example`; rotate the UniRate key.
- Bring the existing schema under version control: install the Supabase CLI, pull the current
  React QMS schema as a **baseline migration** in `supabase/migrations/`.
- Add a test runner (Vitest for the frontend; pgTAP or SQL-based tests for RLS).
- Retire holiday-let screens per decision D2 (archive on a branch/tag first).

### Phase 1 — Platform foundation (exit: a user works securely in one org and cannot see another's data)
1. **Tenancy schema (migration):** `organisations`, `sites`, `departments`, `profiles`,
   `organisation_users` (with invitation/membership status), `roles`, `permissions`,
   `role_permissions`, `user_role_assignments` (optional site/department scope),
   `organisation_settings`. Backfill the existing organisation and its users.
2. **Tenant columns:** add `organisation_id NOT NULL` + `created_by/updated_by/updated_at` to
   retained business tables; backfill to the existing org; tenant-scoped unique constraints
   (e.g. `(organisation_id, reference)`).
3. **RLS everywhere:** enable RLS with membership-based policies; replace SECURITY DEFINER views
   with `security_invoker` views; fix function `search_path`; lock down storage paths by org.
4. **Audit infrastructure:** append-only `audit_events` table (fields per brief §11) written by
   triggers on quality-critical tables; no update/delete grants.
5. **API layer** per decision D1.
6. **Frontend:** organisation (and site) switcher in the shell, permission-aware navigation,
   shared API client in `src/lib/api-client`, remove the `localStorage` profile cache.
7. **Tests:** automated cross-tenant access tests (direct table access, views, RPCs, storage).

### Phase 2 — First vertical slice (brief §16)
Part + revision → inspection plan + characteristics (NUMERIC + explicit units) → manual result
entry → failed result raises/links NCR → containment → investigation/root cause → disposition →
CAPA actions → effectiveness verification → closure, with history and evidence throughout.
Reuse the NC screens and status concept, rebuilt around NCR detail tabs (§9).

Phases 3–7 as per the brief; not planned in detail yet.

---

## 7. Decisions needed to close Phase 0

**D1 — Backend / API approach.** The brief asks for API-first with server-side business rules
(preferred: NestJS + TypeScript). The repo has no backend.
- **Option A (recommended):** keep Vite + React for the frontend (no Next.js migration — not needed
  and highly disruptive), add a NestJS + TypeScript API (`/api/v1`, OpenAPI) in Phase 1 alongside it,
  using Supabase Auth JWTs and Postgres with RLS as defence in depth. New frontend code moves to TypeScript incrementally.
- **Option B:** stay Supabase-only for Phase 1 (RLS + Postgres functions for business rules),
  introduce the API in Phase 2. Faster start, but workflow rules end up in SQL functions and the
  frontend keeps calling tables directly, which the API would later need to replace.

**D2 — Holiday-let features.** Recommended: tag the current state (e.g. `holiday-let-archive`),
then remove those routes, components and hooks from `Dev` so the codebase only carries QMS code.

**D3 — Which Supabase project is canonical, and what to do with existing data.**
Recommended: use the **React QMS** project (`xvpgrmujayytbbmhnoan`), treat its 20 NCRs as
development data that may be migrated or reset, and point `.env` at it. The project in the
committed `.env` (`hkyidvdvwglksebccsoh`) is not in the connected account — confirm whether
it holds anything you need.

**D4 — Supabase Auth.** Recommended: keep Supabase Auth for now (brief §4 allows it), wrapped
behind an auth module so the business logic is not coupled to it.

**D5 — Immediate RLS fix.** Enabling RLS on the React QMS project now (before Phase 1 policies
exist) would block the app until policies are added. Recommended: lock it down as the first
Phase 1 migration, together with policies, rather than as a one-off dashboard change. If the
data is sensitive, do it immediately.

Once D1–D5 are agreed, the first piece of work is **Step 0 (Stabilise)**, then **Phase 1 item 1
(tenancy schema)**.

---

## 8. Agreed decisions (2026-11-03)

| # | Decision |
|---|---|
| D1 | **Option A.** Keep Vite + React frontend; add a NestJS + TypeScript API (`/api/v1`, OpenAPI) in Phase 1. Supabase Auth JWTs; Postgres RLS kept as defence in depth. |
| D2 | **Archive, then remove.** Current state preserved on branch `archive/holiday-let` (tag push was blocked by the git proxy), then holiday-let routes, components and hooks removed from `Dev`. |
| D3 | **React QMS project (`xvpgrmujayytbbmhnoan`) is canonical.** Existing rows are test data and may be migrated or reset. |
| D4 | Keep Supabase Auth, wrapped behind an auth module (not explicitly asked; recommended default stands). |
| D5 | **Enable RLS in the first Phase 1 migration**, together with membership-based policies. |

**Phase 0 status:** plan agreed.

## 9. Step 0 (Stabilise) — done 2026-11-03

- Holiday-let features removed (archived on `archive/holiday-let`); NC registers routed at
  `/Non-Conformance/:type` and added to the menu; Dashboard replaced with a simple overview.
- Build fixed (`useStatusOptions` restored); lint errors 168 → 0 (21 warnings remain). Real bugs
  fixed along the way: hooks called inside a loop (`Settings`), a hook after an early return
  (`DashboardCard`), helper functions referencing undefined variables (`HelperFunctions`).
- `.env` untracked, `.env.example` added, local config points at `xvpgrmujayytbbmhnoan`.
  Sign-up email redirect no longer hard-coded to localhost.
- Schema under version control: `supabase/migrations/20251103000000_baseline.sql`, verified
  identical to the live project by catalog fingerprint. `npm run db:check` runs migrations + SQL tests locally.
- Test runner: Vitest + Testing Library (`npm test`).

Still open: UniRate API key rotation (owner action); remote migration history not yet initialised
(`supabase migration repair`, see `supabase/README.md`).
