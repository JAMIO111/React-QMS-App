# Risk and management review — plan

**Status:** agreed 2026-11-11 (RM2 5 × 5 matrix, build order risk first (RK1–RK4 then MR1–MR3), RM12 manual and fixed system measures, RM5 approver other than the proposer — chosen by the user; the rest proposed and accepted with them), **RK1 and RK2 built** (§11, §12); RK3–RK4, MR1–MR3 and RX are not · **Branch:** `Dev`
**Menu names:** Risk (`ShieldAlert`), Management review (`Presentation`) · **Slices:** RK1–RK4, MR1–MR3, RX (exit check)

Per `docs/design-brief.md` §6.7 ("Risk management", "Management review and quality KPIs") and Phase 4 ("Risk and management review"), the last
Phase 4 item. Two modules that share one plan because the management review **reads** the risk register (and every other module) as its inputs.
Like the other Phase 4 modules they are complete, tested vertical slices, **inform and never block**, and reuse the engines already built
(actions are not a new engine where an existing one fits; NCs, 8Ds, audit findings, documents, suppliers, machines are **linked, never copied**).

## 1. What it is for

**Risk (ISO 9001 §6.1, IATF 16949 §6.1.2):** one register of the organisation's **risks and opportunities**: what could go wrong (or better),
why, what it would do, how likely and how bad, what is being done about it, what is left afterwards, who owns it and when it is looked at again.
A heat map shows where they sit; the dashboard shows what is high, untreated, overdue for review or newly raised from a problem.

**Management review (ISO 9001 §9.3):** the top-management meeting, done properly: a review is **planned**, its **inputs are gathered by the
system** for the period (NC and customer-complaint trends, 8D status, audit results, supplier performance, calibration, competence gaps, the risk
register, quality objectives, actions from the last review), people add their commentary, the meeting records **decisions and actions**, and the
completed review is **frozen** as the record an auditor asks for. **Quality objectives** (ISO §6.2) with targets and measured values are part of it.

**Not:** process FMEA tied to control plans (a later module, see §9), enterprise risk / finance, business continuity plans, a workflow engine,
a meeting scheduler or minute-taking for other meetings.

## 2. Decisions (proposed)

| # | Decision |
|---|---|
| RM1 | **One register for risks and opportunities** (`kind` risk \| opportunity). An opportunity scores benefit instead of harm on the same scale. |
| RM2 | **Scoring is a 5 × 5 matrix of likelihood × consequence**, the organisation's labels and band per cell (low / medium / high / critical), kept as **versions** like the supplier risk model; the database scores, so screen and record never disagree. An assessment freezes the model version it used. Not FMEA (S × O × D) in this module (§9). |
| RM3 | **Inherent and residual** scores: the inherent assessment before treatment, a residual one after. Both are **append-only** assessments (a new one supersedes); the risk shows the current of each. |
| RM4 | **Treatment** = one strategy (mitigate / avoid / transfer / accept / exploit for opportunities) plus **actions**. Actions reuse one pattern (owner = member, due date, done with a note, cancel with a reason, reopen) — the 8D actions' rules, in their own table (an action on a risk is not on an 8D). |
| RM5 | **Acceptance needs an approver**: a risk whose residual band is above the organisation's acceptance band (default medium) cannot be **accepted** (status monitoring / closed with "accepted") without `risk.approve` by someone other than the owner who proposed it (preparer ≠ approver, as supplier approvals). |
| RM6 | **Review dates computed on read**: each band has a review interval (e.g. critical 1 month, high 3, medium 6, low 12; configurable); `next_review_on` is set when assessed or reviewed; overdue is worked out, never stored, no worker. A review with "no change" is recorded with a note (as document periodic reviews). |
| RM7 | **Links, not copies:** a risk may link NCs, 8Ds, audit findings, suppliers, parts / part families, machines, operation codes, documents and departments. **Raise a risk from** an NC, an 8D (D7) or an audit finding, prefilled, the source linked. Supplier risk assessments stay where they are (a supplier risk is linked, not re-scored). |
| RM8 | **Statuses:** draft → open (assessed) → treating → monitoring → closed (with outcome: treated / accepted / no longer applies), retired with a reason; nothing deleted. A closed risk can be reopened with a reason. |
| RM9 | **Management review is a record, not a workflow**: planned → in progress → completed (frozen) \| cancelled. Completing needs every required input section reviewed and at least one decision or a note that none was needed. |
| RM10 | **Inputs are snapshots**: when a review is started, the system gathers each input for the review period from the module's own dashboard query **as the person** (RLS), stores the figures and lists as frozen JSON, and the person adds commentary per section. "Refresh" re-gathers until the review is completed; after that the snapshot never changes. A section the person may not read is stored as "not available", never as zeros. |
| RM11 | **Outputs:** decisions (text, category: improvement / resources / QMS change / other) and **actions** (same pattern as RM4, owner, due), plus attendees (members or named outsiders) and minutes. Open actions of the previous review are an input of the next. |
| RM12 | **Quality objectives:** objective, owner, measure, target with direction (at least / at most), unit, period, and **measured values** entered by hand per period (or from a fixed list of system measures: NC count, PPM from supplier quality, on-time 8D closure, audit pass rate). Shown with status on target / off target; reviewed in the management review. |
| RM13 | **Permissions:** `risk.read / .manage / .approve` (owner, admin, quality manager all; quality engineer read + manage; others read) and `management_review.read / .manage` (owner, admin, quality manager manage; quality engineer read; others none). Controller seats are not special here. |
| RM14 | Not subscription-gated (no feature mapped), like CAPA, audits, supplier quality and competence. Notices: the risk owner is told when a risk is assigned to them and when a review falls due is **not** sent (no worker; the dashboard and a menu badge show it); action owners are told when an action is assigned (own_record notice, as 8D actions). |

## 3. Data model (tenant tables: `organisation_id`, composite FKs, RLS, audit trigger, **no table writes: SECURITY DEFINER functions only**)

**Risk**
- `risk_models` — versions of the matrix: likelihood labels 1–5, consequence labels 1–5, band per cell (25 values), acceptance band, review months per band, reason. Default seeded per organisation (trigger).
- `risk_categories` — seeded (Process, Product, Supplier, Equipment, People, Information, Compliance, Customer, Environment, Other); on/off, key fixed.
- `risks` — `RSK-NNN` (counter per organisation), kind, category, title, description, cause, effect, owner (member), department / site (optional), status, strategy, outcome, `next_review_on`, current inherent / residual assessment ids, close reason, retire reason.
- `risk_assessments` — append-only: phase inherent | residual, likelihood, consequence, score, band (worked out by the database), model id + version, rationale, assessed by / on, `supersedes_id`, current | superseded.
- `risk_actions` — description, owner (member), due, status open | done (note, stamped) | cancelled (reason).
- `risk_reviews` — append-only periodic reviews: outcome no_change | reassessed, note, was due on, next review on.
- `risk_links` — one target per row (ncr / capa / audit_finding / supplier / part / part_family / machine / operation_code / document), replaced as a whole.
- `risk_acceptances` — proposed → approved | rejected | withdrawn, proposer ≠ approver, the residual assessment it accepts.

**Management review**
- `management_reviews` — `MR-YY-NN`, title, period from / to, planned on, held on, chair (member), status, minutes (TipTap JSON, like documents), cancel reason, completed by / at.
- `management_review_attendees` — member or named outsider, role, present / apologies.
- `management_review_inputs` — one row per section (fixed list, §5), snapshot jsonb, gathered at / by, available, commentary, reviewed (bool); frozen once the review completes.
- `management_review_decisions` — text, category.
- `management_review_actions` — as `risk_actions`, plus the decision it came from.
- `quality_objectives` — title, owner, measure (manual or a fixed system measure key), target, direction, unit, frequency (monthly / quarterly / yearly), active / retired.
- `quality_objective_values` — period start, value, note, entered by; one per objective and period; corrected by superseding, never edited.

Errors `QM026` → `409 risk_rule`, `QM027` → `409 management_review_rule`; other organisation `P0002` → 404.

## 4. Rules in the database

The database scores (`app.score_risk(model, likelihood, consequence)`), sets the band, refuses a residual assessment before an inherent one,
refuses accepting a risk above the acceptance band without an approved acceptance, enforces preparer ≠ approver, keeps assessments and reviews
append-only (trigger, even for SQL), refuses closing a risk with open actions unless it is accepted or no longer applies, sets
`next_review_on` from the band's interval, and refuses changes to a completed management review or its inputs (trigger). Completing a review needs
every required section reviewed. Quality objective values are one per period; a correction supersedes.

## 5. Management review input sections (fixed list, ISO 9001 §9.3.2)

| Section | Gathered from |
|---|---|
| Actions from previous reviews | `management_review_actions` of earlier reviews, open or closed in the period |
| Changes in issues (context) | commentary only |
| Customer satisfaction and feedback | NCs with source `customer` in the period (count, trend, top categories) |
| Quality objectives | `quality_objectives` and their values |
| Process performance and product conformity | NC dashboard (by source, category, cost), inspections first-pass rate, SPC signals |
| Nonconformities and corrective actions | NCs open / raised / closed, 8Ds by stage, overdue actions, verified effective |
| Monitoring and measurement results | calibration dashboard (due, overdue, failed) |
| Audit results | audits dashboard (completion, pass rate, findings open / overdue) |
| Performance of external providers | supplier quality dashboard (bands, PPM, on-time, SCARs) |
| Adequacy of resources | competence dashboard (gaps, expiring) + commentary |
| Effectiveness of actions on risks and opportunities | the risk register (by band, untreated high / critical, overdue reviews, closed in the period) |
| Opportunities for improvement | commentary + opportunities in the register |

Each is gathered with the existing dashboard endpoint's SQL (reused, not rewritten), stored as frozen figures.

## 6. API and UI (outline)

- `api/src/risk/`: models (`GET|PUT /risk-model`), categories, `GET|POST /risks` (page-based register: `q`, `kind`, `status`, `band`, `category`, `owner=me`, `reviewOverdue`, `linked` filters), `GET|PATCH /risks/{id}`, `POST …/assessments|reviews|actions|acceptances|close|reopen|retire`, `PUT …/links`, `POST /risk-actions/{id}/…`, `POST /risk-acceptances/{id}/decide|withdraw`, `GET /risk-heatmap`, `GET /risks-dashboard?from&to`, raise-from endpoints on NCs, 8Ds and findings (`POST /ncrs/{id}/raise-risk` etc.).
- `api/src/management-review/`: `GET|POST /management-reviews`, `GET|PATCH …/{id}`, `POST …/start|gather|complete|cancel`, `PATCH /management-review-inputs/{id}`, decisions, actions, attendees; `GET|POST /quality-objectives`, values; a print view.
- UI `src/components/risk/`: register (`/Risk`, `TableWrapper`, filters, saved filters), heat map (`/Risk/Heat-map`, inherent / residual switch), risk page (assess with live score preview, treatment and actions, links, acceptance, reviews, history), dashboard (`/Risk` default), Settings → Data Management → Risk (matrix model, categories, intervals). `src/components/management-review/`: list, review page (inputs as cards with the gathered figures and a commentary box each, decisions, actions, attendees, minutes editor, Complete), report (one document, print / save as PDF), quality objectives page with a chart per objective.

## 7. Slices

| Slice | Content |
|---|---|
| RK1 | Risk model (matrix versions), categories, risks, inherent assessments, register, risk page, Settings tab. |
| RK2 | Treatment: strategy, actions, residual assessments, acceptance with approver, periodic reviews, review dates. |
| RK3 | Links and "raise a risk from" NC / 8D / finding; risks shown on the linked record (NC page, supplier profile, machine). |
| RK4 | Heat map and risk dashboard; action owner notice; menu badge for my overdue risk reviews and actions. |
| MR1 | Quality objectives and their values (manual and fixed system measures). |
| MR2 | Management reviews: plan, attendees, input gathering (snapshot), commentary, decisions, actions, minutes, complete (frozen), report. |
| MR3 | Previous-review actions as an input, dashboard card, action owner notice. |
| RX | Exit check: live guardrails, advisors, browser journey step (raise a risk from an NC → assess → treat → accept with an approver → review; hold a management review end to end), exit report. |

## 8. Tests

Per slice: SQL test (rules, mutants), API e2e (+ both tenancy sweeps), component tests, and the journey step in RX. The management review's
gathering is tested against seeded data in every source module, as a person who may read some modules and not others.

## 9. Out of scope (stated so it is not assumed)

Process / design FMEA (S × O × D, RPN / action priority) linked to control plan characteristics — a separate later module that should **feed** this
register, not replace it; business continuity / contingency plans (IATF §6.1.2.3) beyond a risk record; automatic risks from rules; email /
reminders on a schedule (no worker); a meeting calendar; customer satisfaction surveys (customer feedback comes from customer NCs only).

## 10. Questions answered (2026-11-11)

| Question | Answer |
|---|---|
| How are risks scored? | 5 × 5 likelihood × consequence matrix, versioned (RM2) |
| Which first? | Risk (RK1–RK4), then management review (MR1–MR3), then the exit check |
| Quality objectives | Manual values plus a fixed list of system measures (RM12) |
| Accepting a risk above the acceptable band | `risk.approve` by someone other than the person who proposed it (RM5) |

## 11. RK1 as built (2026-11-12)

Migration `20260208200000_risk_register_core.sql` (applied live 2026-11-12; pushing the API before it leaves the risk endpoints failing).

- **Permissions** `risk.read` / `.manage` / `.approve` (owner, admin, quality manager all; quality engineer read + manage; inspector, viewer read).
- **Matrix:** `risk_models` (versions; `config` = five likelihood and five consequence labels, `bands[likelihood-1][consequence-1]`, `acceptanceBand` low | medium | high,
  `reviewMonths` per band; valid per `app.risk_model_problem`; frozen by trigger, only current → not current; default seeded per organisation: score 1–4 low, 5–9 medium,
  10–16 high, 17–25 critical, acceptable up to medium, reviews 12 / 6 / 3 / 1 months). `app.save_risk_model(org, config, reason)` (**`risk.approve`**, reason, unchanged refused).
  `app.score_risk(org, likelihood, consequence)` → score, band, labels, acceptable, model id and version (`risk.read`).
- **Categories:** `risk_categories` (ten seeded; RLS insert / update under `risk.manage`; key fixed; switched off, never deleted).
- **Risks:** `risks` (`RSK-001` … from `app.risk_counters`; kind risk | opportunity; category, title, description, cause, effect, owner = active member (default the
  person raising it), optional site and department; status draft → open; retired with a reason and brought back). Functions only: `app.create_risk(org, jsonb)`,
  `update_risk(id, jsonb)` (kind only while a draft; nothing once closed or retired), `retire_risk(id, reason)`, `reactivate_risk(id)`.
- **Assessments:** `risk_assessments` (append-only, frozen by trigger even for SQL; phase inherent; likelihood, consequence, score, band, the model id and version it
  was scored with, rationale). `app.assess_risk(risk, likelihood, consequence, rationale)`: the database scores it on the current matrix, the first one opens a draft,
  a later one supersedes. The review interval and acceptance band are stored on the matrix now and **used from RK2** (review dates, acceptance).
- Errors `QM026` → `409 risk_rule`; another organisation `P0002` → 404.
- **API** `api/src/risk/`: `GET|PUT /risk-model`, `GET /risk-score?likelihood&consequence`, `GET|POST /risk-categories`, `PATCH /risk-categories/{id}`, `GET /risks`
  (page-based: `q`, `kind`, `status` (default `live` = not retired; `all`), `band` incl. `unassessed`, `categoryId`, `owner=me`, `sort`
  reference|title|category|owner|status|score|assessedOn|createdAt), `POST /risks`, `GET|PATCH /risks/{id}`, `POST /risks/{id}/assessments|retire|reactivate`.
- **UI:** menu **Risk** (`ShieldAlertIcon`, `risk.read`) → `/Risk/Register` (`risk/RiskRegisterPage.jsx`), risk page `/Risk/Register/:id` (`RiskPage.jsx`: details,
  where it sits on the matrix, the reasoning, assessment history, "above the level your organisation accepts"), `RiskDialogs.jsx` (raise / edit, assess by choosing a
  cell, retire), `RiskMatrix.jsx` (every cell says its score and band in words; colour only repeats it), Settings → Data Management → **Risk**
  (`Settings/SettingsRisk.jsx`: matrix with **Change the matrix** for approvers — labels, click a cell to move its band on, acceptable level, review months, reason —
  and categories with an optimistic on/off), hooks `useRisk.js`, helpers `lib/risk.js`.
- **Tests:** `supabase/tests/risk_register_core.test.sql` (+ tenancy sweep seed, guardrails audit list), `api/test/risk.e2e-spec.ts` (+ API sweep), `risk/Risk.test.jsx`.
- **Not in RK1:** treatment, actions, residual assessments, acceptance, review dates (RK2); links and raise-from (RK3); heat map, dashboard, notices (RK4). Not browser-checked yet (RX).

## 12. RK2 as built (2026-11-12)

Migration `20260210100000_risk_treatment.sql` (applied live 2026-11-12; pushing the API before it breaks every risk endpoint: they select the new columns).

- **Treatment:** `risks.strategy` (mitigate / avoid / transfer / accept; an opportunity is exploited or left) and `treatment_plan`, set by `app.set_risk_treatment`.
  `risk_actions` (given to an active member, due date; done with a note, cancelled with a reason, reopened; never deleted). The person an action was given to
  closes it with only `risk.read`; everything else needs `risk.manage`.
- **Residual assessments:** `app.assess_risk(…, phase)`; `residual` is what is left after treatment and never comes before an inherent one. **The assessment in
  force** is the residual one when there is one, else the inherent one.
- **Acceptance (RM5):** a risk whose band in force is above the matrix's acceptable band needs a `risk_acceptances` row: proposed by a manager with a rationale,
  decided (approved or rejected, with a note) by someone else holding `risk.approve`. It covers the assessment it names, so assessing again asks afresh and
  withdraws a proposal still waiting. A risk within the acceptable band needs none (proposing is refused), nor does an opportunity.
- **Status is worked out, never set (RM8):** draft → open (assessed) → treating (a strategy is chosen) → monitoring (the "still needed" list
  `app.risk_treatment_problems` is empty: a strategy, no open action, a residual assessment unless the strategy is accept, and within the acceptable band or accepted)
  → closed (`app.close_risk`: treated / accepted / no longer applies, with a note; open actions are cancelled) → reopened with a reason.
- **Reviews (RM6):** `next_review_on` = the day of the assessment or review + the months the current matrix gives the band in force (or a date given). Overdue is
  worked out on read. `risk_reviews` is append-only: "no change" with a note, or "reassessed", written by every assessment after the first.
- **Decided while building:** an action's owner defaults to the risk's owner; closing as "treated" is refused for a risk whose strategy is accept (close it as
  accepted); retiring is refused while actions are open; a reopened or brought-back risk is due for review that day; the register's level filter uses the band
  in force.
- **Not in RK2:** links and raise-from (RK3); heat map, dashboard, notices and the menu badge (RK4). Not browser-checked yet (RX).

