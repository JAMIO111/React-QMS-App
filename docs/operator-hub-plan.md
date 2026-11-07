# Operator job hub — plan

**Status:** built (OH1–OH5; exit report `docs/operator-hub-exit-report.md`) · **Branch:** `Dev` · **Builds on:** in-process inspection (PC4/PC5), SPC alerts (PC11), quality alerts (DOC1–DOC3), NC register, master data

## 1. What it is

A streamlined, shop-floor version of the in-process inspection screen. The existing inspection pages stay exactly as they are (they are the quality
engineer's view). The operator gets one place for a job:

1. **Start a job** from a card on the main dashboard. A pop-up asks for only two things: **the machine** they are on and **the part number (and work order)**.
   Everything else is filled in: site (from the machine), start time (now), operator (the signed-in person), operation (when the plan has only one), control
   plan and part revision (the resolver already does this).
2. **The job hub** — a screen like the inspection page (the process checks to record, live pass/fail, the sampling schedule) plus a **job info** header and
   three **slide-in panes from the right**, each with prev/next to cycle through the items:
   - **Quality alerts** in force for this part / family / machine / operation, with their attachments viewable in the pane.
   - **Recent non-conformances** relevant to the part / family / machine / operation.
   - **Revisions**: recently released part revisions and recently effective control plan revisions, flagged **New** so the operator notices them.
   Each pane has a launcher on the right edge with a count badge (and a dot when something is new or unacknowledged).

## 2. Design (what I would build)

- **A job is an in-progress inspection record. No new job table.** Starting a job calls the same `app.start_inspection` (so the resolver, the frozen
  requirements, sampling rules, gauges, retests, corrections, NC raising and SPC alerts all keep working and are tested). Machine, part, work order, site,
  `started_at` and `created_by` (the operator) are already columns. A job ends the way an inspection does (complete or abandon). The hub is a different
  *screen* over the same record, reachable at `/Jobs/:id`.
- **Start pop-up** (new `POST /jobs`, a thin wrapper that derives the rest): machine (active machines, search by code or name; remembers the last one on this
  device) → part number (search) → work order (free text, with this machine's recent work orders as one-tap suggestions). Site comes from the machine (a
  machine without a site falls back to the organisation's only site, else the pop-up asks). Operation: only asked when the part's effective plan has more than
  one operation. A lot size is asked only when the plan samples every N parts (the existing rule). If the requirements cannot be resolved (no effective
  plan, unit mismatch …) the pop-up says why in the resolver's own words and does not start.
- **One running job per person per machine** is offered for resuming instead of starting a second: the dashboard card shows *Resume* with the machine,
  part and elapsed time for the person's in-progress jobs.
- **Context for the panes** (new read endpoints, all server-side and permission-checked, nothing computed in the browser):
  - Alerts: the existing `GET /quality-alerts/active?partId|partFamilyId|machineId|operationCode` (a part also matches its family), most severe first, each
    with the caller's `acknowledged`; attachments through the existing signed-URL download. Acknowledging stays where it is (the alert page); the pane
    shows the state and a link.
  - Non-conformances: new `GET /jobs/{id}/recent-ncrs`: NCs of the **same part**, of the **same family**, and NCs **raised from an inspection of the same
    machine or operation** (NCs themselves carry no machine or operation, so that link goes through `inspection_ncr_links`); open ones first, then most
    recent; the last 90 days by default (`?days=`), at most 20; deleted and cancelled ones excluded; needs `ncr.read` at the site. Each item: reference, stage,
    severity, title, detected date, what matched (part / family / machine / operation), the failing characteristic where known, quantity, containment status.
  - Revisions: new `GET /jobs/{id}/revisions`: part revisions of this part released in the last 30 days and effective control plan revisions in scope
    effective in the last 30 days, with the change summary / change reason, who released it and when; **New** when released after the operator's previous
    job on this part (or in the last 7 days when there is none). Plus a banner on the hub when the job runs on a revision that has since been superseded.
- **Screen:** touch-first (large targets, no hover-only actions), the checks stay the main thing; the panes slide over the right side and never block
  recording. The recording components of `InspectionPage` are lifted into shared components so the two screens cannot drift apart.
- **Permissions:** starting and recording need `inspection.record` (site-scoped, as now). Each pane appears only if the person may read what is in it
  (`documentation.read`, `ncr.read`, `master_data.read`); a pane they cannot read is hidden, not empty.
- **No migration is needed for the first slices** (no new table). A small migration may add indexes (for the NC and revision lookups) once the queries
  are measured; any new table would need the usual tenancy, audit and guardrail work, so I would rather avoid one.

## 3. Decisions (agreed)

1. **A job is one in-progress inspection record** (no separate job entity). A job entity with several inspections and a summary can come later.
2. **Work order:** no work order list exists, so the operator starts with **only the machine and the part** (chosen from lists) and **types the work order
   and the quantity afterwards, on the hub** (job info, editable while the job runs; migration `20251207100000_job_details.sql`,
   `app.set_job_details`). Where a plan samples every N parts the quantity is needed to schedule the samples, so the start pop-up asks for it then
   (and only then). **When work order information becomes available** (an import or a register) the work order field becomes a list to choose from;
   that is not built now, and nothing here blocks it.
3. **Alerts and revisions are information only** (unacknowledged alerts and new revisions are clearly marked; nothing blocks recording).
4. **Operation:** asked only when the part's plan has more than one operation.

## 4. Slices (each complete and tested before the next)

- **OH1 — API.** `POST /jobs` (derive and start), `GET /jobs/mine` (in progress), `GET /jobs/{id}/recent-ncrs`, `GET /jobs/{id}/revisions`; SQL/e2e tests,
  tenancy sweep entries, permission and site-scope tests, mutation checks.
- **OH2 — Start.** Dashboard card (*Start new job*, *Resume*), the start pop-up, last-machine memory, work-order suggestions, resolver problems shown.
- **OH3 — Hub screen.** `/Jobs/:id`: job info header, the checks (shared recording components), live pass/fail, sampling due, complete/abandon.
- **OH4 — Panes.** The sliding pane with launchers and badges, cycling, alert attachments viewer, NC items, revision flags and the superseded-revision banner.
- **OH5 — Exit.** Journey script step (start a job, record, open each pane), exit report, CLAUDE.md, a note of what is not covered.

## 5. Not in scope

Barcode/QR scanning, offline mode, ERP/MES integration, operator time clocks, shift handover notes, blocking operators from recording, push notifications.
