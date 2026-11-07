# Master data dashboard — plan

**Status:** built (MD1 API, MD2 page); agreed by delegation ("whatever you feel the dashboard should have") · **Menu:** Master Data → Overview (`/Master-Data`)

## 1. What it is

One page that answers "what master data do we have, is it in good shape, what changed lately, and is anything feeding it or consuming it?". Read-only; every figure
comes from the database through one API call, nothing is computed in the browser.

## 2. Contents

1. **Totals** — parts, part families, machines, customers, suppliers, employees: total, active, added in the last 30 days; each tile links to its register.
2. **Needs attention** (data quality, each with a count and a link): active parts with no released revision; active parts with no family; active parts with no customer;
   machines with no site; active employees with no department. A count of 0 shows as healthy, never hidden.
3. **Growth** — records added per week over the last 12 weeks, by kind.
4. **Shape** — parts per family (top 8 and "no family"), machines per site, active employees per department.
5. **Part revisions** — draft, released, superseded, obsolete.
6. **Recently added or changed** — the latest 10 records across all kinds, with who and when.
7. **Integrations and change events** — see §3.

## 3. Integrations: what is real and what is not

No connector, import or sync tables exist yet (brief §7 is a later phase and is not built early), so the page **does not show connector status, imports or sync runs**
and says so plainly. What is real today is the **transactional outbox** (`outbox_events`): key events from every module (for master data today only a part revision being released; also
inspections, non-conformances, plan approvals, calibrations, 8Ds) are already written there in the same transaction, ready for connectors. Creating or editing a part,
machine, customer, supplier or employee does **not** emit an event yet. The panel shows that stream (events in the last 24 hours, waiting for a consumer, the oldest waiting, by type, latest events). The outbox is
readable with `audit.read`; people without it see the rest of the page and a note on this panel. When connectors exist, this panel is where their state goes.

## 4. Not in scope

Editing from the dashboard, CSV import/export, connector set-up, duplicate detection, per-field completeness scoring, and any chart of data we do not have.

## 5. Built, and how it was checked

- API `GET /master-data-dashboard` (`api/src/master-data/master-data-dashboard.ts`, `master_data.read`); 9 e2e tests; mutation checks on every data-quality rule's active-only filter, the shape counts and the `audit.read` gate.
- Page `/Master-Data` (`src/components/master-data/MasterDataDashboard.jsx`, menu "Master Data → Overview"); 8 unit tests; the browser journey opens it over real data and compares the Parts tile with the database (screenshots `28`, `29`).
- The browser caught "Part familie" (a naive singular), clipped event names and an overstated claim about the event stream; all fixed.
- Limits: the growth chart is one series (the validated chart palette has three colours, so the split by kind is in the tooltip); the change-event list covers all modules; "added/changed" is judged from `created_at`/`updated_at`
  (edited more than two seconds after creation); the checks count active records only; no export, drill-down filters or per-field completeness.
