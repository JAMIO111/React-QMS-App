# Operator job hub — exit report

**Plan:** `docs/operator-hub-plan.md` · **Slices:** OH1 API, OH2 start, OH3 hub, OH4 panes, OH5 this check · **Date:** 7 Nov 2026

## What was built

A streamlined operator screen over the existing in-process inspection. **A job is an in-progress inspection record** (no new table), so the resolver, frozen
requirements, sampling, gauges, retests, corrections, NC raising and SPC alerts are the tested ones.

- **Start (dashboard card, pop-up):** part number first, which resolves to the control plan in force (loading card, then green with the plan and revision, or red with
  the resolver's reasons and nothing further). The operation is chosen from the operations on that plan (a single one is chosen for them), then the machine (the last
  one used on the device is remembered). Quantity is asked only when a check is sampled every N parts. Site, start time and operator are filled in by the server.
  The card also lists the person's running jobs to resume.
- **Hub (`/Jobs/:id`):** job summary with elapsed time; work order, quantity, lot and serial editable while the job runs (saved as each field is left, optimistic,
  restored on error); the recording components shared with the inspection page (`inspection/recording.jsx`): sample plan, sample entry, readings, corrections, retests,
  failures, complete and abandon.
- **Panes:** right-edge launchers with counts and attention dots open one pane at a time over the right side (no backdrop, recording stays usable); previous/next in
  each. Quality alerts (wording, required action, files: pictures inline through signed links, documents opened in a new tab), recent non-conformances (why relevant,
  link), revisions (New flagged, in force, which one the job runs on) and a banner when a newer part or control plan revision is in force. A pane is shown only to people
  who may read its content.
- **Database:** migration `20251207100000_job_details.sql` (applied live): work order, lot, lot size and serial may change while a job is in progress, through
  `app.set_job_details` (needs `inspection.record` at the site; audited); everything else on the record stays frozen.
- **API** (`api/src/jobs/`): `GET /jobs/preview` (machine optional), `POST /jobs`, `GET /jobs/mine`, `PATCH /jobs/{id}`, `GET /jobs/{id}/recent-ncrs`, `GET /jobs/{id}/revisions`;
  the inspection list takes `mine=true`.

## Evidence

| Check | Result |
|---|---|
| API unit tests | 154 pass |
| API e2e (33 suites, incl. `jobs.e2e-spec.ts` 15 tests and the tenancy sweep with the new routes) | 414 pass |
| Frontend unit tests | 604 pass (job card, pop-up, hub, panes, combo lists) |
| Lint / build | 0 errors / builds |
| SQL test `job_details.test.sql` | passes in `npm run db:check` |
| Browser journey (`npm run journey`, real app + API + migrated database) | passes: sets up a part with an effective plan, an alert and an NC through the API; starts a job from the dashboard, types the work order, opens each pane, records the check and completes with a pass. Screenshots `21`–`27` |
| Live database | migration applied; `app.set_job_details` has a fixed search_path and no `anon` execute; no function in public/app/audit is anon-executable or has a mutable search_path; advisors show only the two known warnings (GraphQL table visibility, leaked-password protection still off) |

Mutation checks (each made a test fail): machine match in recent NCs, plan-valid check and quantity rule in the pop-up, loading card, save-only-when-changed and
restore-on-error in the hub, removed files shown, broken next button, pane permission gates, combo list in a portal.

## Found by the browser journey

The first real-browser look found "1 checks" in the pop-up (now "1 check") and showed that a screenshot taken during the 300 ms slide shows no pane (the journey now waits).
An earlier unit test run found that a failed save left the typed text in the field (fixed).

## Limits

- **PDFs and other documents open in a new tab**, not inline: not confirmed that a private storage link can be framed.
- **Alert files in a browser** were not exercised by the journey (the stand-in storage holds nothing): pictures, signed links and the document row are covered by unit tests only.
- Opening an alert in the pane records it as **viewed** (existing behaviour of reading an alert).
- When a pane is open it overlays the right side of the page, including part of the job card.
- Touch sizes follow the app's 44 px targets but were not tried on a tablet.
- No work order list exists, so the work order is typed; when one is available it should become a pick-list (nothing here blocks that).
- Not built: barcode scanning, offline mode, ERP/MES integration, time clocks, shift handover, blocking operators, push notifications.
- Live guardrails were checked for the rules this change touches (4 and 7), not by running the whole guardrail file.
