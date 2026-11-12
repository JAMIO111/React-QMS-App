# Risk and management review — exit report

**Date:** 2026-11-12 · **Plan:** `docs/risk-management-plan.md` · **Slices:** RK1–RK4, MR1–MR3, RX · **Branch:** `Dev`

## What was built

Two modules sharing one plan (ISO 9001 §6.1, §6.2, §9.3; IATF 16949 §6.1.2). **Information only: nothing here blocks work.**

- **Risk register (RK1):** one register of risks and opportunities (`RSK-001` …), the organisation's 5 × 5 matrix as versions (labels, a band per cell, the acceptable level, review months per band), ten seeded categories, and inherent assessments scored by the database.
- **Treatment (RK2):** a strategy (mitigate / avoid / transfer / accept; exploit / leave for opportunities), actions given to people (closed by the person given them without managing risks), residual assessments, acceptance of what is left above the acceptable level by an approver **other than the proposer**, periodic reviews and review dates from the band, closing with an outcome and reopening. The status is worked out, never set.
- **Links (RK3):** links to NCs, 8Ds, audit findings, suppliers, parts, part families, machines, documents and operation codes; raising a risk from an NC, an 8D (D7) or an audit finding, prefilled, the source kept as its origin; a Risks card on those records, the supplier profile and the machine.
- **Heat map, dashboard, my work, notices (RK4):** `/Risk` dashboard, `/Risk/Heat-map` (in force / before / after treatment), `/Risk/My-Work` with a menu badge, notices to a risk's new owner and to the person an action is given to.
- **Quality objectives (MR1):** objectives with an owner, a target and a direction, typed in per period (corrections kept) or worked out from a fixed system measure (NCs raised, supplier PPM, 8Ds on time, audit pass rate) as the person reading.
- **Management reviews (MR2):** plan, attendees, start (the twelve ISO 9001 §9.3.2 inputs gathered from the modules' own dashboards as the person, frozen as snapshots), commentary and "reviewed" per section, minutes, decisions, actions, complete (frozen), cancel, a printable report.
- **Notices and home (MR3):** the person given a review action is told and closes it from My review actions (no permission needed), a management review card and "For you" tiles on the home page.
- **Exit check (RX):** this report, the live checks below and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20260218100000`, 112 SQL tests incl. `risk_register_core`, `risk_treatment`, `risk_links`, `risk_notices`, `quality_objectives`, `management_reviews`, `management_review_notices`, guardrails and the tenancy sweep) | pass |
| `npm run api:test` (343) and `api:test:e2e` (87 suites, 982 tests incl. `risk`, `quality-objectives`, `management-reviews` and the API tenancy sweep for every new route) | pass |
| `npm test` (1,468 Vitest tests), `npm run lint` (0 errors), `npm run build` | pass |
| Live guardrails (`supabase/checks/guardrails.sql` against the live project, full lists) | **0 violations**; the "must be audited" rule lists the fifteen risk, objective and review tables |
| Live objects | every migration (`20260208200000` … `20260218100000`) checked after it was applied: tables, functions, triggers, policies, the twelve sections, the notice event types (own_record and emailed for review actions) and `emit_notification` carrying every branch (documents, competence, 8D, risk, review actions) |
| Advisors (security) | no finding about these modules. The two warnings are project-wide: every table is visible to GraphQL (214 objects) and **leaked-password protection is off** (a Supabase dashboard setting) |
| Advisors (performance) | INFO only for these tables: foreign keys without a covering index (the audit and actor columns, and the composite review / risk keys whose single-column indexes lead with the id) and indexes not yet used (the tables are new). The one WARN is the CAPA actions table's two update policies (CAPA6, by design) |
| Browser journey (`npm run journey`) | the whole journey passes with the new step: the owner raises a risk from the "Rod bore burr" NC (prefilled, the NC as its origin), assesses it 4 × 4 = 16 high, chooses to mitigate it, assesses what is left 3 × 4 = 12 high (still above medium) and proposes accepting it; **Colin (another approver) accepts it**; the owner records a review and the risk is monitoring; the dashboard lists it and the heat map shows it in the 12 · High cell. The owner defines a quality objective and records 97 % (on target), plans a management review for this month, invites Colin and starts it (every section gathered, the objective and the risk among them), writes the two commentary-only sections, ticks all twelve reviewed, records Colin as present, a decision and an action for Colin, and completes it; Colin closes his action from My review actions, his notice is in the table, and the report prints the decision and what Colin did |

## What the browser found

1. **"Reviewed in the meeting" did not tick at once.** The checkbox showed the cached review, and the optimistic update reached the cache only after the in-flight fetches were cancelled, so for a moment a click looked as if it had done nothing (the journey's click "did not change its state"). The box now shows the new state at once and is put back if the save is refused.
2. **Two saves of one section could undo each other.** Writing a commentary-only section and then ticking it sends two saves (leaving the box, then the tick); if the first reply arrived last it put `reviewed: false` back in the cache. Only the last save still in flight now writes the server's answer to the cache (`useReviewInput`, `mutationKey` + `isMutating`); the refresh afterwards settles it.

Two test-only findings, kept as notes for whoever writes the next journey step: a required field's name in Chromium includes the red `*` drawn by CSS (`To *`), so match the start of the label (`/^To\b/`), not the exact text; and `getByLabel('Commentary')` also matches a checkbox whose label mentions "commentary" — use the role.

## Rules held by the database (not only the screens)

No table writes on any of these tables: every change is a SECURITY DEFINER function, and the record tables are frozen by triggers even for SQL. Assessments are scored by the database from the matrix version in force and are append-only; a residual assessment needs an inherent one; a risk above the acceptable level reaches monitoring (or closes as accepted) only with an approved acceptance **of that very assessment**, decided by someone other than the proposer; reviews and acceptances are frozen once recorded; a risk's origin never changes and its link cannot be removed. Quality objective values are one current per period and append-only; the measure, frequency and first period never change. A completed or cancelled management review, its inputs, attendees and decisions never change; its actions live on and are closed by their owner or a manager. Nothing is deleted.

## Design notes and limits

- **No worker.** Review dates, overdue actions and objectives' standing are worked out on read; the home card says when the last management review is over a year old; nothing sends a reminder when a review or action falls due.
- **Gathering is as the person.** A review's inputs show what the person who started it (or gathered a section again) may read; a section they may not read is stored "not available", never as zeros. The snapshot is written by `app.set_management_review_snapshot`, which only the API calls; check in the Supabase dashboard (API settings → Exposed schemas) that the `app` schema is not exposed, so it cannot be called from a browser.
- **Targets have no history:** changing an objective's target judges every period against the new one.
- Not built: risk due-date reminders, risks on the home page's "By area" cards, a heat map over time, FMEA (S × O × D) feeding the register, objectives per site or department, a review schedule or recurring reviews, attachments and signatures on a review, a subscription feature for either module.
- The dashboards were tested for correctness, **not load-tested**.

## Go-live runbook

Nothing to switch on. To use the modules: a risk manager (`risk.manage`: owner, admin, quality manager, quality engineer) adjusts the matrix and categories (Settings → Data Management → Risk; changing the matrix needs `risk.approve`) and raises risks; an approver accepts what is left above the acceptable level. A management review manager (`management_review.manage`: owner, admin, quality manager) defines the quality objectives and plans the reviews (Management review → Reviews).
