# Custom roles — plan

Status: **agreed 2026-11-27. RL1 (database), RL2 (API) and RL3 (screens, journey step) built; the migration is not yet applied live; RLX (exit check) still to do.**

## 1. What this is

An owner can make their own roles ("Calibration technician", "Supplier quality lead") by choosing which permissions each one carries, and give them to people exactly as the six built-in roles are given today. Nothing about *what a permission means* changes; this only lets an organisation group them differently.

## 2. What already exists (inspected 2026-11-27)

- `roles` (`organisation_id` null = system template, `is_system`), `role_permissions`, `user_role_assignments`; both tables are audited; every organisation holds copies of the six templates (all `is_system`, so read-only to people).
- Row-level security already lets a holder of `roles.manage` (Owner only) insert, update and delete **non-system** roles in their organisation, and add role permissions **only from `app.my_grantable_permissions`** (what they hold themselves, plus the `integrations.*` their own roles carry). Assigning a role needs the same rule (`app.can_assign_role`), and a member holding permissions the assigner lacks cannot be managed.
- The API can only list roles (`GET /roles`) and permissions (`GET /permissions`); the Users page shows the roles read-only. No custom role exists live (0 of 12 organisation roles).
- 79 permissions: 64 are tied to a module through `features`, 15 are administration (`members.*`, `roles.manage`, `security.*`, `subscription.*`, `billing_details.manage`, `payment_methods.manage`, `invoices.read`, `organisation.manage`, `external_access.*`).
- A role never overrides the subscription: `app.has_permission` = role **and** two-factor/SSO/seat rules **and** the package level (`features.min_access_level` view / operational / full), so a custom role cannot give a Contributor seat Controller rights.

## 3. Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| R1 | Granularity | **A checklist of individual permissions grouped by module, each with its description, and quick buttons per module (Select all, View only, Clear).** | The first idea was None / View / Operate / Full per module. The package levels are about *pricing*, not about what a role should do (editing an NC, `ncr.update`, is "full"), so they would mislead. |
| R2 | Who may make roles | **`roles.manage` (Owner).** The existing grant rule stands: nobody can put a permission in a role that they do not hold. | Already in the database; no new permission. |
| R3 | Permissions a custom role may not carry | **`roles.manage`** (role administration stays with the Owner role). | Otherwise a custom role could rewrite roles; held by trigger, so it holds for every path, including direct API calls. |
| R4 | Built-in roles | Owner, Admin, Quality manager, Quality engineer, Inspector and Viewer stay fixed. **Start from** copies one into a new custom role. | Keeps the Owner invariant and support predictable. |
| R5 | Deleting | **Refused while anyone holds the role** (`QM041` → `409 role_rule`, with the number of people). Today the assignment would silently go with it (the foreign key cascades). | Silent loss of access is the worst failure here. |
| R6 | Limits | At most **30 custom roles** per organisation; names unique ignoring case; a role needs at least one permission; name ≤ 60 characters, description ≤ 200. | Keeps the lists usable. |
| R7 | Changing a role others hold | Allowed, takes effect at once for everyone holding it; the screen shows how many people hold it and says so before saving. Every change is in the audit trail (`role_permissions` and `roles` are audited). | What an owner expects; the audit trail answers "who changed it". |
| R8 | Packages | The editor hints, per permission, which seat level it needs (view = Observer, operational = Contributor, full = Controller) and says a role cannot exceed the seat. | Otherwise an owner will think a correct role is broken. |
| R9 | Edit conflicts | Role rows carry `rowVersion`; saving a role updates the role row so a save made from an out-of-date screen is asked about, as everywhere else. | Two owners editing one role is plausible. |
| R10 | Department-scoped roles | **Not changed.** Department scope on an assignment only takes effect where a check passes a department (none do yet). | Out of scope; stated in the screen. |

## 4. Slices

- **RL1 migration `20260464100000_custom_roles.sql` + SQL test:** `app.save_custom_role(org, role id | null, name, description, permissions[])` (SECURITY DEFINER; `roles.manage`; the grant rule; R3, R5 not applicable, R6; name → key; updates the role row so versions move; replaces the permission list as a whole; refuses system roles) and `app.delete_custom_role(role)`; triggers: no `roles.manage` in a custom role (even for SQL), no delete while assigned, the 30-role limit, name unique ignoring case, system roles' permissions frozen against direct change by people. Error `QM041` → `409 role_rule`.
- **RL2 API:** `POST /roles`, `PATCH /roles/{id}`, `DELETE /roles/{id}`, `GET /roles` carries `holders` and `rowVersion`, `GET /permissions` carries `module` and `needs` (the seat level); e2e (grant rule, forbidden permission, in-use delete, another organisation's role is 404, packages not exceeded) and the tenancy sweeps.
- **RL3 screens:** `/Settings/Roles` (menu entry for `roles.manage`): the list with who holds each role, **New role** (name, description, start from), the editor (modules with checklists, quick buttons, seat hints, how many people are affected, still-needed list), delete with the holders' count; the Users page's Roles card links to it and shows custom roles; tests; journey step (make a role, give it to Colin, see what he can and cannot do).
- **RLX exit:** live guardrails and advisors, the full journey, CLAUDE.md, exit note.

## 5. Not built (kept for later)

Role history screen (the audit trail has it), copying a role to another organisation, roles per department that take effect (R10), time-limited roles, approval of a role change.
