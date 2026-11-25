# Capacity assessment: Fortress against Supabase and Vercel plan limits

Written 2026-11-25 from the live project and the vendors' pages read that day. Prices and limits move: re-read the vendors' pages before buying. The load test harness that proves
section "How to prove it properly" is `scripts/loadtest/` (built, not yet run; see its README). Item 1 under "What the live data says I should worry about" (the two slow SPC queries) is dealt with in `docs/capacity-assessment-followup.md` once measured.

Each number is labelled as measured on your live project, read from the vendors' current pages, or my estimate.

## Where you are today (measured)

- **Your Supabase organisation is on the Free plan.** It is named "JDigital", and it also holds a second project, "Break Room". Fortress is a Postgres 17 project in eu-west-2. Free is not production-capable.
- **Your live database is small.** It is 105 MB: 303 tables, 1,106 indexes, 1,359 functions, 1,204 triggers and 483 RLS policies. It allows 60 direct connections and has a 224 MB shared buffer, which is the Micro-class instance. So today's timings are representative of Micro.
- **Vercel looks like Hobby, but I couldn't confirm it.** The billing endpoint returned "costs not found". Daily-only crons and the note in your `CLAUDE.md` about the Hobby CPU allowance both point to Hobby.

## Plan limits vs Fortress

**Supabase Pro** (from supabase.com pages read today):

| Item | Pro includes | Fortress, 20–30 users |
|---|---|---|
| Base price and compute credit | $25 a month, $10 compute credit (covers one Micro) | Credit is shared by the whole organisation. Break Room would add its own compute (about $10), unless you move or pause it. |
| Compute | Micro $10 (1 GB RAM, 60 direct / 200 pooler connections), Small $15 (2 GB), Medium $60 (4 GB) | Micro is the weak point (see the risks below). |
| Database disk | 8 GB, then $0.125/GB | About 8–10 GB in year one |
| Recommended maximum database size | Micro 10 GB, Small 50 GB | Year one reaches Micro's ceiling. |
| File storage | 100 GB, upload limit up to 500 GB | 5–25 GB (estimate) |
| Egress | 250 GB uncached plus 250 GB cached | About 25 GB a month (estimate) |
| Monthly active users | 100,000 | 30 |
| Backups | 7 daily; point-in-time recovery is $100 a month for 7 days | You decide whether to buy it. |
| Spend cap | On by default; it does not cover compute | You decide. |

**Vercel** (from vercel.com pages read today):

| Item | Hobby | Pro |
|---|---|---|
| Invocations | 1M included | $0.60 per million (the pages conflict on this) |
| Active CPU | 4 hours included | $0.177 per hour in London |
| Cron jobs | Daily only, ±59 minutes | Per minute |
| Deployments per day | 100 | 6,000 |
| Concurrent builds | 1 | Up to 500 |
| Runtime log retention | 1 hour | 1 day |
| Price | Free | $20 per seat, including a $20 usage credit |

**Hobby is probably not usable for a paying client.** I believe Vercel's fair-use terms limit Hobby to personal, non-commercial use. The pages I fetched don't say so, so check Vercel's fair-use policy page yourself. Separately, the numbers below show Hobby's limits would be exceeded anyway.

## The volume model

**Database growth (measured per-row sizes, my volume assumption).** Each reading costs about 630 B in its table and indexes. Its audit event adds about 1.05 KB, because `inspection_measurements` has an audit trigger. That is roughly 1.9 KB per reading.
- Formula: GB a year ≈ inspections/day × 250 × readings per inspection × 1.9 KB.
- At 300 inspections a day and 40 readings each, that is about 5.7 GB of readings. With samples, inspection records, 100k purchase orders, 3,000 NCs and 10,000 parts, year one lands near 8–10 GB.
- **Your earlier estimate holds.** The audit trigger was the unknown, and I've now confirmed it, so the estimate sits at the upper end.

**API requests (estimated from the code).** The app has 9 background polling hooks. Notifications poll every minute and 8 badge counters poll every 5 minutes, about 2.6 requests a minute per open tab. That gives roughly 1.2–1.4 million requests a month, about 70% of them background polling. That is over Hobby's 1M invocations.

**Active CPU is an assumption.** At 50–100 ms of CPU per request, Fortress would use about 18–36 hours a month, against Hobby's 4. On Pro that is about $3–6 a month.

## Monthly cost for the first client

- **Supabase:** Pro $25 plus Small $15, less the $10 credit, is about $30. Add $10 if Break Room stays in the organisation.
- **Vercel:** Pro $20 for one seat. The usage should sit inside the $20 credit.
- **Total:** about $50–60 a month, plus $100 for point-in-time recovery if you buy it.
- **Not included:** Stripe fees and email.

## What the live data says I should worry about

1. **The slowest queries read far more data than they return.** The SPC overview query averages 1.46 s and reads about 48,000 blocks (roughly 380 MB) per call, against a table of about 2,000 rows. It looks like a join that multiplies rows, and it won't survive 3 million readings as written. The SPC chart query averages 237 ms for about 190 rows, roughly 1.2 ms per row of row-level security. Anything that touches more than about 10,000 rows in one request will take seconds. Both need `EXPLAIN` at volume before a client goes live.
2. **The worker schedule doesn't match your notes.** `CLAUDE.md` says five minutes, but the live pg_cron job is `0 * * * *`, hourly. Workflow notices, queued imports and scheduled runs can wait up to an hour. The earlier every-minute schedule is also why `cron.job_run_details` holds 16,452 rows (9 MB) that nothing purges, and `app.worker_ticks` holds 22 MB.
3. **Supabase's Data API reloads its schema cache constantly.** Its introspection query ran 521 times, writing about 6 GB of temporary files at roughly 480 ms each. The schema is large, and every migration triggers a reload. Your frontend makes no table or function calls to that API (I searched for them), only auth and storage. Turning it off should remove this load and an attack surface. Test that in a staging project first.
4. **Every API request pays a guard transaction first.** The query averages 18.5 ms on empty tables, and a second variant averages 92 ms with a 6.6 s maximum, probably cold connections. This is fine for throughput but sets the latency floor.
5. **Memory on Micro is unmeasured.** It has 1 GB of RAM, a 224 MB shared buffer, up to 15 pooled backend connections, and 1,204 triggers and 1,359 functions per backend. Read the memory chart under load before trusting Micro.
6. **Advisors found little.** Free-plan advisors are not final, but these are the findings:
   - 1,385 unindexed foreign keys, mostly composite tenant keys. The impact is low while parent rows are never deleted.
   - 114 unused indexes, which is meaningless on near-empty data.
   - One duplicate-policy warning on `capa_actions` (UPDATE).
7. **Two things I couldn't verify:**
   - Whether the reporting API's largest page (5,000 rows) stays under Vercel's 4.5 MB response limit.
   - Supabase's built-in email rate limit for sign-up and password-reset mails. From memory it is very low, so set up your own mail service for those (Resend) before launch.

## How to prove it properly

1. **Move off the Free and Hobby plans first.** Test on the tier you will actually sell, not the free one.
2. **Seed a realistic year of data through the real insert path** (audit triggers on):
   - 3 million readings.
   - 100k purchase orders with their lines.
   - 10,000 parts.
   - 3,000 NCs.
   - 30 users with real roles.
3. **Replay a working day** with virtual users:
   - The real polling mix.
   - 300 inspections recorded.
   - SPC chart opens.
   - Dashboards.
   - Registers.
   - A 100k purchase order import through a template.
   - Worker ticks and the daily reminders run.
4. **Measure and set pass criteria:**
   - Interactive routes: p95 under 1 s.
   - Dashboards: p95 under 3 s.
   - No 5xx errors.
   - Database CPU under 60% sustained and memory under 80%.
   - Pool wait under 100 ms.
   - Import completes without slowing interactive use.
   - Database growth matches the formula.
5. **Run it twice: Micro and Small.** The difference tells you which tier to sell.
6. **Prove the operational side too:**
   - Do a restore rehearsal.
   - Set spend and usage alerts.
   - Check both vendors' usage dashboards after the run.
