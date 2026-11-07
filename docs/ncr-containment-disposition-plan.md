# NC containment and disposition — plan

**Status:** built and live (NC1 database, NC2 API, NC3 UI); migration `20251209100000_ncr_containment_disposition.sql` applied live · **Closes:** Phase 2 slice 2.5 (`docs/phase-2-plan.md` §2.3, §3) for containment and disposition · **Builds on:** NC core (2.4), costs and files, CAPA / 8D, inspections raising NCs

## 1. The gap

An NC can be opened and moved through "Contained → Investigating → Dispositioned → Awaiting closure → Closed", but the stages are only labels: nothing records what was contained, and nothing records
what happens to the affected items. A forward move can even skip stages (Open straight to Closed). The brief's use case (§16, points 5–8) needs both recorded, approved and traceable.

## 2. Design

- **Containment actions** (`ncr_containment_actions`): what was done to stop suspect product going on: kind (quarantine, sort, stop ship, notify customer, notify supplier, recall, other), description, owner (an
  employee), due date, optional quantity contained, status open / done / cancelled. Done needs a result note (the evidence) and is stamped by the database (who, when); cancelling needs a reason; nothing is deleted.
  If no containment is needed, the NC records **why** (`containment_not_needed_reason`).
- **Dispositions** (`ncr_dispositions`): the decision for a quantity of the affected items: rework, repair, scrap, use as is, return to supplier, concession; quantity, instructions, a reference (the customer's
  written approval for a concession, the RMA for a return). Proposed by anyone who can edit the NC; **approved only through `app.approve_ncr_disposition`** by someone with the new permission
  `ncr.approve_disposition` (owner, admin, quality manager). The preparer may approve their own. An approved disposition is frozen: to change it, an approver cancels it (reason) and a new one is proposed.
  The quantities of proposed and approved dispositions can never add up to more than the quantity affected, and the quantity affected cannot be reduced below them.
- **Cumulative stage gates**, enforced by the database and shown by the API (`app.ncr_gate_problems`): to reach **Contained, Investigating, Dispositioned, Awaiting closure or Closed**, containment must be resolved
  (every containment action done or cancelled, and at least one done, **or** a reason none was needed). To reach **Dispositioned, Awaiting closure or Closed**, dispositions must also be settled: none still proposed,
  and approved dispositions cover the whole quantity affected. Skipping ahead cannot bypass them. Cancelling, reopening and the draft → open step are unchanged. **Existing NCs keep their stage**; the rules apply from their next move.
- **Not in this slice:** tracking that a disposition was carried out (decision only, agreed), investigation records and the "linked CAPA or no CAPA needed" gate before closure, lots and serials as affected items
  (Phase 3: a disposition will then name its lots), notifications to approvers.

## 3. Decisions (agreed)

1. **Cumulative gates** (not only at the stage's own move).
2. **Decision only** for dispositions (no completion tracking yet).
3. The preparer may approve (consistent with revision corrections); who did each is on the audit trail.
4. A concession needs a reference at approval (the customer's written approval); other decisions do not.

## 4. Slices

- **NC1 — database.** Migration, permission, functions, triggers, SQL tests, guardrails and sweeps; existing tests that move NCs forward get the records they now need.
- **NC2 — API.** Containment and disposition endpoints, `containment`, `dispositions` and `gates` on the NC detail, history, e2e, tenancy sweep, mutation checks.
- **NC3 — UI.** Containment and Disposition cards on the NC page with the "still needed" list for the next stage, approve / cancel dialogs, side-menu entries, unit tests, journey step with screenshots, docs, CLAUDE.md.

## 5. Built, and how it was checked

- **NC1** `supabase/migrations/20251209100000_ncr_containment_disposition.sql`, `supabase/tests/ncr_containment_disposition.test.sql` (all 52 test files pass). Nine mutation checks (each gate, the approval right, the quantity cap, frozen
  approved dispositions, the quantity-affected floor, the concession reference, the done note, cancelling an approved disposition) each make the test fail. The existing tests that move NCs forward now settle them first (`pg_temp.settle_ncr`).
- **NC2** `api/src/ncr/ncr-workflow.*`; `api/test/ncr-workflow.e2e-spec.ts` (14 tests), tenancy sweep; all 450 e2e tests pass (`settleNcr` test helper).
- **NC3** NC page: Containment and Disposition sections (with side-menu entries), "Needed for the next stage" on the stage bar; 16 new unit tests with mutation checks; browser journey step (screenshots `34`–`36`).
- The browser found a real bug (a `<form>` inside the NC page's form, fixed: the card now has no form of its own and a test guards it) and two journey races/false positives (now fixed).
- **Limits:** the NC History section still shows only changes to the NC itself, not containment or disposition events (they are on the audit trail and each record shows who and when); no notification to approvers when a
  disposition is proposed; a disposition does not track completion; dispositions name a quantity, not lots (Phase 3); investigation records and a "linked CAPA or none needed" gate before closure are still to do.
