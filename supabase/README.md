# Database migrations

Migrations for the Supabase project **"React QMS"** (`xvpgrmujayytbbmhnoan`).

| File | What it is |
|---|---|
| `migrations/20251103000000_baseline.sql` | The schema as it existed when it was brought under version control (built in the dashboard). Already present remotely — **do not apply it there**. |
| `tests/supabase_stubs.sql` | Minimal `auth` / `storage` stand-ins so migrations run on plain Postgres. Local only. |
| `tests/*.test.sql` | SQL tests; each file must exit cleanly (raise an exception to fail). |

## Checking migrations locally

```sh
npm run db:check
```

Creates a throwaway Postgres cluster, applies the stubs and every migration in order, then runs
`tests/*.test.sql`. Needs Postgres server binaries (`initdb`, `pg_ctl`); set `PGBIN` if they are
not under `/usr/lib/postgresql/<version>/bin`.

The baseline was verified against the remote project on 2026-11-03: a fingerprint of every public
column, constraint, function signature and view (287 items) matched exactly.

## Applying to the remote project

New migrations are applied with the Supabase CLI (`supabase db push`) or reviewed and applied by
hand. Before the first push, record the baseline as already applied so it is skipped:

```sh
supabase link --project-ref xvpgrmujayytbbmhnoan
supabase migration repair --status applied 20251103000000
```

## Conventions (from docs/design-brief.md)

- One migration per change, named `YYYYMMDDHHMMSS_short_description.sql`; never edit an applied migration.
- Incremental and reversible where practical; never silently drop or rename data.
- Every new tenant-owned table: `id uuid`, `organisation_id uuid not null`, `created_at/by`, `updated_at/by`, RLS enabled with policies in the same migration.
- Add or extend a `tests/*.test.sql` for each migration.
