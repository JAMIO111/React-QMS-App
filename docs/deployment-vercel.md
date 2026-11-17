# Dev environment on Vercel

A remote test environment that redeploys on every push to `Dev`. This is not the production
hosting decision: the brief (§13) puts the API and background workers on AWS or similar, and the
Phase 5 workers will need a long-running host.

| Vercel project | Root directory | Framework | What it serves |
|---|---|---|---|
| `qms-web` | `/` (repo root) | Vite | The React frontend (static). `vercel.json` rewrites every path to `index.html` so React Router routes survive a refresh. |
| `qms-api` | `api/` | NestJS | The API as one Vercel Function (entry file `api/src/main.ts`, recognised by Vercel). |

Both projects build only from `Dev` (Ignored Build Step: any other branch is skipped), because
`main` does not have the API yet. The frontend's `vercel.json` uses an explicit static `builds`
entry so Vercel does not turn the repo-root `api/` folder into serverless functions (the Hobby plan
allows 12 per deployment). The API entry file `api/src/main.ts` imports `@nestjs/core` directly,
which Vercel's NestJS detection requires.

Both use the Supabase project `xvpgrmujayytbbmhnoan`, whose data is test data.

## Addresses

Pushes to `Dev` produce Preview deployments. Each project also gets a stable branch address:

- `https://qms-web-git-dev-jamie-drydens-projects.vercel.app`
- `https://qms-api-git-dev-jamie-drydens-projects.vercel.app`

Use the branch addresses in the settings below; the per-deployment addresses change on every push.

## Environment variables (Preview, branch `Dev`)

Enter secrets in the Vercel dashboard (Project → Settings → Environment Variables). Never commit
them or paste them into chat.

**qms-api**

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** (port 6543) as `qms_api`: `postgresql://qms_api.xvpgrmujayytbbmhnoan:<password>@<pooler-host>:6543/postgres`. Transaction pooling is safe: every request runs in one transaction (`SET LOCAL`). |
| `DATABASE_POOL_MAX` | `2` (each function instance holds its own small pool) |
| `SUPABASE_URL` | `https://xvpgrmujayytbbmhnoan.supabase.co` |
| `SUPABASE_JWT_SECRET` | Legacy JWT secret (Supabase → Project Settings → JWT). Sensitive. |
| `CORS_ORIGINS` | `https://qms-*-jamie-drydens-projects.vercel.app` — every address of this Vercel team: the branch alias, the production alias and per-deployment URLs (`qms-<hash>-…`, which is what the dashboard's *Visit* button opens). Only this team can own names ending in `-jamie-drydens-projects.vercel.app`; `*` never matches `.` or `/`. |
| `NODE_ENV` | `production` |
| `SUPABASE_SERVICE_ROLE_KEY`, `INVITE_REDIRECT_URL` | Optional: lets the API email invitations and read uploaded integration files (without it file imports answer `503 file_storage_unavailable`). `INVITE_REDIRECT_URL` = `https://qms-web-git-dev-jamie-drydens-projects.vercel.app/set-password?mode=invite`. The service-role key is sensitive. People who already have an account get a sign-in link to `/accept-invite` instead (built from `APP_BASE_URL`, else beside `INVITE_REDIRECT_URL`). |
| `MAIL_PROVIDER`, `RESEND_API_KEY`, `MAIL_FROM` | (With a provider, **invitations are sent by the API as branded emails** too — see `docs/email-setup.md`, which also covers the Supabase templates and redirect URLs every email link needs.) |
| `MAIL_PROVIDER`, `RESEND_API_KEY`, `MAIL_FROM` | Optional: email notifications. Unset (or `none`) = **outbox only**: emails are built and queued as they would be sent and marked not sent (the operator panel's Email tab shows them). `resend` sends through Resend (key server-side only; `MAIL_FROM` like `Fortress QMS <alerts@your-domain>` on a domain verified with Resend). Links in the emails use `APP_BASE_URL`. The queue is worked after every change; the daily cron `/internal/cron/email` is a safety net (on Vercel Pro it can run every few minutes). |

**qms-web**

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://xvpgrmujayytbbmhnoan.supabase.co` |
| `VITE_SUPABASE_KEY` | Publishable / anon key (public by design) |
| `VITE_API_URL` | `https://qms-api-git-dev-jamie-drydens-projects.vercel.app` (no `/api/v1`; the client adds it) |

`VITE_*` values are compiled into the bundle, so change them and then redeploy.

## Other settings

- **Supabase → Authentication → URL Configuration:** add `https://qms-web-git-dev-jamie-drydens-projects.vercel.app/**`
  (and `https://qms-web-*-jamie-drydens-projects.vercel.app/**` for per-deployment addresses) to Redirect URLs.
- **Deployment protection:** keep Vercel Authentication on for `qms-web`. Turn it off for `qms-api`
  (the browser cannot send Vercel's login cookie cross-origin, and CORS preflights would fail). The
  API still rejects anything without a valid Supabase token; only `/api/v1/health` and the OpenAPI
  docs are public.

## Limits of this setup

- Cold starts: the first request after a quiet spell is slower.
- Rate limiting is in memory, so it counts per function instance.
- Logs: Vercel → project → Logs (structured JSON from pino).

## Check it works

1. `https://qms-api-git-dev-jamie-drydens-projects.vercel.app/api/v1/health` returns `{"status":"ok","checks":{"database":"ok"}}`.
2. Sign in on the frontend address; Settings → Organisation loads (this calls the API).

## Background worker (WK1)

The worker is woken by **pg_cron in Supabase**, not by Vercel: every minute it calls `POST /api/v1/internal/worker/tick?source=pg_cron` on `qms-api`
through pg_net, with `Authorization: Bearer <CRON_SECRET>`. Set `CRON_SECRET` on `qms-api`, then apply `supabase/runbooks/worker-schedule.sql` in the
SQL editor (it installs pg_cron and pg_net, keeps the address and the secret in Vault and schedules the call). Keep deployment protection off for
`qms-api`. The operator panel's **Worker** tab (`/platform?tab=worker`) shows whether ticks arrive. The daily crons in `api/vercel.json` stay as a safety net.

## Production (fortress-qms.com, from 2026-11-17)

Production deploys from **`main`** to the same two Vercel projects (both projects' Ignored Build Step builds `Dev` and `main`, nothing
else). It uses the **same Supabase project** as Dev for now (decision 2026-11-17), so Dev and production share data, the worker and
the auth settings. A release = merging `Dev` into `main`.

| Address | Project | Notes |
|---|---|---|
| `https://fortress-qms.com` | `qms-web` (production domain) | `www.fortress-qms.com` redirects to it (308). |
| `https://api.fortress-qms.com` | `qms-api` (production domain) | |

**DNS (Cloudflare, "DNS only" — grey cloud, not proxied):** `A @ 76.76.21.21`, `CNAME www cname.vercel-dns.com`,
`CNAME api cname.vercel-dns.com`. Proxying through Cloudflare would put a second proxy in front of Vercel, so the API would see Cloudflare's
address instead of the caller's (network restrictions and rate limits depend on it; see `docs/security-exit-report.md` — it would need
`TRUST_PROXY_HOPS=2` and a locked origin), and Vercel issues the certificates itself.

**Production environment variables** (Vercel → project → Settings → Environment Variables → Production):

| `qms-api` | Value |
|---|---|
| `SUPABASE_URL`, `DATABASE_POOL_MAX`, `NODE_ENV` | as Dev |
| `CORS_ORIGINS` | `https://fortress-qms.com,https://www.fortress-qms.com` |
| `APP_BASE_URL` | `https://fortress-qms.com` |
| `INVITE_REDIRECT_URL` | `https://fortress-qms.com/set-password?mode=invite` |
| `AGENT_API_URL` | `https://api.fortress-qms.com` |
| `DATABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `AGENT_RELEASE_KEYS`, `MAIL_PROVIDER` / `RESEND_API_KEY` / `MAIL_FROM`, `SUPABASE_MANAGEMENT_TOKEN` | secrets, entered in the dashboard (the same database values as Dev while the database is shared) |

| `qms-web` | Value |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` | as Dev |
| `VITE_API_URL` | `https://api.fortress-qms.com` |

**Elsewhere:** Supabase → Authentication → URL Configuration: Site URL `https://fortress-qms.com`, Redirect URLs keep the Dev address and add
`https://fortress-qms.com/**`. Stripe webhook endpoint `https://api.fortress-qms.com/api/v1/stripe/webhook` (its signing secret is the
production `STRIPE_WEBHOOK_SECRET`). The worker (pg_cron, one per database) should call `https://api.fortress-qms.com/api/v1/internal/worker/tick`
once production is live: re-run `supabase/runbooks/worker-schedule.sql` with that address and the production `CRON_SECRET`. Vercel runs the
daily crons in `api/vercel.json` on production deployments only, so they start with the first production build.
