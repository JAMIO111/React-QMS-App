# Background worker, reminders and workflow rules — exit report

**Date:** 2026-11-13 · **Plan:** `docs/workflow-engine-plan.md` · **Slices:** WK1, WK2, WF1, WF2, WF3, WX · **Branch:** `Dev`

## What was built

The modules already recorded what needs doing; nothing chased it. This plan added a worker that runs every minute, daily reminders, and rules an organisation writes itself. **Rules tell people and give tasks; they never raise, close, approve or cancel a record** (W6). The one change a rule may make is putting a lot on hold, with a person's authority.

- **Worker (WK1):** pg_cron calls `POST /internal/worker/tick` every minute (`CronGuard`, the secret in Vault). One tick runs at a time; each step runs on its own, so a failing step never stops the others: quality alerts expire, documents settle, reminders, workflow rules, due jobs, email, waiting imports. A job queue (`app.worker_jobs`: idempotency key, back-off 1, 4, 16, 64 minutes) and outbox consumers (a delivery row per consumer and event). Operators see ticks, jobs, failures and backlogs on the **Worker** tab of `/platform`.
- **Reminders (WK2):** once a day, at the organisation's reminder time, in its time zone, each person gets **one digest** of what of theirs is overdue or due soon, across twelve areas, plus one notice when something first goes overdue. Each item is checked as that person (still a member, may read it at its site, area not switched off). People see them at `/Reminders` and choose areas in Settings → Notifications.
- **Workflow rules (WF1):** "when this happens, if these conditions hold, tell these people / give this person a task". Eight triggers come from events the modules already write. Conditions are evaluated in code. Rules keep frozen versions, each change with a reason. A run happens once per version and event, and each notice or task goes out once per run, action and person, only to people who may read the record. Tasks appear in **My tasks** (`/Tasks`, menu badge, home "For you").
- **Rule builder (WF2):** Settings → Workflows. The rule is built with forms (when / if all or any / then), pauses, resumes and retires, and shows its versions and the latest runs in words. **Test the rule** runs the rule as it is on screen against a recent event: which conditions hold and whom each action would reach. Nothing is saved or sent.
- **Timers and lot hold (WF3):** "after N days, if the record still …" reads the record again when the time comes, and stops if the rule has been switched off. "Hold the lot" acts as the person who saved the rule version and is refused, recorded and reported when that person may no longer hold lots at that site.
- **Exit check (WX):** this report, the live checks below and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20260223100000`, the SQL tests incl. `worker_foundation`, `reminders`, `workflow_rules`, `workflow_tests`, `workflow_timers`, guardrails and the tenancy sweep) | pass |
| `npm run api:test` (348, incl. `conditions.spec.ts`) and `api:test:e2e` (90 suites, 1,003 tests incl. `worker`, `reminders`, `workflows` and the API tenancy sweep for every new route) | pass |
| `npm test` (1,506 Vitest tests), `npm run lint` (0 errors), `npm run build` | pass |
| Live guardrails (`supabase/checks/guardrails.sql` against the live project) | **0 violations**; the "must be audited" rule lists the reminder and workflow tables |
| Live objects | every migration (`20260219100000` … `20260223100000`) checked after it was applied: tables, functions with their grants (system functions callable by the API login only, none by anonymous callers, every one with a fixed `search_path`), the widened action-index checks, notice event types and `emit_notification` carrying the reminder and workflow branches; pg_cron ticks every minute (WK1) |
| Advisors (security) | nothing about these tables beyond the two project-wide warnings: every table is visible to GraphQL (222 objects) and **leaked-password protection is off** (a Supabase dashboard setting) |
| Advisors (performance) | INFO only for these tables: foreign keys without a covering index (actor and audit columns, composite run / rule keys) and indexes not yet used (the tables are new). The one WARN is the CAPA actions table's two update policies (CAPA6, by design) |
| Browser journey (`npm run journey`) | the whole journey passes with the new step: the owner writes "Failed reading at the cell" in Settings → Workflows (when an inspection reading fails, give Colin a task due in a day) and turns it on; Colin is given a risk action due tomorrow and the worker's reminder step gives him **one digest** with it; a reading then fails at the lathe; one tick runs the rule and **Colin has one task (TSK-26-0001)**, and a second tick gives him no other; Colin closes it from My tasks with a note; the rule's page shows the run (version 1, done, the task's reference); Colin's My reminders lists the risk action as due soon |

## What the browser found

The rule, the run and the task worked first time in the browser. The one fault was in the journey step itself: it gave Colin his risk action **after** the day's reminder run had already happened in an earlier tick. Reminders go out once a day per organisation, so no second digest came, which is the behaviour the plan asked for (W4). The step now gives the action before the first tick and sets the organisation's reminder time to midnight, so the journey does not depend on what time it runs.

## Rules held by the database (not only the screens)

No table writes on any of these tables. Every change is a SECURITY DEFINER function, and the worker's functions are callable only by the API login. A rule version is frozen even for SQL; a change to what a rule does needs a reason. A run is unique per rule version and event. A notice is unique per run, action and person, and a task per run and action, so a retried job never tells anyone twice (W9). Notices and tasks go only to active members who hold the trigger's permission at the record's site, checked as that person. A task's wording never changes; only its person (or someone who manages workflows) closes or reopens it, and cancelling needs a reason. A lot hold acts as the person who saved the version, under the lot's own rules, and is audited as them. Reminder digests are one per person per day, overdue notices one per record and due date; both are frozen and readable only by their person. Nothing is deleted.

## Design notes and limits

- **One Supabase project, one tick address.** pg_cron calls the address held in Vault: the `Dev` deployment until production exists (`supabase/runbooks/worker-schedule.sql`). The daily Vercel crons stay as a safety net.
- **Rules read the record as it is when they run,** not as it was when the event happened. A timer reads it again when its time comes. For a stage change, the stage moved to comes from the event.
- **Testing a rule** looks back 90 days and only at records the person testing may read. A timer's test says what it would do as the record is today.
- **The owner of the record** is the NC's owner, the inspection's recorder and so on, as `app.system_workflow_facts` defines it per trigger.
- Scheduled supplier scorecards were moved out of WF3 and built afterwards as SQ5b (`docs/supplier-quality-plan.md`). Not built: cancelling a waiting timer by hand, copying a rule, more triggers (SPC alerts, receipt line rejected, SCAR overdue), escalation to a manager by role from reminders, a time per person for reminders, webhooks (Phase 6).
- The worker was tested for correctness, **not load-tested**; a tick's budget is 40 seconds and a step that runs out of time carries on at the next tick.

## Go-live runbook

1. Already done: pg_cron and pg_net on, the tick scheduled every minute with the cron secret in Vault (WK1). Check the **Worker** tab of `/platform` shows ticks in the last hour.
2. Each organisation's reminder time defaults to 07:00 in its first site's time zone (Settings → Organisation → Daily reminders); people choose their areas in Settings → Notifications.
3. Someone with `workflows.manage` (owner, admin, quality manager) writes rules in Settings → Workflows and tests them against a recent event before relying on them.
4. When a production deployment exists, change the tick address in Vault to it (one SQL statement in the runbook).
