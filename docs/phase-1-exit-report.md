# Phase 1 — Exit Report

**Date:** 2026-11-03 · **Branch:** `Dev` · **Brief:** `docs/design-brief.md` §12 (Phase 1), §11, §14
**Plan:** `docs/phase-1-plan.md` (slice records §9–§13)

## Verdict

**Exit criterion — "a user can securely work within an organisation and cannot access another
tenant's data" — is met at the database and API layers, verified by automated tests and on the live
project**, with the limitations listed below. The remaining gaps are mostly in operations (hosting,
monitoring, MFA, backups) rather than in tenant isolation.

Phase 1 is complete: all nine migrations, including the 1.6 hardening, are applied to the live
project (confirmed 2026-11-03).

---

## 1. Evidence for the exit criterion

| Boundary (brief §14) | How it is enforced | How it is verified |
|---|---|---|
| Direct access (tables) | RLS on every table; membership + permission helpers; no anon privileges | `guardrails.test.sql` (catalogue-wide rules), `tenancy_rls.test.sql`, `tenancy_sweep.test.sql` (every table discovered from the catalogue: read/update/delete of another organisation's rows returns nothing) |
| Indirect / nested | Composite `(id, organisation_id)` foreign keys; views run as the caller | `tenancy_rls.test.sql` (cross-org references rejected), sweep covers every view |
| Search / lists | All list endpoints filter by the scoped organisation; RLS underneath | API sweep: no list response contains any identifier of the other organisation |
| Functions / RPCs | Fixed `search_path`; helpers answer only for the caller's organisations | Sweep calls every function against the other organisation; guardrail rule 7 |
| API routes | `@OrganisationScoped` guard (404 non-member, 403 missing permission) + RLS | API sweep driven by OpenAPI: every route is scoped or on a reviewed allowlist; every scoped route answers 404 for a foreign organisation and for foreign record ids |
| Files | Storage paths `<organisation_id>/…` and `users/<user_id>/…` with RLS policies; private buckets; signed URLs (10–30 min) | `tenancy_rls.test.sql` (storage), sweep (storage objects) |
| Exports | None exist yet | — |
| Background jobs | None exist yet | — |
| Privilege escalation | Cannot grant roles you don't fully hold or manage someone who outranks you; last Owner kept | `tenancy_rls.test.sql`, `members.e2e-spec.ts` |

Every guard was **mutation-checked**: removing it (policy, guard trigger, `SET LOCAL ROLE`,
membership check, `@OrganisationScoped`, a helper's membership condition) makes a test fail.

**Live project** (`xvpgrmujayytbbmhnoan`): all nine migrations applied and recorded in the
migration history. The guardrail query run on the live project reports **zero violations** (before
the hardening migration it reported one: PUBLIC execute on a trigger function). The membership-probe
fix and the ten `(select auth.uid())` policies are in place; the performance advisor's
`auth_rls_initplan` warnings are gone (remaining findings are INFO: unindexed audit-column foreign
keys and not-yet-used indexes).

## 2. Test inventory (all passing on `Dev`)

| Suite | Count | Command |
|---|---|---|
| SQL (migrations + RLS/audit/tenancy/guardrails/sweep) | 9 files | `npm run db:check` |
| API unit | 36 | `npm run api:test` |
| API end-to-end (real Postgres as `qms_api`) | 67 | `npm run api:test:e2e` |
| Frontend unit/component | 31 | `npm test` |
| Browser checks (UI → API → Postgres) | 2 scenarios (1.4 settings/onboarding, 1.5 invitations) | scripted with Playwright; see plan §12–§13 |

Lint: 0 errors (20 pre-existing warnings). Build passes.

## 3. Definition of done (brief §14) per Phase 1 feature

| Criterion | Status |
|---|---|
| 1. Schema + migration present, reversible where practical | ✅ 9 versioned migrations, baseline matches the original live schema; all applied in single transactions. Reversal is by forward migration (no down-scripts). |
| 2. Backend rules and validation | ✅ zod validation at the API; status transitions, escalation, last Owner, idempotency enforced server-side (DB + API). |
| 3. Tenant isolation and permissions server-side | ✅ RLS + API guards (see §1). |
| 4. Frontend loading, empty, error, success states | ✅ for new screens (settings, users, onboarding, invitations), incl. "API unreachable". ⚠️ Legacy NC screens unchanged. |
| 5. Audit events for quality-critical changes | ✅ append-only `audit.events` on 17 tables with actor/source/reason/correlation id. |
| 6. Relationships and history preserved | ✅ deactivate/remove instead of delete for sites, departments, memberships; audit keeps full history. |
| 7. Automated tests for core behaviour and failures | ✅ see §2. |
| 8. API and technical documentation | ✅ OpenAPI at `/api/v1/docs`; `api/README.md`, `supabase/README.md`, plan and this report. |
| 9. No secrets or sensitive data in logs or bundles | ✅ `.env` untracked; service-role key server-side only and optional; logs redact `Authorization`/cookies. ⚠️ The UniRate key in git history still needs rotating (user action). |
| 10. Tested in the actual repository environment | ✅ throwaway Postgres + live-data rehearsals + browser checks. ⚠️ Not yet exercised against the live project through a running API (needs `DATABASE_URL`/`SUPABASE_JWT_SECRET`). |

## 4. Security minimums (brief §11)

| Requirement | Status |
|---|---|
| Tenant isolation at backend and database | ✅ |
| Secure authentication and MFA support | ⚠️ Supabase Auth email/password. **MFA not enabled or exposed in the UI.** |
| Role- and scope-based authorisation | ✅ roles, permissions, site/department-scoped assignments (record-level site scoping arrives with `site_id` on records in Phase 2) |
| Private object storage, short-lived signed access | ✅ |
| Encrypted secrets management | ⚠️ Environment variables only; no secrets manager until hosting is chosen |
| API rate limiting and input validation | ✅ for the API. ⚠️ Direct Supabase calls from the legacy screens rely on Supabase's own limits |
| Revocable integration credentials | n/a until Phase 5 |
| Append-only quality audit events | ✅ (owner-level users could disable guard triggers; tamper-evidence deferred) |
| Automated backups and tested restore | ⚠️ Not verified (depends on the Supabase plan); no restore drill done |
| Error monitoring and structured logs | ⚠️ Structured JSON logs ✅; Sentry/OpenTelemetry not added |
| Data retention and export controls | ❌ Not started |

## 5. Known gaps and carried-forward items

**Needs the user**
1. ~~Apply `apply_phase_1_6.sql`~~ — done, verified live.
2. Choose API hosting (decision Q1); until then onboarding, settings and member screens work only where the API runs.
3. Rotate the UniRate API key (in git history).
4. Supabase dashboard: enable leaked-password protection; schedule the Postgres 15.8 security upgrade; consider disabling the unused `pg_graphql` extension (clears the "table names visible in GraphQL" warnings).
5. Before real users: custom SMTP, and switch the project to asymmetric JWT signing keys (then `SUPABASE_JWT_SECRET` is no longer needed).

**Engineering, recommended before or early in Phase 2**
1. Invited-user password flow ("set your password", "forgot password") — required before enabling invitation emails.
2. MFA enrolment (Supabase TOTP) and enforcement option per organisation.
3. Move the NC registers from direct Supabase reads to the API (planned with the NCR rebuild).
4. Error monitoring (Sentry) and request metrics once hosting is chosen.
5. Make `db:check` emulate Supabase's non-superuser `postgres` role (two migration failures in Phase 1 came from that difference).
6. TypeScript for the frontend (new files are still JavaScript).
7. Invitation banner for people who already belong to another organisation; custom-role editing UI.
8. Performance: indexes for `created_by`/`updated_by` foreign keys if those columns get queried (advisor INFO only).

**Explicitly out of Phase 1 (brief §12/§15):** NCR/CAPA/inspection workflows, integrations,
outbox/domain events, SSO, exports.

## 6. Recommendation

Proceed to **Phase 2** (first complete QMS workflow: part + revision → inspection plan → result →
NCR → containment → investigation → disposition → CAPA → verification → closure). Tackle items 1–3 of the engineering list early in Phase 2 because they
gate real users (password flow), the brief's MFA minimum, and the move of quality records onto the
API with full audit and validation.
