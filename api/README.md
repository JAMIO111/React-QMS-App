# QMS API

NestJS + TypeScript API for the manufacturing QMS (`docs/phase-1-plan.md` §4). Versioned under
`/api/v1`, documented with OpenAPI at `/api/v1/docs` (UI) and `/api/v1/openapi.json`.

## How a request is handled

```text
request
  → correlation id (X-Correlation-Id accepted or generated, echoed back, logged)
  → rate limit (per IP, RATE_LIMIT_PER_MINUTE; health exempt)
  → AuthGuard: verify the Supabase access token (Authorization: Bearer)
  → OrganisationGuard (routes marked @OrganisationScoped): X-Organisation-Id must be an organisation
    the caller is an active member of (else 404) holding the required permission (else 403)
  → controller → service → DatabaseService.asUser(ctx, work)
       BEGIN; SET LOCAL ROLE authenticated; request.jwt.claims = caller's claims;
       app.source = 'api'; app.correlation_id; app.reason (X-Change-Reason)
       … work … COMMIT
  → errors rendered as { "error": { "code", "message", "details"?, "correlationId" } }
```

The database login `qms_api` has no privileges of its own (see
`supabase/migrations/20251103120000_api_role.sql`), so every query runs under Row Level Security as
the signed-in user, and the audit trail records `source = 'api'`, the correlation id and the reason.
Permission checks in the API are a second, explicit layer on top of RLS.

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/v1/health` | public | API and database reachable |
| `GET /api/v1/me` | signed in | Profile, active organisations, effective permissions per organisation |
| `PATCH /api/v1/me` | signed in | Update own first name, surname, job title |
| `POST /api/v1/organisations` | signed in | Create an organisation (caller becomes Owner); `Idempotency-Key` supported |
| `GET /api/v1/organisations/current` | member (`X-Organisation-Id`) | Organisation and settings |
| `PATCH /api/v1/organisations/current` | `organisation.manage` | Rename, change currency / VAT / NCR prefix / theme colour |
| `GET /api/v1/sites`, `POST`, `PATCH /:id` | member / `organisation.manage` | Sites (deactivate with `active: false`) |
| `GET /api/v1/departments?siteId=`, `POST`, `PATCH /:id` | member / `organisation.manage` | Departments of a site |
| `GET /api/v1/members` | `members.read` | Members and pending invitations, with roles |
| `POST /api/v1/members/invitations` | `members.manage` | Invite by email with a role (emails if configured) |
| `PATCH /api/v1/members/:id` | `members.manage` | Suspend, reactivate, remove, revoke invitation |
| `POST /api/v1/members/:id/role-assignments`, `DELETE /api/v1/role-assignments/:id` | `members.manage` | Grant / remove roles (no escalation; last Owner kept) |
| `GET /api/v1/roles`, `GET /api/v1/permissions` | `members.read` | Roles with permissions; permission catalogue |
| `GET /api/v1/invitations`, `POST /api/v1/invitations/:id/accept` | signed in | The caller's pending invitations; accept one |

Lists return `{ data, nextCursor }`; pass `cursor` (and `limit`, max 200) for the next page.
Database errors are mapped to stable codes in `src/common/database-errors.ts`.

## Configuration

Copy `api/.env.example` and set values as environment secrets (never commit them):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | `qms_api` login. Supabase pooler user is `qms_api.<project-ref>` |
| `SUPABASE_URL` | Enables verification with the project's signing keys (JWKS) and sets the issuer |
| `SUPABASE_JWT_SECRET` | Legacy shared secret — needed while the project has no signing keys |
| `CORS_ORIGINS` | Comma-separated frontend origins |
| `SUPABASE_SERVICE_ROLE_KEY`, `INVITE_REDIRECT_URL` | Optional: send invitation emails via Supabase Auth (server-side only) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_BASE_URL` | Optional: Stripe billing (`docs/stripe-setup.md`). Without them billing routes answer `503 billing_unavailable` |
| `CRON_SECRET` | Optional, 20+ characters: protects `/internal/cron/*` (Vercel Cron sends it as a Bearer token). Unset: the jobs answer 503 |
| `PORT`, `RATE_LIMIT_PER_MINUTE`, `LOG_LEVEL`, `DATABASE_POOL_MAX` | Optional |

Start-up fails with a clear message (without secret values) if configuration is invalid. Logs are
structured JSON; `Authorization` and cookies are redacted.

## Commands (from the repository root)

```sh
npm run api:build        # compile to api/dist
npm run api:dev          # build, then start with api/.env loaded (Node >= 22.9; works on Windows, macOS, Linux)
npm run api:test         # unit tests
npm run api:test:e2e     # migrate a throwaway Postgres, then run the e2e suite against it as qms_api
```

## Adding an endpoint

1. Validate input with zod (`parse()` in `src/common/validation.ts`); describe it for OpenAPI with
   `openApiSchema()`.
2. Mark tenant routes `@OrganisationScoped('<permission>')`; read the organisation from `ctx.organisationId`.
3. Do all data access inside `DatabaseService.asUser(ctx, …)` — never query the pool directly for
   business data.
4. Return API shapes (camelCase), not raw rows.
5. Add e2e tests including another tenant's ids (expect 404) and a member without the permission (403).
