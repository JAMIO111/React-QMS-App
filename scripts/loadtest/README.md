# Load test harness

Proves how Fortress behaves with a client's year of data and a working day of people, before a client does. **Built, not yet run.**
Background: what a load test is, and the numbers it is checked against, are in the capacity assessment given to the owner (to be saved as `docs/capacity-assessment.md`).

## What it does

1. **Guard** (`guard.cjs`): refuses to start unless the database is a throwaway. The live Supabase project and the public addresses are always refused; a local database is allowed; a
   remote *test* project needs `LOADTEST_ALLOW_HOST` **and** `LOADTEST_CONFIRM` to repeat its host and must be given as `LOADTEST_DATABASE_URL` / `LOADTEST_ADMIN_URL`; and a database that
   holds any organisation whose slug does not start `loadtest-` is refused even if everything else passed.
2. **Starts the real API** (`api/dist/main.js`, as a child process, production mode) so its memory and CPU are the API's alone.
3. **Seeds a year** (`seed.cjs`) through the real API, so every rule, trigger, audit event and outbox row is the production one: 100 part families with effective control plans, 10,000 parts,
   300 suppliers, 100,000 purchase orders (3 lines), deliveries against 40% of them, 3,000 non-conformances and 75,000 completed inspections (5 samples × 8 checks each, 80% of them on 10% of
   the parts, 3% drifting so failures, acknowledgements and SPC alerts happen). Only the organisation and its people are SQL (a person creates those by signing up). Optional redate spreads timestamps over the year.
4. **Plays a day** (`driver.cjs`): 30 people (inspectors recording samples, engineers on SPC and registers, managers on dashboards and orders, viewers), everyone's badge polling every
   5 minutes, and the worker tick every 5 minutes, with an 8 hour day compressed into 30 minutes (every think time and interval divided by the time scale).
5. **Reports** (`report.cjs`): per label p50/p95/p99, error counts, database / API / machine peaks, bytes per reading, slowest statements (when `pg_stat_statements` is available) and a PASS / FAIL
   against the limits in `profile.cjs` (page p95 ≤ 1 s, dashboards ≤ 3 s, saves ≤ 1.5 s, polling ≤ 0.5 s, errors ≤ 0.1 %).

## Running

```
npm run loadtest:check                      # offline: unit tests of the harness and every request body checked against the API's own schemas
LOADTEST_PROFILE=smoke npm run loadtest     # a few minutes; proves the harness works end to end
LOADTEST_REDATE=1 npm run loadtest          # the full profile: ~10 GB of disk, Postgres server binaries, hours (the seed is most of it)
```

`npm run loadtest` builds the API, runs the checks, then starts a throwaway Postgres through `scripts/db-check.sh` with Micro-like settings
(`shared_buffers=224MB`, `max_connections=60`) and runs `run.cjs`. Output goes to `$LOADTEST_OUT` (default `/tmp/loadtest-<time>/`): `report.md`, `report.json`, `state.json`, `api.log`.
A local database is deleted when the command ends, so seed and test run together. To seed once and test many times, use a **separate Supabase test project**:

```
LOADTEST_DATABASE_URL=<qms_api login of the test project> LOADTEST_ADMIN_URL=<admin login of the test project> \
LOADTEST_ALLOW_HOST=<its host> LOADTEST_CONFIRM=<its host> LOADTEST_PHASE=seed node scripts/loadtest/run.cjs
LOADTEST_STATE=<out>/state.json LOADTEST_PHASE=test ... node scripts/loadtest/run.cjs
```

The test project needs the migrations applied and must be empty of real organisations. Never point it at the live project: the guard will not let you.

Settings (all environment variables, defaults in `profile.cjs`): `LOADTEST_PROFILE` (smoke | day | stress), `LOADTEST_SCALE`, `LOADTEST_DURATION_SEC`, `LOADTEST_POOL_MAX` (the API's connection pool, 15 like
the Supabase pooler gives), `LOADTEST_SEED_CONCURRENCY`, the `LOADTEST_P95_*_MS` limits and `LOADTEST_MAX_ERROR_RATE`.

## Reading a result

- Look at the machine first: if the load average or the database CPU saturated the machine, a slow label is the harness, not the product. A local run shares one machine between the API, the database and the load.
- A 400 or 404 on a label means a path or query in `driver.cjs` no longer matches the API (fix the harness); allowed 4xx (403 on a dashboard a role may not read) are listed apart.
- Compare database size and connection peak with the plan you intend to buy, and API memory with the function memory limit.
- Run the same profile against a separate Supabase test project for the figures that matter; a laptop result is a smoke test, not a promise.

## Verified and not verified

Verified without running the harness: the guard (7 tests, plus a refusal of the live addresses through `run.cjs`), the statistics and verdict (14 tests), and every request body and query against the API's compiled
schemas (24 checks). **Not verified until the first run:** the response shapes the seed and driver read (`revisions[0].id`, `operations[0].id`, `lines[].quantityOrdered`, `schedule`, `measurements`, the
dashboards' query strings) and the polling paths. A first `smoke` run is expected to find a few of these; fix them in the harness, not by loosening the guard.
