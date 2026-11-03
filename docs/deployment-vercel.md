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
| `SUPABASE_SERVICE_ROLE_KEY`, `INVITE_REDIRECT_URL` | Optional: lets the API email invitations. `INVITE_REDIRECT_URL` = `https://qms-web-git-dev-jamie-drydens-projects.vercel.app/set-password?mode=invite`. The service-role key is sensitive. |

**qms-web**

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://xvpgrmujayytbbmhnoan.supabase.co` |
| `VITE_SUPABASE_KEY` | Publishable / anon key (public by design) |
| `VITE_API_URL` | `https://qms-api-git-dev-jamie-drydens-projects.vercel.app` (no `/api/v1`; the client adds it) |
| `VITE_UNIRATE_API_KEY` | Optional |

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
