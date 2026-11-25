# Impact assessment: polling, reminders, per-row permission checks

Written 2026-11-25, before any change. Nothing here has been implemented. Figures are labelled **measured** (live project or local throwaway database) or **estimated** (arithmetic).
Background: `docs/capacity-assessment.md`.

## 1. Polling

**What polls today.** `Navbar` (always mounted) runs up to nine queries every 5 minutes, each gated by the person's permissions except tasks: workflow tasks, quality alerts, documents, risk work, changes, FMEA actions, 8D actions, management review actions (and `Header` runs notifications every 60 s, `limit=100`). That is up to **168 requests an hour per open tab** (108 badges + 60 notifications). Four of the badge endpoints return whole lists (8D actions, FMEA actions, review actions, tasks) to read one number.

**Pausing already exists.** No hook sets `refetchIntervalInBackground`, and TanStack Query's default is off, so a hidden tab does not poll. A visible tab left open (a shop-floor station) polls all shift. Switching back to a tab refetches anything older than 60 s (`staleTime`).

**Volume (estimated, 30 people, 1 visible tab each, 8 h x 22 days):** about 890,000 requests a month today. Each pays the per-request guard transaction (measured 18.5 ms mean, 92 ms for the second variant) before its own query.

| Option | Requests / tab / hour | Monthly | Change |
|---|---:|---:|---|
| Today | 168 | 890k | |
| A. One `GET /badges` (counts only, with the unread-notification count) every 60 s; the notification list fetched only when the pane opens or the unread count changes | 60 | 320k | -64% |
| B. As A, every 2 minutes | 30 | 160k | -82% |
| C. A or B plus slow polling after 10 minutes without input | lower on idle stations | | |

**Changes needed.** Server: a `BadgesService` (membership only) that counts each area in **one** transaction, an area `null` when the caller may not read it (the rule `home-dashboard` already uses), each area guarded so one failure never blanks the rest. Client: `useBadges()` for `Navbar` (and the Home "For you" tiles); the individual badge hooks lose their `refetchInterval` (their pages still refresh on open, on focus and after any action through `refreshOrganisation`); the notification list becomes on demand. Tests: a comparison e2e that fails when a badge differs from the endpoint a page shows (the pattern in `home-dashboard.e2e-spec.ts`), `Navbar` / `HomeAttention` tests, the API sweep for the new route.

**Risks.** Badge numbers drifting from the pages (the comparison test is the guard); a bell that takes up to a minute (or two) to light, as today at one minute for A; kiosk tabs that expect fast updates (C is optional for that reason). **Dollar saving is small** (Pro: about $0.60 per million requests, Active CPU about $0.18 an hour, so roughly $1-3 a month); the point is headroom, the Hobby limits, and database load as users grow. No migration, no data change, reversible by reverting the commit.

## 2. `app.system_run_reminders` (and a wider fault it exposes)

**Cause (measured).** Not the reminder logic. The function calls `app.organisation_time_zone(org)` for every organisation on every tick, and that function validates the site's zone with `site.timezone IN (SELECT name FROM pg_timezone_names)`. `pg_timezone_names` re-reads the operating system's zone files on every scan: **120-830 ms for one scan live** (598 rows). Both live organisations have no `time_zone` setting, so each call takes that path: `organisation_time_zone` for the two organisations costs 258 ms, which is the function's 220 ms mean. 16,331 calls came to 3,587 s, the largest database time on the project.

**The same function costs every caller:** `GET /organisations/current` (the settings read, 635 calls at 380 ms mean), the daily scorecard schedule, workflow timers, FMEA due dates and the reminders page.

**Fix.** Replace the `pg_timezone_names` check with a validity test that costs microseconds (a small plpgsql helper that tries `now() AT TIME ZONE zone` and falls back on error; measured 0.0055 ms per call locally against 120-830 ms). Behaviour is unchanged for valid IANA names; the one difference is that a zone abbreviation Postgres accepts (such as `EST`) would no longer be skipped, which I would keep out with a name-shape check so behaviour stays identical. One migration (a function replacement, no table change), a test for valid, invalid and missing zones, nothing for the API. **Risk: low**, since only the validity test changes, and the existing reminders, scorecard, workflow and FMEA tests exercise every caller. Expected result: the function from about 220 ms to about 1 ms, and the settings read from about 380 ms to about 1 ms.

**Adjacent, not included unless you want it:** `cron.job_run_details` (16,453 rows, 9 MB) and `app.worker_ticks` (7,945 rows, 22 MB) have no purge. A daily purge is a few lines.

## 3. Per-row permission checks elsewhere

**Where.** Of 302 SELECT or ALL policies on the live database, **235 evaluate a security-definer permission function once per row**: 181 `app.has_permission(organisation_id, 'x')`, 25 with a site argument, 29 `app.is_member(organisation_id)`; 62 are other forms and 4 are the inspection policies already fixed. Measured locally, **every pattern costs 0.13-0.17 ms per row per policy** (has_permission 0.160, with site 0.165, is_member 0.127, with a per-row site lookup 0.166), against **0.0004 ms** with the fast path. Live was measured earlier at about 0.4 ms per policy evaluation.

**It matters only where a request reads many rows.** Counting is the clearest case: every paginated list computes `total` by counting the **whole filtered set** through the policies (`receiving.service.ts` line 104: `select count(*) from purchase_orders o join suppliers s ... where <filter>`). At the proving client, a purchase order list with `status=all` counts 100,000 rows through two policies: about **28 s locally** (and more on Micro) before the 25 rows are fetched; goods receipt lists similarly. The load test harness already searches POs this way and will show it.

**It is a net loss on small tables.** The fast path adds a fixed cost of about 1 ms per policy per statement (measured: 1.3 ms for the whole statement at 3,000 rows). It pays for itself above about 7 rows per table (local rates; about 3 at live rates), so applying it to all 235 policies would slow detail pages that read a few rows from many tables. **Apply it only to tables that are read in bulk.**

**Proposed scope (volumes at the proving client; counts and registers read the whole filtered set):**

| Tier | Tables | Why |
|---|---|---|
| 1 | `purchase_orders`, `purchase_order_lines`, `goods_receipts`, `goods_receipt_lines`, `receipt_line_dispositions`, `incoming_inspection_determinations` (receiving.read, org-wide) | 100k orders, ~300k lines, ~40k receipts |
| 1 | `parts`, `part_revisions`, `part_revision_characteristics` (`is_member`) | 10k parts; search, pickers, dashboards |
| 2 | `nonconformances`, `ncr_costs`, `ncr_dispositions`, `ncr_containment_actions`, `ncr_attachments`, `ncr_affected_lots` (site-scoped) | 3k NCs a year, registers and the dashboard read whole periods |
| 2 | `lots`, `serial_numbers`, `production_orders`, `production_operations` (site-scoped), `spc_alerts`, `supplier_scorecards` | serials can reach 75k+ a year |
| Leave | the other ~210 policies | small tables; the fixed cost would not pay back |

**Mechanism.** The same as `20260448100000`: `organisation_id IN (SELECT app.orgs_permitted('perm')) OR <the existing check>` (and an `orgs_member()` twin for `is_member`), applied with `ALTER POLICY` so roles and commands are unchanged. Written so the old expression is kept as the fallback, nothing is widened. Site-scoped tables keep the site check for people with site-limited roles.

**Risks and tests.** A mistyped policy could hide rows or show too many: each one is checked by the existing suites (the cross-tenant sweep and the guardrails, which test every table), per-table SQL tests for an organisation-wide person, a site-limited person, a suspended member and another organisation's owner, and the e2e suite. Policy changes take a brief lock per table and are not data changes. One migration, reversible by putting the old policies back. After applying, measure with the load test harness (PO and receipt lists are the labels to watch).

## Decisions I need

1. **Polling:** option A (60 s) or B (2 min)? Add the idle slow-down (C)?
2. **Time zone fix:** go ahead, and include the cron / worker-tick purge?
3. **Policy scope:** Tier 1 only, Tier 1 and 2, or inspection-only until the load test shows what hurts?
