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

## Current state of the repo (after Step 0, Nov 2026)

- Vite + React 19 (JavaScript, not TypeScript), Tailwind v4, TanStack Query/Table,
  react-hook-form + zod, Recharts. Supabase (auth, DB, storage) called directly from the client
  via `src/api/supabaseApi.js` and `src/supabase-client.js`. No backend service yet.
- Routes in `src/main.jsx`; side menu in `src/MenuStructure.js`. Routed areas: Dashboard
  (simple overview), Non-Conformance registers (`/Non-Conformance/:type` — Internal, Customer,
  Supplier), Human Resources (employee list), Settings.
- Holiday-let code was removed; it is preserved on branch `archive/holiday-let`.
- Database schema is versioned in `supabase/migrations/` (baseline matches the live project);
  see `supabase/README.md`. RLS is still OFF on every table until the first Phase 1 migration.
- `.env` is untracked; copy `.env.example`. Build passes; lint has 0 errors (warnings remain).

## Agreed plan

`docs/phase-0-assessment.md` holds the Phase 0 assessment and the agreed decisions (§8):
NestJS API added in Phase 1 alongside the Vite frontend; holiday-let code archived on
branch `archive/holiday-let` then removed; Supabase project `xvpgrmujayytbbmhnoan` ("React QMS") is
canonical and its data is test data; RLS enabled in the first Phase 1 migration with policies.
Step 0 (Stabilise) is done. Next: **Phase 1** (platform foundation).

## Commands

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm test` — Vitest unit/component tests (`src/**/*.test.{js,jsx}`)
- `npm run db:check` — apply all migrations to a throwaway local Postgres and run `supabase/tests/*.test.sql`

Before committing: `npm run lint && npm test && npm run build`, plus `npm run db:check` for any migration change.

## Git

- Working branch: `Dev` (capital D). `main` is the other long-lived branch.
