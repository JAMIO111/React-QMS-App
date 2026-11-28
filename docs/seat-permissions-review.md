# Seat permissions review

Seats are meant to be: **Controller (full)** = management and quality, **Contributor (operational)** = the people who do the work (the Operator seat, added in seats and prices 2026, is the shop floor: it raises NCs, records inspections and adds files to its own NCs), **Observer (view)** = other stakeholders who want to see data. A review of the live package levels (2026-11-27) compared that intent with what each permission needs, and found operational permissions doing a manager's job, operators who could start a record but not finish it, and sensitive reads at the view level.

What a person can do is their role's permissions **and** their seat's level (`app.has_permission`); a permission is tied to a module and a level in `public.features` (`min_access_level`). Administration rights (members, roles, security, billing, external access) are never tied to a seat (`app.unpriced_permissions()`).

## Changed (migration `20260466100000_seat_permission_split.sql`)

| Permission | Level | What it covers |
|---|---|---|
| `ncr.contribute` (new) | operational | Add files and containment actions to a non-conformance **you raised** (checked in the database by `created_by`). `ncr.update` (full) still edits any NC, its costs, stage and the "no containment needed" reason. |
| `receiving.record` (new) | operational | Record a delivery, start and decide a received line, record material certificates. |
| `receiving.manage` | **full** (was operational) | Create, change, close and cancel purchase orders, move an agreed date, cancel a delivery. The agreed date feeds the supplier's on-time score. |
| `shipping.record` (new) | operational | Record a shipment. |
| `shipping.manage` | **full** (was operational) | Create, change, close and cancel customer orders, move an agreed date, cancel a shipment. The agreed date feeds the customer's on-time score. |
| `inspection.acknowledge_failure` (new) | full | Acknowledge a failed reading with a note instead of raising a non-conformance. It used to need `inspection.record`, so the person who measured could clear their own failure and finish the job with no NC and no second person. An operator can still raise an NC (`ncr.create`). |
| `change.approve` | **full** (was operational) | Every other approval is full. |
| `integrations.run` | **full** (was operational) | Integrations are Controller-only anyway; the table now says so. |
| `audit.read` | **full** (was view) | The audit trail shows every change to every table with before and after values, past the module permissions. |

Roles: everyone who held `ncr.create`, `receiving.manage` or `shipping.manage` is given the matching new permission (custom roles too); everyone who held `inspection.correct` or `inspection.override_gauge` is given `inspection.acknowledge_failure`. The built-in **Inspector** no longer holds `receiving.manage` or `shipping.manage` and does not get `inspection.acknowledge_failure`. A custom role keeps what it chose; on a Contributor seat a role holding `receiving.manage` now gives `receiving.record` only.

Code: the API guard accepts a list of permissions (`@OrganisationScoped(['ncr.update', 'ncr.contribute'])`: any one is enough, and the database still decides ownership and site); the screens show the NC page's files and containment to a contributor on their own NC, and the order pages show Record a delivery or shipment apart from Close, Cancel and the agreed date. Tests: `supabase/tests/seat_permission_split.test.sql`, `api/test/seat-permission-split.e2e-spec.ts`, `NcrContainment` and order page tests.

## Not changed, and why

- **NC costs** are read with `ncr.read` (`ncr_costs_select`), so every inspector and viewer sees cost of poor quality. A separate cost permission would ripple through the register's total, the dashboards, the customer and supplier figures and the reporting views; it needs its own slice.
- **Production** has no operational permission: lot and order status changes need `production.manage` (full). Inspectors can create an inline order through `inspection.record`. Whether operators should put a lot on hold is a product decision, not a permission one.
- **`competence.assess`** stays operational (team leaders on Contributor seats assess; level 4 already needs `competence.manage`); **`competence.read`** exposes everyone's assessments at the view level.
- **Document control, 8D and production** have no operational feature, so a Contributor seat equals an Observer seat there. Action owners (8D, risk, FMEA, review) finish their own actions, and anyone acknowledges documents and alerts, with read permission only, so an Observer seat is not strictly read-only.
- The Observer/Contributor/Controller **module levels** (`subscription_entitlements`) are unchanged.

## Checking a change like this

A new permission needs a `features` row (or a place in `app.unpriced_permissions()`): `every_feature_priced.test.sql` fails otherwise. Role seeds for new organisations come from the global template roles (`roles.organisation_id IS NULL`), which the migration also changes.
