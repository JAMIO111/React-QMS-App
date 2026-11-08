# CLAUDE.md

## Project direction — read first

**`docs/design-brief.md` is the authoritative product and architecture brief for this project.**
Read it before planning or making any substantial change, and refer back to it whenever a
decision touches scope, data model, tenancy, security, integrations or roadmap phase.

Summary of the brief:
- Product: multi-tenant, API-first **manufacturing QMS** + connected quality data / integration platform.
- Architecture: modular monolith, Postgres with RLS + server-side authorisation, canonical data
  model, append-only quality audit events, transactional outbox, connector framework.
- Delivery: complete, tested vertical slices, phase by phase (Phase 0 assessment → Phase 1
  platform foundation → Phase 2 inspection → NCR → CAPA workflow → …). Don't build future
  phases early.
- Agent rules: inspect before changing, preserve working code, plan before substantial changes,
  incremental reversible migrations, never claim unverified results, keep secrets out of source
  control and client bundles. See brief §2 and §14 (definition of done) and §15 (non-goals).

## Current state of the repo (after Phase 1, Nov 2026)

- Vite + React 19 (JavaScript, not TypeScript), Tailwind v4, TanStack Query/Table,
  react-hook-form + zod, Recharts. Supabase (auth, DB, storage) called directly from the client
  via `src/api/supabaseApi.js` and `src/supabase-client.js`.
- `api/` (npm workspace): NestJS 11 + TypeScript API at `/api/v1` — see `api/README.md`. Connects as
  the `qms_api` login and runs every query via `DatabaseService.asUser()` as `authenticated` with the
  caller's JWT claims (RLS + audit apply). New data access must go through it. Deployed with the
  frontend to a Vercel dev environment from `Dev` (`docs/deployment-vercel.md`).
- Routes in `src/main.jsx`; side menu in `src/MenuStructure.js`. Routed areas: Dashboard
  (simple overview), NC dashboard (`/Non-Conformance`, `NcDashboard.jsx`, data from `GET /ncr-dashboard?from&to&source`;
  chart colours are the validated `--chart-*` variables in `src/index.css`), Non-Conformance registers (`/Non-Conformance/:type` — Internal, Customer,
  Supplier; NC form at `/Non-Conformance/:type/:id`, `new` creates; hooks in `src/hooks/useNcr.js`), Master Data (parts, part families, machines, customers, suppliers and the employees register at `/Employees`; the old `/Human-Resources` redirects there), Settings.
- Holiday-let code was removed; it is preserved on branch `archive/holiday-let`.
- Database schema is versioned in `supabase/migrations/`; the live project matches it (see
  `supabase/README.md`). Multi-tenancy is in place: organisations, sites, departments, profiles,
  memberships, roles/permissions; `organisation_id` on every business table; RLS on every table
  with `app.is_member` / `app.has_permission` helpers. Legacy table names ("NCM", "Failure Mode"…)
  stay until Phase 2.
- Append-only quality audit trail in `audit.events` (trigger `audit.record_change` on tenancy and
  quality tables), readable via `public.audit_events` with `audit.read`. New quality-critical tables
  must get the `audit_changes` trigger.
- Frontend → API: `src/lib/api-client.js` (`apiFetch`, `VITE_API_URL`) and hooks in
  `src/hooks/useQmsApi.js` (`useMe`, `usePermissions`, organisation/site/department hooks). Used by
  onboarding (`CreateOrganisationForm`, `PendingInvitations`), the header `OrganisationSwitcher`,
  Settings → Organisation and Settings → Users & permissions. Menu items declare a `permission`;
  `useCanSee` hides those the user lacks.
  New features should call the API, not Supabase tables.
- Frontend reads the current user from `profiles` and memberships via `OrganisationProvider`;
  every query filters by the current `organisationId`. Storage paths: `nc-files/<org_id>/...`,
  `avatars/users/<user_id>/...`, `org-logos/<org_id>/logo/...` (all private).
- Product name: **Fortress QMS** (tab title `Fortress QMS | <organisation>` set in `App.jsx`; logo in
  `public/fortress-qms.png`, favicons `public/favicon-*.png`, `src/assets/fortress-qms.png` (rounded, dark square) and
  `src/assets/fortress-qms-mark.png` (transparent, dark backgrounds only)). Sign-in pages: `AuthPage.jsx` (form left,
  `auth/BrandPanel.jsx` blueprint panel right); auth actions use `authButtonClass` (Fortress blue, not the org theme). Organisation logo: `organisation_settings.logo_path`
  → private `org-logos` bucket at `<org_id>/logo/...` (members read, `organisation.manage` writes); shown in the
  side menu via `useOrganisationLogo()`, managed in Settings → Organisation (`OrganisationLogo.jsx`).
- Theme colour: `organisation_settings.theme_colour` (blue/red/yellow/green/orange/purple/pink, set in
  Settings → Organisation) → `<html data-theme-colour>` (`src/lib/theme-colours.js`,
  `ThemeColourSync`). `src/index.css` gives each mode three shades (`theme-light`, `theme`,
  `theme-dark` utilities) and derives `brand-*`/`cta-*` from them — use those tokens, not fixed
  purple/violet classes, for accent colour.
- Tables: reuse `src/components/Table.jsx` with a TanStack table instance (see its header comment and
  `TableWrapper.jsx`): one `<table>` + `<colgroup>`, so header and rows always line up. Sorting
  (header click, `sortDescFirst: false`), resizing (`columnResizeMode: "onChange"`, min/maxSize,
  double-click resets), show/hide and reorder via `ColumnVisibilityMenu` (`columnOrder`/`onColumnOrderChange`: drag handles, Move up/down), header drag-and-drop to reorder (table opts in with `enableColumnReordering: true`; pinned columns and `enableReordering: false` stay put; helpers in `src/lib/columnOrder.js`), `meta.pin: "left" | "right"` keeps a column fixed
  while the rest scroll sideways (row select / actions in `TableWrapper`). Persist with
  `useTablePreferences(key)` (visibility, sizing and order); when `columnSizing` is controlled also use `useColumnSizingInfo()`
  or resizing lags one mouse move. Column meta: `align`, `sortKey` (server sort field).
- Auth: `/forgot-password`, `/set-password` (invite/reset landing), `/mfa` (code or set-up).
  `AuthProvider` exposes `assurance` (`aal1`/`aal2`); `ProtectedRoute` sends users to `/mfa` when
  needed. `organisation_settings.require_mfa` is enforced in the DB membership helpers
  (`app.mfa_satisfied`); API answers `403 mfa_required`.
- Master data (2.1): `units` (global), `customers`, `suppliers`, `parts`, `part_revisions` via API
  (`src/hooks/useMasterData.js`, pages in `src/components/master-data/`). Revision lifecycle and
  outbox events are enforced by DB triggers; emit new events with `app.emit_event` from SECURITY
  DEFINER triggers only. New tenant tables: table-level INSERT + `app.stamp_created()`,
  column-level UPDATE, no DELETE, `audit_changes`, add to guardrails + both sweeps.
- **Employees register** (Master Data → Employees, `/Employees`, `master-data/EmployeesPage.jsx`; the old HR page and cards are gone): migration `20251205100000_employees_register.sql` (applied live) turns the legacy `"Employees"` table into a register — `employee_number` (unique per organisation, any case), `email`, `site_id`, `department_id` (composite FKs; `app.employee_rules` fills the site from a department and refuses a department at another site), audit trigger, `app.stamp_created`, **no deletes** (deactivate) and column-level UPDATE. API `api/src/employees/`: `GET /employees` (page-based: `q`, `status`, `siteId`, `departmentId`, `sort`, `order`, `page`, `pageSize` → `{ data, page, pageSize, total }`), `GET /employees/lookup` (everyone, for pickers; the NC responsible-employee picker uses it), `POST`, `GET|PATCH /employees/{id}` (`master_data.read` / `.manage`). UI: same pattern as the other registers (`TableWrapper`, `employeeColumns.jsx`, `EmployeeFilterPane.jsx`, `useEmployeeFilters`, `useEmployeeRegister` under the `master` query key so `useMasterDataMutation` updates it optimistically) with the add/edit pop-up `EmployeeDialog.jsx` (read-only without `master_data.manage`). Employees are personnel, not necessarily system users (`hasLogin`, `login`). **Linking an employee to a sign-in** (`Employees.auth_id`, shown in the Sign-in column and the form's "Sign-in account" section) is **Controller-seat holders only**: migration `20251206100000_employee_login_link.sql` (applied live) — `app.link_employee_login(employee, user|null)` (needs `master_data.manage` AND `app.holds_controller_seat(org)`; the target must be an active member, one employee per sign-in; `QM016` → `409 employee_rule`; `auth_id` is not in the column-level UPDATE grant, so nothing else can write it), `app.employee_login_candidates(org)` (members, `master_data.manage`). API `PUT /employees/{id}/login` `{ userId | null }`, `GET /employees/login-candidates` → `{ canLink, data }` (`SignInLink` in `EmployeeDialog.jsx` offers the controls only when `canLink`). An organisation with no Controller seat assigned to anyone cannot link.
- Buttons: `CTAButton` types and `buttonClass` (`master-data/shared.jsx`): `main`/`primary` (theme colour), `secondary` (dark in light mode, light in dark mode; tokens `--secondary-btn-*` in `index.css`), `neutral` (grey), `danger`/`cancel`. Use secondary for a calm but definite action beside or instead of the main one (e.g. print, go to the dashboard).
- Sites: `sites.currency` (migration `20251204100000_site_currency.sql`; a new site starts with `organisation_settings.base_currency` via trigger `app.site_default_currency`; changing the organisation currency leaves existing sites alone) is the **default currency for money entered at that site** — a new NC cost line starts in the NC's site currency (`CostForm defaultCurrency`); totals stay in the organisation's base currency. Settings → Organisation → Sites and departments (`SitesManager.jsx`): **Add / Edit site open a pop-up** (`SiteDialog`: code (fixed once created), name, time zone (`TimeZoneCombo`, `lib/timeZones.js`), currency and the site's departments — saved as added for an existing site, created with the site for a new one).
- Form pickers: dropdowns use `src/components/ui/RHFComboBox.jsx` and dates use
  `RHFDatePickerPopout.jsx` (value/onChange, so wrap in react-hook-form `Controller`; both take
  `label`, `required`, `disabled`, `hint`, `error`). Options are `{ id, name, hint?, disabled? }`;
  `sort={false}` keeps your order; server search via `filterLocally={false}` + `onSearchChange`
  (see `RemoteComboBox`, `PartPicker`, `PartyPicker` in `src/components/ncr/Pickers.jsx`). Dates:
  `valueFormat="iso"` for date-only API fields, `minDate`/`maxDate`, `clearable`.
  The calendar opens in a portal (`data-popover`), so panes that close on outside clicks must ignore
  `[data-popover]`. Ranges: `src/components/ui/RangeSlider.jsx` (two handles, `value=[lo, hi]`, `format`).
- Calibration (Phase 4, brought forward; `docs/calibration-plan.md`):
  - **Tables:** `gauge_types` + `gauge_type_characteristics` (templates), `gauges`, `gauge_characteristics` (copied from the type on insert), `calibrations` (`CAL-YY-NNN`), `calibration_readings` (limits copied; `as_found_ok`/`as_left_ok` worked out; characteristics are `kind` `variable` (nominal ± tolerance) or `attribute` (pass/fail: `as_found_pass`/`as_left_pass`)) and `calibration_attachments` (private `calibration-files` bucket at `<org>/calibration/<calibration id>/...`).
  - **Database rules:** outcome pass/adjusted/fail is worked out from the readings. The gauge's last/next dates and quarantine/reinstatement follow its latest calibration, via a *deferred* constraint trigger — flush with `set constraints calibrations_after immediate` before reading back. Errors use `QM006` (`409 calibration_rule`).
  - **Permissions:** `calibration.read` / `.manage` / `.record`, site-scoped through the gauge.
  - **API** in `api/src/calibration/`; Raise NC is `POST /calibrations/{id}/raise-ncr` (draft internal NC, linked).
  - **Frontend:** `src/components/calibration/`, hooks `src/hooks/useCalibration.js`, helpers `src/lib/calibration.js`. Routes `/Calibration` (dashboard), `/Calibration/Gauges` (register, URL filters via `useUrlFilters`/`useGaugeFilters`), `/Calibration/Gauges/:id`, `/Calibration/Gauges/:gaugeId/calibrations/:calibrationId` (`new` creates), and Settings → Calibration (types).
  - `AttachmentDrop` in `ui/FileDrop.jsx` is the generic drag-and-drop uploader (bucket/folder/endpoints); `TableWrapper` takes `ariaLabel`/`rowLabel`.
- Process control (`docs/process-control-plan.md`, replaces Phase 2 slices 2.2/2.3; agreed decisions P1–P4):
  - **PC1 done:** `machines`, `part_families` (+ `parts.part_family_id`), `part_revision_characteristics`
    (part-specific values by `characteristic_key`, draft-only edits, copied into a new draft),
    `control_plans`, `control_plan_applicability`, `control_plan_revisions` (draft → pending_approval →
    approved → effective → superseded | obsolete; `QM007` → `409 control_plan_rule`). Permissions
    `process_control.read` / `.manage` / `.approve`. API in `api/src/process-control/`; hooks
    `src/hooks/useProcessControl.js`; pages `src/components/process-control/` (`/Process-Control/Plans`,
    `/Process-Control/Plans/:id`) and `master-data/` (`/Machines`, `/Part-Families`, `/Part-Families/:id`,
    spec values on the part page).
  - **PC2 done:** revision content — `control_plan_operations`, `control_plan_characteristics` (stable
    `characteristic_key`; `data_type` variable/attribute, `value_source` plan/part_spec + `spec_key`, `applies_to`
    all/selected; SPC `imr`/`xbar_r`), `characteristic_applicability`, `sampling_rules`, `reaction_plans`; all carry
    `control_plan_revision_id`, are draft-only and copied into a new revision. Comparison in
    `api/src/process-control/revision-compare.ts`; page `RevisionPage.jsx` (`/Process-Control/Plans/:planId/revisions/:revisionId`).
  - **PC3 done:** `app.resolve_inspection_requirements(part, op?, site?, part revision?)` → jsonb (status ok/blocked
    with problems; one effective plan revision or refuse; part-specific values by `spec_key`, unit must match;
    conditional ones returned as not applicable). API `GET /control-plan-resolution`; `ResolutionView` /
    `RequirementPreview` on the plan and part pages. PC4 must call the resolver inside the create transaction.
  - **PC3b done:** `part_customers` (several customers per part, customer part number, one primary;
    `parts.customer_id` dropped — `customer` in the API is the primary); plan scope may name a single part
    without a family; a plan for the part overrides family plans (resolver `scopeLevel`, `overriddenPlans`);
    bulk family membership `POST /part-families/{id}/parts`.
  - **PC4 done:** `inspection_records` (`IPI-YY-NNNN`, created only by `app.start_inspection()`, which runs the
    resolver in the same transaction; `QM008` → `409 inspection_rule`), `resolved_inspection_requirements` (frozen),
    `inspection_samples`, `inspection_measurements` (insert-only; NUMERIC as entered, pass/fail by the DB, gauge state
    copied, override needs `inspection.override_gauge`, corrections `supersedes_id` + reason with `inspection.correct`,
    retests `retest_of_id`). Permissions `inspection.read/.record/.correct/.override_gauge` (site-scoped). API
    `api/src/inspection/`; pages `src/components/inspection/` (`/Inspections`, `/Inspections/new`, `/Inspections/:id`).
  - **PC5 done:** `inspection_ncr_links` (frozen; NC ↔ failed reading, or whole inspection) and
    `inspection_failure_acknowledgements` (note required). Completing an inspection needs every current failed
    reading acknowledged or linked to an NC (`app.inspection_record_rules`, `QM008`). `app.raise_ncr_from_inspection()`
    (needs `inspection.read` + `ncr.create`; NC source stays `internal`; prompts only, never silent; one NC per event)
    and `app.gauge_usage()` (impact report only). API in `api/src/inspection/`: `GET /inspections/{id}/ncr-draft`
    (`ncr-draft.ts` builds the pre-fill and containment window), `POST /inspections/{id}/raise-ncr`,
    `POST /inspection-measurements/{id}/acknowledge`, `GET /ncrs/{id}/inspection-source`, `GET /calibrations/{id}/gauge-usage`.
    UI: `Failures.jsx` card on the inspection page, `NcrInspectionSource.jsx` on the NC page, `GaugeUsage.jsx` on an
    out-of-tolerance calibration. Later failures can be **added to an NC already raised from the same inspection**, on request only
    (`app.add_readings_to_ncr`, migration `20251112100000`; `POST /inspections/{id}/add-to-ncr`; needs `ncr.update`; refused for closed,
    cancelled or deleted NCs and for NCs not raised from that inspection; the dialog proposes the quantity affected).
    **A reading is on at most one live NC** (live = not cancelled, not deleted; `app.reading_live_ncr`, `app.assert_readings_free`, migration
    `20251113100000`): raising or adding refuses a reading already on one (`QM008`), a cancelled/deleted NC frees its readings (unhandled again
    for completion and the dashboard), and the UI offers no checkbox for covered readings. The NC history shows readings linked
    (`action: readings_linked`, from `app.ncr_link_history`): "raised this from inspection…" / "added readings from inspection…".
  - **Inspection register** (`/Inspections`, `InspectionsPage.jsx`): same pattern as the NC and gauge registers — `TableWrapper` with server sort/paging, column config (`inspectionColumns.jsx`, `useTablePreferences("inspection-register")`), header search box, filter drawer (`InspectionFilterPane.jsx`: status, result, trigger, started from/to, part, site, machine; URL keys in `useInspectionFilters`) with active-filter chips. `GET /inspections` is page-based now (`page`, `pageSize`, `sort`, `order`, comma-separated `status|result|trigger`, `partId|siteId|machineId`, `from|to`; answers `{ data, page, pageSize, total }`, no cursor). Status pills: completed = success green, in progress = warning colour.
  - **PC6 done:** SPC control charts (I-MR, X-bar/R), `docs/process-control-plan.md` §15. `inspection_samples.subgroup_number`
    (assigned by `app.inspection_sample_rules`; API `newSubgroup`), `spc_baselines` (saved limits with the measurement ids used;
    frozen; a new baseline supersedes the old via trigger; `spc.manage` inserts, `spc.read` reads). Statistics are pure functions in
    `api/src/spc/spc.ts` (limits, Western Electric rules 1–4), data assembly in `spc-data.ts` (only compatible data; exclusions
    counted by reason); API `GET /spc/characteristics|chart|baselines`, `POST /spc/baselines` (`409 spc_rule`). Charts read
    `inspection_measurements` live. UI `src/components/spc/` (`/Process-Control/SPC`, URL filters), hooks `useSpc.js`, `lib/spc.js`;
    colours from the `--chart-*` variables, spec limits solid vs control limits dashed. A signal never raises an NC.
  - **Process control dashboard** (`/Process-Control`, `ProcessControlDashboard.jsx`; API `GET /process-control-dashboard?from&to`
    in `api/src/process-control/process-control-dashboard.ts`): plan pipeline and SPC as of today, inspections for a period (URL `?period=`).
    KPIs awaiting approval, effective plans, inspections, first-pass rate, open failures (no acknowledgement/NC), SPC signals (30 days);
    charts inspections by result, revisions by status, failures by characteristic, signals by rule; lists of latest signals, plans needing
    attention, failures needing action, inspections in progress. `SpcService.overview()` evaluates up to 40 recently measured characteristics
    like their charts (needs `spc.read`, else `spc.available` is false). Shared dashboard pieces in `src/components/dashboard/DashboardParts.jsx`.
  - **PC7 done (P chart):** pass/fail (attribute) plan characteristics can be marked for SPC with chart type `p` (migration
    `20251114100000_p_charts.sql`: plan characteristics, templates and `spc_baselines` accept `p`; baselines keep `subgroup_basis` and
    `mean_subgroup_size`, no dispersion limits). The subgroup is chosen on the chart: one inspection (default), one UTC day or one lot
    (`subgroup=inspection|day|lot` on `GET /spc/chart` and `POST /spc/baselines`; URL `?basis=`). p̄ = Σd/Σn, limits `p̄ ± 3√(p̄(1−p̄)/nᵢ)` per
    subgroup (clipped 0…1); Western Electric rules apply in each point's own σ (`pSeries`/`detectPSignals`, `zoneRules` shared in
    `api/src/spc/spc.ts`; grouping in `spc-data.ts` `assembleP`/`evaluateP`); warns when n̄·p̄ < 5 and for < 5 / < 20 subgroups. UI
    `ProportionChart` in `src/components/spc/ControlChart.jsx`. The dashboard SPC overview includes P charts. Demo data
    `supabase/seed/spc_demo_p_chart.sql`.
  - **PC8 done (NP, C and U charts):** new check type **defect count** (`data_type='count'`: no unit/nominal/lower limit; optional `upper_limit` =
    most defects per unit, empty = never fails; integer `inspection_measurements.value_count`, one unit per sample; migration
    `20251115100000_count_checks.sql`, plan chart type `defects`, baselines `chart_type='defects'` keep `subgroup_basis`/`mean_subgroup_size`).
    One "defects per unit" SPC choice: the chart is a **C chart** when every subgroup holds the same number of units, else a **U chart**
    (ū ± 3√(ū/nᵢ); C: c̄ ± 3√c̄), subgroups one inspection/day/lot (`?basis=`). The **NP chart** is a view of the P chart's pass/fail data
    (`GET /spc/chart?display=np&size=auto|N`, URL `?display=np&size=`): subgroup size set or calculated (most common, larger on tie), other
    sizes excluded (reason `size`); NP and P share one baseline (`POST /spc/baselines` takes optional `size`). Chart responses carry `variant`
    (imr/xbar_r/p/np/c/u). Maths in `api/src/spc/spc.ts` (`countSeries`, `defectsKind`, `countReliability`; `detectPSignals` takes any `{z}`),
    assembly in `spc-data.ts` (`assembleDefects`, `applySubgroupSize`, `evaluateCount`), service `countChart`/`createCountBaseline`.
    Demo data `supabase/seed/spc_demo_count_chart.sql`. Plan §17.
  - **PC9 done (process capability):** no migration. `GET /spc/chart` for I-MR and X-bar/R charts returns `capability` (`api/src/spc/capability.ts`):
    Cp/Cpu/Cpl/Cpk from the chart's within σ (saved baseline, else trial limits), Pp/Ppu/Ppl/Ppk from the overall sample SD of the readings shown,
    both against the spec on the data; one-sided specs give only the one-sided index; observed and normal-expected ppm; verdict bands on Cpk
    (1.00/1.33/1.67). `null` without a limit, with < 10 readings or for pass/fail and count charts; warns below 30 readings and when the chart has
    signals (not stable). `capability.histogram` = bins over a range that includes the spec plus the normal curve (overall σ) in the same counts. UI `CapabilityCard.jsx` (table + `CapabilityHistogram`) on the SPC page. Not done: non-normal data, Cpm.
  - **PC10 done (family and machine analysis):** no migration. `GET /spc/analysis?groupBy=machine|part&partId|partFamilyId&characteristicKey[&operationCode&from&to]`
    compares one characteristic between machines (one part, or all parts of a family) or between the parts of a family (`api/src/spc/analysis.ts`,
    `SpcService.analysis`). Measured: n, mean/sd/min/max, out-of-spec count, position in the tolerance (%), spread (6σ as % of tolerance), Pp/Ppk (overall σ only;
    readings are rescaled to the tolerance, u = (x−mid)/half-tolerance, so parts with different specs compare; no Cp/Cpk across groups). Pass/fail: failure rate;
    count: defects per unit. Each group is flagged higher/lower/similar vs all the others together (|z| > 3: two-proportion, Poisson, or Welch on tolerance-scaled means).
    `GET /spc/characteristics` also takes `partFamilyId` and `all=true` (not only SPC characteristics). UI `AnalysisPage.jsx` at `/Process-Control/Analysis`
    (URL `scope|part|family|by|c|from|to`). Demo data: `spc_demo_count_chart.sql` now has two machines and two parts. Plan §19. Not done: ANOVA/variance tests, trend by machine.
  - **PC11 done (SPC alerts):** migration `20251116100000_spc_alerts.sql`. `spc_alerts` (audited, RLS `spc.read`, **no table INSERT/UPDATE grants**): written only by
    `app.raise_spc_alerts(org, part, jsonb)` (caller needs `inspection.record`; duplicates ignored: unique per point for I-MR/X-bar-R, per inspection and rule for
    P/C/U whose point grows) and `app.acknowledge_spc_alert(id, note)` (`spc.manage`, note required, once; acknowledged alerts are frozen, never deleted; errors `QM008`).
    **No worker:** `InspectionService.addSample` calls `SpcService.raiseAlerts` (behind a savepoint, so it can never lose the readings) which evaluates the charts of the
    characteristics just measured (`groupSignals`, shared with the dashboard overview; saved baseline, else trial limits) and alerts on signals at points from the new
    reading on, incl. moving-range/range (`rule: range`); retests and corrections do not alert. Notification event `spc_alerts.created` (on by default for `spc.manage`;
    `.updated` = acknowledged, off); as for all notifications the person who recorded the reading is not told of their own action. API `GET /spc/alerts?status&partId&limit`
    (`{ data, openCount }`), `POST /spc/alerts/{id}/acknowledge`; UI `AlertsPage.jsx` at `/Process-Control/Alerts` ("SPC Alerts" menu), notifications link there. An alert
    never raises an NC. Plan §20. Not done: email/push, alert rules per characteristic, dashboard KPI, alerts when limits/baselines change.
  - **Next (later phases):** email delivery of notifications, scheduled (worker) evaluation.
- Documentation module (`docs/documentation-plan.md`; first feature quality alerts, built in slices DOC0–DOC4):
  - **DOC0 done (department membership):** migration `20251117100000_department_members.sql`. `department_members` (a person can be in several departments, one primary;
    leaving sets `ended_at`, never deleted; audited; SELECT for `members.read` or the person themselves; INSERT/UPDATE (`is_primary`, `ended_at` only) need `members.manage` and
    `app.can_manage_membership`). A role assignment scoped to a department needs an active membership of it, and a membership cannot end while such a role exists
    (`QM011` → `409 department_rule`). Existing department-scoped assignments were backfilled as memberships. `app.list_members` now returns `departments`. `app.has_permission`
    is unchanged: membership grants no access, and department-scoped roles still only take effect where a check passes a department (none do yet). API (`api/src/members/`):
    invite takes `departmentIds` (+ `primaryDepartmentId`, `departmentId` for the role scope) and **requires a department unless every role is owner/admin/quality_manager**
    (`ORGANISATION_WIDE_ROLE_KEYS` in `members.schemas.ts` and `src/lib/departments.js`; `400 department_required`); `POST /members/{id}/departments`,
    `PATCH|DELETE /department-memberships/{id}`. UI: Settings → Users & permissions (invite form department checkboxes + primary, per-person departments, "no department" notice).
  - **DOC1 done (quality alerts core):** migration `20251118100000_quality_alerts.sql`. `quality_alerts` = one row per **revision** (`QA-001`, `revision` 1 = A, 2 = B …; numbers per
    organisation from `app.quality_alert_counters`, assigned by trigger whatever the caller sends). Statuses draft → active → expired | withdrawn | superseded. Drafts are inserted/edited
    by `documentation.manage` under RLS (column-level UPDATE on content only; drafts visible only to managers, issued alerts to `documentation.read`); **every lifecycle step is a
    SECURITY DEFINER function**: `app.set_quality_alert_scope` (replaces parts/families, machines, operations, affected departments and **targets** = who must acknowledge: department,
    role or person; child tables are SELECT-only), `app.issue_quality_alert` (needs `documentation.issue`; description, required action, effective date, ≥1 target; high/critical need
    acknowledge-by; supersedes the revision it replaces), `app.revise_quality_alert` (draft copy + reason, one open draft per number), `app.withdraw_quality_alert` (reason),
    `app.discard_quality_alert_draft`, `app.expire_quality_alerts` (no worker: the API runs it on list/get). Issued content is frozen (trigger, `QM012` → `409 documentation_rule`).
    Permissions `documentation.read/.manage/.issue` (issue: owner, admin, quality manager; manage adds quality engineer). API `api/src/documentation/` (`/quality-alerts`: list,
    create, get, PATCH draft incl. scope, DELETE draft, `POST :id/issue|withdraw|revisions`); UI `src/components/documentation/` (register `/Documentation/Quality-Alerts`, alert page,
    `QualityAlertForm` at `/new` and `/:id/edit`), hooks `useDocumentation.js`, `lib/qualityAlerts.js`, menu group "Documentation". Recipients, viewed/acknowledged tracking, My alerts,
    overdue list and notifications are **DOC2** (below); showing alerts where work happens, attachments and links to NC/supplier/gauge are **DOC3**.
  - **DOC2 done (recipients and acknowledgement):** migration `20251119100000_quality_alert_recipients.sql`. `quality_alert_recipients` = who was asked, **fixed when the alert is issued**
    (`app.issue_quality_alert` resolves the targets with `app.resolve_quality_alert_targets`: department → active department members, role → everyone holding it, named people;
    de-duplicated, `reached_via` lists how; refuses an alert that reaches nobody; a revision resolves afresh and everyone must acknowledge again). Written only by functions:
    `app.mark_quality_alert_viewed` (first view, by the recipient), `app.acknowledge_quality_alert(alert, note)` (the recipient themselves, while the alert is `active`, once, frozen),
    `app.add_quality_alert_recipient` (`documentation.issue`, active alert, active member), `app.preview_quality_alert_recipients` (manager; counts per target); withdrawing sets
    `withdrawn_notified_at` on every recipient. Managers (`documentation.manage`) read all recipients, others only their own row. **Notifications:** `notifications.recipient_user_id`
    (a notice with one is visible to that person only; `emit_notification`/`visible_notifications`/policy updated); event types `quality_alert_recipients.created` ("addressed to you") and
    `.updated` (only the withdrawal notice; views and acknowledgements notify nobody). API additions: `GET /quality-alerts/mine`, `/mine/count` (declared before `:id`),
    `GET :id/recipients`, `GET :id/recipients-preview`, `POST :id/recipients`, `POST :id/acknowledge`; list takes `overdue=true` and gives managers `progress`; detail has `me` and opening it
    records the first view. UI: `MyAlertsPage` (`/Documentation/My-Alerts`), acknowledgement banner and `AcknowledgeDialog`, `Tracking` (totals, filters, add a person) and
    `RecipientsPreview` on the alert page, progress column and overdue filter on the register, menu badge (`useMyAlertCount`, polled every 5 minutes; `badge` in `MenuStructure.js`). Overdue = past
    `acknowledge_by` and not acknowledged (computed, no worker; no automatic reminders). Plan §7.
  - **DOC3 done (where work happens, attachments, links):** migration `20251120100000_quality_alert_attachments_links.sql`. `quality_alert_attachments` (files on a **draft** only, written by
    `app.add_quality_alert_attachment` / `remove_quality_alert_attachment(id, reason)` / `restore_quality_alert_attachment`; marked deleted with a reason, never deleted; stored in the private
    `quality-alert-files` bucket at `<org>/quality-alerts/<alert id>/<uuid>-<name>`, readable by anyone who can see the alert, uploads only into a draft folder via `app.quality_alert_file_allowed`;
    a revision copies the live rows and keeps pointing at the same stored files) and `quality_alert_links` (one of nonconformance / supplier / gauge / calibration per row, replaced as a whole by
    `app.set_quality_alert_links`, copied by a revision; parts, families and machines are the scope, so there is no part link). API: `GET /quality-alerts/active?partId|partFamilyId|machineId|operationCode`
    (declared before `:id`; alerts in force matching any of them, most severe first, each with `matched` and the caller's `acknowledged`; a part also matches its family), `GET|POST :id/attachments`,
    `POST /quality-alert-attachments/{id}/delete|restore`; the scope body takes `links` and the detail returns `links` (label is `null` when the caller cannot read the record). UI: `ActiveAlertsBanner`
    (information only, never blocks) on Start inspection, the part, part family and machine (edit dialog) pages; `AlertLinks.jsx` (pickers, read-only list), `AlertFiles.jsx` (`AttachmentDrop`) in the draft
    editor and, read-only, on the alert page. **DOC4 done (exit check):** `docs/documentation-exit-report.md` (evidence, advisor findings, limitations; no browser check yet). Migration `20251121100000_rls_initplan_wrap.sql` wraps `auth.uid()` as `(select auth.uid())` in five SELECT policies (advisor `auth_rls_initplan`).
- CAPA / 8D (`docs/capa-8d-plan.md`; one `capas` record, method 8D, built in slices CAPA1–CAPA5; decisions C1–C10):
  - **CAPA1 done (core, NC integration, D0, D1):** migration `20251122100000_capa_core.sql`. `capas` (`CAPA-000001`, stage `open → actions_in_progress → awaiting_verification → verified_effective → closed | cancelled`,
    worked out from the steps by `app.capa_recompute_stage`, never set by hand), `capa_steps` (nine rows D0–D8, written only by `app.capa_complete_step` / `capa_reopen_step`; **any order; completing a step makes its content read-only until that step is reopened (CAPA6)**, reopening touches only that step; `app.capa_step_problems` returns
    the "still needed" list the UI shows), `capa_team_members` (organisation member **or** external contact; one leader, one champion; ended, never deleted), `capa_ncr_links` (many-to-many, ended with a reason).
    Started only by `app.start_capa` (numbering, nine steps, creator leads and owns it, optional first NC link, `capa.created` outbox event; prefilled from an NC). Header edited under RLS (`capa.manage`) until closed or
    cancelled; `app.cancel_capa` / `reopen_capa`. **A non-conformance cannot be closed while a linked 8D is running** (own trigger on `nonconformances`, `QM005` → `409 ncr_rule`). Permissions `capa.read/.manage/.verify`
    (owner, admin, quality manager all; quality engineer read+manage; others read). Errors `QM013` → `409 capa_rule`. API `api/src/capa/`: `GET|POST /capas`, `GET|PATCH /capas/{id}`, `GET /capas/people`,
    `POST /capas/{id}/complete-step|reopen-step|cancel|reopen|team|ncrs`, `PATCH /capa-team/{id}`, `POST /capa-ncr-links/{id}/unlink`, `GET /ncrs/{id}/capas`; commands answer with the whole 8D. UI
    `src/components/capa/`: register `/CAPA`, step page `/CAPA/:id/:step` (`CapaPage`, `Stepper`, `StepFooter` with the checklist, `steps/D0Initiate`, `steps/D1Team`; D2–D8 say "not available yet"),
    `NcrCapaCard` in the NC page's Investigation card (**Start a new 8D** prefilled from the NC, **Link to an existing 8D**, unlink with a reason); hooks `useCapa.js`, helpers `lib/capa.js`. Next: CAPA2 (D2, D3).
  - **CAPA2 done (D2 problem, D3 containment):** migration `20251123100000_capa_d2_d3.sql`. 5W2H columns on `capas` (`d2_who … d2_how_many`, plus `d3_no_containment_reason`), edited with the header; `app.start_capa` fills
    D2 (what, where, when, how many) from the NC. `capa_analyses` (kind `is_is_not` now, `ishikawa` and `five_whys` allowed by the table for CAPA3; `data` jsonb object ≤ 200 kB, validated per kind by the API
    (`ANALYSIS_DATA` in `capa.schemas.ts`); removal sets `deleted_at`, never deleted) and `capa_actions` (phase `interim` now, `corrective`/`preventive` allowed; written under RLS, `app.capa_action_rules` keeps the owner on
    the team, stamps `done_at/by`, needs a reason to cancel, reopening clears the stamps; **a team member who owns open actions cannot leave**). `app.capa_step_problems` now covers D2 (what, where, when) and D3 (no open
    actions, and one done or a reason there is none). A completed step is read-only until reopened (CAPA6). API: `POST /capas/{id}/analyses|actions`, `PATCH|DELETE /capa-analyses/{id}`, `PATCH /capa-actions/{id}`,
    `POST /capa-actions/{id}/complete|cancel|reopen`; the detail carries `problem`, `d3NoContainmentReason`, `analyses`, `actions`. UI `steps/D2Problem.jsx` (5W2H modal, Is / Is-Not modal with the eight standard questions),
    `steps/D3Containment.jsx`, and the reusable `ActionList.jsx` (add, edit, done with evidence, cancel with reason, reopen) for D5 and D7. Next: CAPA3 (D4).
  - **CAPA3 done (D4 root cause):** migration `20251124100000_capa_d4.sql`. `capa_root_causes` (kind occurrence / escape / systemic; written under RLS; `app.capa_root_cause_rules`: a running 8D, the source analysis must belong to the same 8D,
    **verification is stamped by the database and needs a method; changing the words or kind of a verified cause withdraws it**, removal sets `deleted_at`, never deleted). `app.capa_step_problems` D4: at least one occurrence cause and
    every live cause verified (an escape cause is advised, not required). `capa_analyses` now carries the `ishikawa` and `five_whys` kinds (data shapes `IshikawaData` / `FiveWhysData` in `capa.schemas.ts`, step d4). API:
    `POST /capas/{id}/root-causes`, `PATCH|DELETE /capa-root-causes/{id}`; detail has `rootCauses`. UI `steps/D4RootCause.jsx` (causes with verify / withdraw / edit / remove, analysis tools list), modals `IshikawaDialog.jsx`
    (six categories, probable star, live `IshikawaDiagram.jsx` SVG fishbone, "Record as root cause" once the diagram is saved) and `FiveWhysDialog.jsx` (a chain of whys each asked about the one before, "Save and record as root cause").
    A completed D4 is read-only until reopened (CAPA6).
  - **CAPA4 done (D5 corrective, D6 implement and verify, D7 prevent):** migration `20251125100000_capa_d5_d7.sql`. `capa_actions` phases are now interim/corrective/preventive with an optional `root_cause_id` (same 8D, editable);
    `d7_lessons_learned` and `d7_no_preventive_reason` on `capas`. `capa_verifications` (append-only, ordered by `seq`, written only by `app.record_capa_verification`, needs `capa.verify`; refuses open corrective actions, none done, no method, or a failed
    result without notes; a failed one reopens D5 and D6 with the reason) stores `actions_fingerprint` (`app.capa_actions_fingerprint`: corrective, non-cancelled actions' id:status:done_at), so changing the actions afterwards makes the latest verification **stale**
    (`app.capa_verification_state` none/effective/failed/stale; `app.capa_verification_status` for readers). **Stage is worked out** (`app.capa_recompute_stage`, trigger on actions): D4 not complete → open; effective verification and nothing open → verified_effective;
    failed → actions_in_progress; nothing open and ≥1 corrective done → awaiting_verification; else actions_in_progress. `app.capa_step_problems` now covers D0–D7. API: `POST /capas/{id}/verifications` (`capa.verify`), detail has `verifications`, `verificationState`,
    `d7LessonsLearned`, `d7NoPreventiveReason`, actions carry `rootCauseId`. UI `steps/D5Corrective.jsx` (causes with action counts + `ActionList withCause`), `D6Implement.jsx` (actions, verification card and dialog), `D7Prevent.jsx`, shared `ReasonCard.jsx`
    (also used by D3).
  - **CAPA5 done (D8 close, files, report, exit check):** migration `20251126100000_capa_d8_close_files.sql`. `app.close_capa(id, recognition)` (needs `capa.verify`; D0–D7 complete and stage verified_effective; completes D8, stage → closed,
    `closed_at/by`, `capas.d8_recognition`, event `capa.closed`); `app.capa_complete_step` refuses D8 (only closing completes it); `app.reopen_capa` also marks D8 not done again; `app.capa_step_problems` covers D8 ("Complete Dn first", "must be verified
    effective"). `capa_attachments` (functions only: `app.add_capa_attachment` / `remove_capa_attachment(id, reason)` / `restore_capa_attachment`, running 8Ds only; never deleted; private `capa-files` bucket at `<org>/capa/<capa id>/<uuid>-<name>`,
    uploads via `app.capa_file_allowed` only into a running 8D with `capa.manage`, reads with `capa.read` even when closed). API: `POST /capas/{id}/close`, `GET|POST /capas/{id}/attachments`, `POST /capa-attachments/{id}/delete|restore`; detail has
    `d8Recognition`, `closedBy`. UI `steps/D8Close.jsx` (close dialog, closure summary), `CapaFiles.jsx` (`AttachmentDrop`), `CapaReportPage.jsx` at `/CAPA/:id/report` (whole 8D as one document; "Print or save as PDF" prints only the report), "Report" link
    in the 8D header. Exit report `docs/capa-exit-report.md`. The CAPA module is complete; not done: email/push for owners and due dates, customer-format PDF, CAPA dashboard, 8Ds that are not method 8D.
  - **CAPA6 done (step locks, actionee workflow):** migration `20251127100000_capa_step_locks_actionee.sql`; amends decision C5 (an 8D is no longer "nothing locks"). **A completed step is read-only until it is reopened** (reopen needs a reason and touches only that step),
    enforced by triggers: D0 initiation details and linked NCs, D1 team, D2 5W2H and Is / Is-Not, D3 containment actions and the no-containment reason, D4 root causes and analyses, D5 the corrective plan (what, root cause), D6 doing corrective actions (findings, close, cancel) and effective
    verifications (a *failed* one is always accepted and reopens D5/D6), D7 preventive actions, no-preventive reason and lessons learned. Who and when (`owner_team_member_id`, `due_date`) may still move while the plan OR the doing step of an action is open. Helpers `app.capa_step_complete`,
    `app.assert_capa_step_open`; the UI gets `editable = manage && running && !stepComplete` per step (`CapaPage`), a "D4 is complete, so it is read-only" notice, and `ActionList` takes `planStep`/`doingStep` (interim D3/D3, corrective D5/D6, preventive D7/D7).
    **Actions are actionable:** managers (`capa.manage`) write an action and assign it to a team member (the actionee, "Assigned to"); the actionee, with `capa.read` only (`app.is_capa_action_assignee`, RLS policy `capa_actions_update_assignee`), updates the **findings**
    (`evidence_note`) and **closes or reopens** their own action, but cannot change what it is, who has it, when it is due or cancel it (trigger `app.capa_action_step_lock`); closing needs the findings written. The actionee gets an in-app notice when an action is assigned or handed to them
    (`capa_actions.created|updated`, `recipient_user_id`, `emit_notification` extended; the assigner is not told). API: `PATCH /capa-actions/{id}`, `POST …/complete|reopen` now need only `capa.read` (the database decides), `GET /capa-actions/mine?status=open|done|all` (`{ data, openCount }`),
    actions carry `isAssignee`. UI: `ActionList` (Update findings, Close action, Reopen, Reassign, Cancel by rights), `FindingsDialog`, wider action dialog (`max-w-2xl`, tall enough for the drop-downs), `MyActionsPage` at `/CAPA/My-Actions` ("My actions" under Corrective Actions, menu badge `my-actions` = open count).
- Onboarding (`docs/onboarding-plan.md`; self-serve sign-up, a valid **Controller subscription (Stripe) required to use the app**, wizard, seats, team; slices ON1–ON6, all done):
  - **ON1 done (sign-up and account states):** migration `20251128100000_onboarding_accounts.sql`. Sign-up (`SignUp.jsx`: name, work email, password with live rules, terms; no enumeration, inline errors) carries `first_name`, `surname`, `terms_version` as metadata,
    which `app.handle_new_user` stores on the profile (`terms_accepted_at`, `terms_version`; not user-editable; `src/lib/terms.js`, `VITE_TERMS_URL`/`VITE_PRIVACY_URL`). `auth/VerifyEmail.jsx` ("check your email", resend with cooldown, rate-limit messages) after sign-up and from `Login.jsx` for an
    unverified account. `NoOrganisation.jsx` is the **Start your organisation** page (progress rail, pending invitations, organisation form; the organisation is still created unlocked until ON2/ON3). `signup_events` (platform-owned: signed_up / verified / org_started, `kind` self|invited, written only by
    triggers on `auth.users` and `organisations`, backfilled) and `platform_admins` (operator allow-list, seeded by SQL) are reviewed global tables in the guardrails. `app.is_platform_admin()` = on the list **and** an `aal2` session; `app.platform_account_status()` (none / needs_mfa / ok);
    `app.platform_funnel(days)` and `app.platform_recent_signups(limit)` are admin-only. API `api/src/platform/` (unscoped, on the sweep allowlist): `GET /platform/me`, `GET /platform/overview?days=` (404 for non-operators, `403 mfa_required` without MFA). UI `/platform` (`PlatformPage.jsx`, outside `<App />`,
    monitor only: funnel with step-to-step conversion, totals, latest sign-ups, period selector). `supabase/tests/supabase_stubs.sql` gives the `auth.users` stub `created_at`, `email_confirmed_at`, `invited_at`. Add yourself as an operator with `insert into platform_admins (user_id) values ('<auth user id>')`.
  - **ON2 done (organisation in a gated state, wizard shell):** migration `20251129100000_onboarding_organisation.sql`. `organisations.billing_required`, `legal_name`, `country`, `onboarding_completed_at`; `platform_settings.billing_gate_enabled`
    (default **false**, SQL-only; existing organisations are grandfathered) makes `app.start_organisation(name, site, code, time zone, country, key)` (idempotent; wraps `create_organisation`) mark a new organisation `billing_required` and turn on `entitlements_enforced`.
    `app.has_permission`/`has_permission_somewhere`/`my_permissions` grant a `billing_required` organisation without a valid subscription only `app.gated_permissions()` (billing + `organisation.manage`); `app.organisation_subscription_valid`
    (trialing/active, past_due in grace, cancelled until period end, **and** an active Controller seat on an active Owner), `app.organisation_access_state(org)` → open | needs_subscription | lapsed. `organisation_onboarding` (steps jsonb; organisation, plan,
    sites, review worked out; details/security/team markable) via `app.set_onboarding_step`, `complete_onboarding`, `onboarding_state`. QM014 → `409 onboarding_rule`. API `api/src/onboarding/` (`GET /onboarding`, `PUT /onboarding/step`, `POST /onboarding/complete`, `organisation.manage`);
    `/me` memberships carry `accessState` and `onboarding`. UI `src/components/onboarding/` (`SetupWizard` at `/setup[/:step]` outside `<App />`, `SubscriptionNeeded`, `steps.jsx`), `useOnboarding.js`, `lib/onboarding.js` ("Finish later" is remembered per session); `App.jsx` sends an owner with an unfinished set-up to the wizard and shows
    `SubscriptionNeeded` instead of the app while locked (Settings stays open). **Keep the gate off until ON3 (Stripe):** `PUT /subscription/seats` (manual provider) still lets an owner grant themselves seats.
  - **ON3 done (Stripe; `docs/onboarding-plan.md` §13, setup guide `docs/stripe-setup.md`):** migration `20251130100000_stripe_billing.sql`. **Stripe is the source of truth for money and quantities; the database for who holds a seat.** Tables `stripe_events` (one row per event id: received/processed/failed/ignored, attempts, error; platform-owned, operator-readable),
    `billing_customers`, `stripe_checkout_sessions` (tenant tables, read with `subscription.read`, written only by functions); `subscription_prices.provider_price_id`, `organisation_subscriptions.provider_synced_at`. **System functions `app.stripe_*` are executable only by the `qms_api` login** (`GRANT USAGE ON SCHEMA app` + EXECUTE by name; not `authenticated`/`anon`): `stripe_apply_subscription(org, snapshot, fetched_at, checkout session)`
    (advisory lock per organisation, idempotent, **a snapshot older than `provider_synced_at` is ignored**, status mapping, `past_due_since` kept, seats exactly as Stripe says with packages missing from the snapshot set to 0 and over-assignment logged not unassigned, first Controller seat to the owner who started the latest checkout else the longest-standing owner), `stripe_apply_invoice`, `stripe_record_event`/`finish_event`, `stripe_start_checkout`
    (owner only; refused with a live subscription), `stripe_organisation_for`, `stripe_customer_for`/`set_customer`, `stripe_price_for`. `app.check_seat_change(org, seats)` (authenticated, `subscription.manage`) lists problems (below seats in use, no Controller). **Controller invariant** (deferred constraint triggers, `QM009`): while a `billing_required` organisation's subscription status is ok an active Owner keeps a Controller seat.
    `app.set_subscription_seats` is refused for Stripe-billed and `billing_required` organisations (closes the ON2 self-grant gap; the gate can now be switched on once Stripe works end to end). API `api/src/billing/`: `StripeGateway` (abstract; `StripeSdkGateway` real, tests substitute a fake and keep **real signature verification**), `stripe-billing.service.ts`:
    `POST /billing/checkout-session` (14-day trial, card required, Stripe Tax; `returnTo` setup|settings), `POST /billing/checkout-session/confirm` (re-reads the session from Stripe; only the person who started it), `POST /billing/portal-session`, `POST /billing/seats/preview` (proration from Stripe), `PUT /billing/seats` (updates Stripe then re-reads and applies; seats at 0 are removed from the subscription),
    `POST /stripe/webhook` (`@Public`, raw body via `rawBody: true` in `createApp` and `main.ts`, signature first, event id once, subscription/invoice events **re-fetch** from Stripe and apply, failed → 500 so Stripe retries, unknown organisation → ignored 200). `DatabaseService.asApi()` runs system work on the API login. Overview adds `trialEnd`, `checkoutAvailable`, `providerManaged`.
    Env `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_BASE_URL` optional (unset → `503 billing_unavailable`). `scripts/stripe-setup.mjs` creates the products/six GBP prices idempotently and prints the SQL for the price ids. UI: `components/billing/SeatPicker.jsx`, `CheckoutNotice.jsx`, `hooks/useCheckoutReturn.js` (confirms on return, polls ~30 s, cleans the address), `lib/billing.js` (choice kept in sessionStorage across a cancelled checkout),
    wizard `PlanStep` (choose seats → Stripe → back; summary and Manage billing once valid), Settings → Subscription (Manage billing, trial/cancel notices, Start subscription card, seat changes with a Stripe price preview). **Not live-tested against Stripe** (no keys yet): the real gateway's calls follow Stripe's types; run the test-mode checklist in `docs/stripe-setup.md` §5 before switching the gate on.
  - **ON4 done (team and roles; plan §14):** migration `20251201100000_invitations.sql`. `organisation_users.invite_message/expires_at/last_sent_at/send_count`; **the invitation row is still inserted under RLS, its details are written by functions**: `app.set_invitation_details(membership, message, package)` (members.manage; message ≤ 500; 14-day expiry;
    **reserves a seat when a package is given** via `assign_subscription_package`, needs `subscription.seats`, `QM009` when none free, the whole invite rolls back), `app.resend_invitation` (not within 60 s, at most 10 sends, extends to 14 days), `app.revoke_invitation` (frees the reserved seat; only pending invitations). `app.accept_invitation` refuses an expired invitation (own message). Errors `QM015` → `409 invitation_rule`.
    `app.my_invitations()` now returns message, expiry, `expired`, roles, departments, package; `app.list_members()` returns `invite` on invited rows. API (`api/src/members/`): `POST /members/invitations` takes `message`, `packageSlug`; `POST /members/invitations/bulk` (≤ 50, **each row independent, one result per row**, duplicates in the request flagged), `POST /members/{id}/invitation/resend|revoke`
    (404 outside the organisation); `PATCH /members/{id}` to removed on an invited member now goes through revoke (seat freed). `InvitationMailer`: Supabase invite for a new address; for an **existing account** a Supabase sign-in link (`/auth/v1/otp`, `create_user: false`) landing on `/accept-invite` (`APP_BASE_URL`, else beside `INVITE_REDIRECT_URL`); email stays optional and never loses the invitation.
    UI: wizard step 6 = `components/onboarding/TeamInvite.jsx` (paste addresses, set role/department/package for everyone or per person, live seats left, buy more link, blocked when a package is oversubscribed, per-row results, failed rows stay; `PendingInvitations` list with expiry and Resend/Revoke), Settings → Users (message + package on the invite form, invitation detail and Resend on invited rows),
    **`/accept-invite` (`AcceptInvite.jsx`, outside `<App />`)**: invitation in words (who, role, departments, seat, message, expiry), asks for a name if the profile has none (`useUpdateProfile`, `PATCH /me`), joins, then a welcome (role, seat, two-factor if required, where to start by permission); `SetPassword` in invite mode now ends there.
    Also: the sign-in pages and "Start your organisation" no longer scroll the window, only their content area (`AuthPage`, `NoOrganisation`). **Dashboard:** `components/dashboard/OnboardingCard.jsx` (organisation-themed card: steps done, next step, what is still needed, links to every step; shown to people with `organisation.manage` while `onboarding === "in_progress"`, gone once the wizard is finished); the three NC register link cards were removed.
  - **ON5 done (operator panel and scheduled jobs; plan §15):** migration `20251202100000_platform_monitor.sql`. Admin-only (`app.is_platform_admin()` = allow-list AND `aal2`, else `42501`) read functions, **counts and billing only, never quality data**: `app.platform_organisations(search, limit, offset)` (owners, members, set-up, subscription, seats, MRR, `total_rows`),
    `platform_revenue()` (MRR = active + past_due Stripe-billed, trial MRR, ARR = MRR × 12, by status/interval, seats by package, trials ending in 7 days, cancelling, new/cancelled in 30 days; annual ÷ 12 via `app.subscription_monthly_pence`), `platform_payments(limit)`, `platform_webhooks(hours)` (last received, counts by status, stuck > 5 min, failed with error), `platform_activity(limit)`.
    `organisations.status` now allows **`archived`** (+ `archived_at`, `archived_reason` unpaid_setup|lapsed|operator): members cannot see or use it (`is_member` needs `active`), data kept, undo with one UPDATE. **API-login-only** jobs: `app.system_reconcile_candidates(limit, stale_minutes)` (Stripe subscriptions unsynced for an hour, oldest first; ones over 30 days past their end skipped) and
    `app.system_archive_stale_organisations(unpaid_days 14, lapsed_days 90, dry_run default true)` (only `billing_required` organisations: never had a real subscription + set-up unfinished + older than 14 days, or subscription invalid for over 90 days; never grandfathered or valid ones; idempotent). API: `GET /platform/organisations|revenue|payments|webhooks|activity` (404 non-operator, 403 `mfa_required`; on the sweep allowlist);
    `api/src/cron/` `GET|POST /internal/cron/reconcile?limit&staleMinutes` and `/abandoned-setups?dryRun&unpaidDays&lapsedDays` (`@Public`, `CronGuard`: `Authorization: Bearer <CRON_SECRET>`, constant-time, **503 `cron_unavailable` without `CRON_SECRET`**, 401 otherwise; **dryRun defaults to true**, the schedule passes `dryRun=false`; excluded from OpenAPI so not in the sweep; reconcile uses `StripeBillingService.syncSubscription`,
    one failure never stops the rest). `api/vercel.json` `crons`: reconcile 02:30 and abandoned-setups 03:30 daily (**Vercel runs crons on the production deployment only**; on dev call them with curl). Trial-ending notices were not built (Stripe emails them). UI `/platform` has tabs (`?tab=` overview | revenue | organisations | payments | webhooks | activity; `components/platform/`), hooks in `usePlatform.js`; the page scrolls inside itself, not the window.
    Env `CRON_SECRET` (20+ characters, optional).
  - **ON6 done (go-live, warnings, browser journey, exit check; plan §16, `docs/onboarding-exit-report.md`):** migration `20251203100000_go_live_checklist.sql` (**not applied live yet**): `app.go_live_checklist(org)` (`organisation.manage`; required: subscription valid, a site, a department, someone invited; recommended: legal name + country, logo, security decision, someone joined, first NC) → `GET /onboarding/checklist`; `GoLiveCard` on the dashboard (once the wizard is finished, until the required items are done; `lib/goLive.js` labels/links); `SubscriptionBanner` in `App.jsx` (`subscriptionWarning`: past due with the date access stops, trial ending ≤ 3 days, set to cancel; the last two dismissible per session; hidden on the billing page). **`npm run journey`** (`scripts/journey/`: real Vite app + real API + migrated throwaway Postgres; `stack.cjs` holds the fake Supabase auth/REST and fake Stripe gateway with a local Checkout page; `journey.cjs` the steps; screenshots to `JOURNEY_OUT`, default `/tmp/journey`; needs Playwright). It found and fixed a real bug (details step wiped typed text). Live guardrails: 0 violations; advisors: turn on leaked password protection. Go-live runbook is in the exit report; the billing gate is still **off**.
- **Operator job hub** (`docs/operator-hub-plan.md`, `docs/operator-hub-exit-report.md`; slices OH1–OH5, all done): a streamlined operator screen over the in-process inspection. **A job is an in-progress `inspection_records` row**
  (no new table; `app.start_inspection` still creates it, so resolver, sampling, gauges, NC raising and SPC alerts apply). Migration `20251207100000_job_details.sql` (applied live): `app.inspection_record_rules` lets `work_order`, `lot`,
  `lot_size`, `serial` change while the job is `in_progress`; everything else stays frozen; `app.set_job_details(id, work order, lot, lot size, serial)` (`inspection.record` at the site; NULL keeps, empty clears; `QM008`).
  API `api/src/jobs/`: `GET /jobs/preview?partId[&machineId&operationCode]` (control plan, operations, site, whether quantity is needed, resolver problems; machine optional), `POST /jobs` (machine + part + operation (+ quantity); site from the
  machine, else the organisation's only site; trigger first-off, else first planned, else manual), `GET /jobs/mine`, `PATCH /jobs/{id}` (details), `GET /jobs/{id}/recent-ncrs` (same part, same family, or raised from an inspection on the same
  machine/operation via `inspection_ncr_links`; `canRead` false without `ncr.read`), `GET /jobs/{id}/revisions` (part and plan revisions, New, current, runningOnIt, superseded flags); the inspection list takes `mine=true`.
  UI `src/components/jobs/`: `StartJobCard` (dashboard, `inspection.record`; resume list), `StartJobDialog` (part first, loading/green/red plan message, operation from the plan, machine, quantity only when needed; `lib/jobs.js` remembers the last
  machine), `JobPage` at `/Jobs/:id` (job info saved as each field is left, optimistic; banner when a newer revision is in force), `panes/` (`SidePanes` launchers and sliding pane with `Pager`, `AlertsPane` + `AlertFileViewer`, `NcrsPane`,
  `RevisionsPane`; a pane shows only to people who may read it). The recording pieces of the inspection page now live in `inspection/recording.jsx` and serve both screens. Hooks `useJobs.js`. Alerts and revisions are information only.
- **Master data overview** (`docs/master-data-dashboard-plan.md`; Master Data → Overview, `/Master-Data`, `master-data/MasterDataDashboard.jsx`, hook `useMasterDataDashboard`, `lib/masterData.js`): API `GET /master-data-dashboard` (`api/src/master-data/master-data-dashboard.ts`, `master_data.read`, no migration): totals per kind (total, active, added in 30 days), **data-quality checks** over active records (parts with no released revision / family / customer, machines with no site, employees with no department; zero shown as healthy), records added per week (12 weeks), parts by family, machines by site, employees by department, part revisions by status, the latest ten records, and the **change-event stream** from `outbox_events` (needs `audit.read`, else `events.available` is false). **No connector, import or sync tables exist, so none are reported**; the page says so. When connectors arrive (brief §7) their state belongs on its "Integrations and change events" card.
- **Part revision corrections** (`docs/revision-correction-plan.md`; migration `20251208100000_part_revision_corrections.sql`, applied live): a released revision is frozen, so when the drawing and our record disagree a **correction keeps the drawing's letter and adds a version** ("Rev B v2") instead of up-revving. `part_revisions` gains `version`, `corrects_id`, `correction_reason`, `corrected_at/by` and status `corrected` (the wrong released version: kept, frozen, never edited or deleted); unique per (part, letter, version), one open correction per version. `app.start_part_revision_correction(revision, reason)` (`master_data.manage`; only the current released revision; reason required; draft of the next version with values copied by the existing copy trigger) and `app.release_part_revision_correction(revision)` (**`process_control.approve`**; the preparer may approve; one transaction: old → `corrected`, draft → `released`, event `part.revision.corrected` instead of `.released`). Both switch on `app.revision_correction` for their transaction; the lifecycle trigger refuses direct correction inserts, direct release of a correction and direct `corrected` otherwise (`QM003` → `409 invalid_revision_state`). The resolver uses the one released row, so new inspections use the corrected values while existing inspections, NCs and resolutions keep the exact version row they used. Correcting an already-superseded revision is **not** supported. API (`api/src/master-data/`): `POST /part-revisions/{id}/correction {reason}`, `POST …/release` (routes a correction to the function), `GET …/correction-impact` (inspections and NCs that used the replaced version, capped at 50 with totals, `canReadInspections`/`canReadNcrs`; information only), revisions carry `version/correctsId/correctionReason/correctedAt`, parts `currentVersion`, the job hub's revisions `version` (a correction's summary reads "Correction: <reason>"). UI: part page revision table ("A v2", **Correct** on the released row, **Approve and release** for approvers with an impact summary, **Discard**), `RevisionCorrection.jsx` (`CorrectDialog`, `ReleaseCorrectionDialog`, `CorrectionImpactCard`), `lib/partRevisions.js` (`revisionLabel`, `currentRevisionLabel`), the job hub banner says "corrected" not "newer revision". Pushing the API before the migration breaks the parts endpoints (they select the new columns).
- **NC containment and disposition** (`docs/ncr-containment-disposition-plan.md`; migration `20251209100000_ncr_containment_disposition.sql`, applied live; closes Phase 2 slice 2.5 for these two): `ncr_containment_actions` (kind quarantine/sort/stop_ship/notify_customer/notify_supplier/recall/other, description, owner employee, due, quantity contained; status open/done/cancelled; **done needs a result note and is stamped by the database**, cancel needs a reason, reopen clears the stamps, nothing deleted; a done or cancelled action is frozen until reopened), `nonconformances.containment_not_needed_reason`, and `ncr_dispositions` (decision rework/repair/scrap/use_as_is/return_to_supplier/concession, quantity, instructions, reference; status proposed/approved/cancelled). Dispositions are **proposed** by anyone with `ncr.update`, **approved only by `app.approve_ncr_disposition`** (new permission **`ncr.approve_disposition`**: owner, admin, quality manager; the preparer may approve; a concession needs a reference) and **frozen once approved**; `app.cancel_ncr_disposition(id, reason)` (a proposed one by an editor, an approved one only by an approver). **The quantities of proposed and approved dispositions never exceed `quantity_affected`, and the quantity affected cannot be lowered below them.** Errors `QM005` → `409 ncr_rule`. **Cumulative stage gates** (`app.ncr_gate_problems(ncr, target)` used by trigger `nonconformances_stage_gates` and by the API): to reach Contained, Investigating, Dispositioned, Awaiting closure or Closed containment must be resolved (no open action and at least one done, **or** a reason none was needed); to reach Dispositioned, Awaiting closure or Closed also no proposed disposition left and approved ones covering the whole quantity affected. Skipping stages cannot bypass them; cancelling, reopening and draft → open are ungated; existing NCs keep their stage. Event `ncr.disposition.approved`. API (`api/src/ncr/ncr-workflow.*`): `GET /ncrs/{id}/containment|dispositions|gates`, `POST /ncrs/{id}/containment-actions|dispositions`, `PUT /ncrs/{id}/containment-reason`, `PATCH /ncr-containment-actions/{id}`, `POST …/complete|reopen|cancel`, `PATCH /ncr-dispositions/{id}`, `POST …/approve|cancel`. UI: `NcrContainment.jsx` and `NcrDispositions.jsx` on the NC page (their own sections and side-menu entries; **no `<form>` of their own because the NC page's form contains them**), `StageBar` lists what is needed for the next stage, hooks `useNcrContainment|useNcrDispositions|useNcrGates`, `lib/ncrWorkflow.js`. **Tests that move an NC past Open must settle it first** (`pg_temp.settle_ncr` in `supabase/tests/helpers.sql`, `settleNcr` in `api/test/helpers.ts`). Pushing the API before the migration breaks the new endpoints.
- **Manufacturing traceability** (`docs/phase-3-plan.md`; slices TR1–TR6, decisions D1–D6 agreed; **TR1 and TR2 done**, migration `20251210100000_production_traceability.sql`, applied live): `production_orders` (number unique per organisation any case, part, optional revision/customer/site, planned quantity, status planned → released → in_progress → completed → closed | cancelled; reserved `external_system`/`external_id` for Phase 5, people cannot set them), `production_operations` (sequence, code, machine at the order's site; an order cannot complete while one is pending/in progress), `lots` (produced from an order or received from a supplier; open / on_hold with reason / released / closed) and `serial_numbers` (in_production / completed / scrapped with reason), all with RLS by `production.read` / `.manage` (site-aware), no deletes, audit, errors `QM017` → `409 production_rule`. **Links:** `inspection_records` and `nonconformances` gain `production_order_id`, `lot_id`, `serial_id` (composite FKs); `app.production_link_resolve` checks part/lot/order/serial agree and fills the implied ones (serial → lot, order, part; lot → order, part), and the typed `work_order`/`lot`/`serial` text is filled from the picked record. Jobs are linked only through `app.set_job_links(inspection, jsonb)` (`inspection.record` + `production.read`, running jobs only); NCs through their normal UPDATE grant. **TR2 (API + registers):** `api/src/production/` (`/production-orders` incl. `:id/operations`, `/production-operations/{id}`, `/lots`, `/serial-numbers` (one, list or range, ≤ 500, all or nothing), each with `GET …/lookup` for pickers; a status move is a `PATCH` with `status` (+ `statusReason`), the database answers `409 production_rule`); UI `src/components/production/` (menu group Production, `/Production/Orders[/:id]|Lots|Serials`; generic `RegisterPage`, `OrderDialog`/`LotDialog`/`SerialDialog`, `StatusMoves`, `pickers.jsx`), hooks `useProduction.js`, `lib/production.js`. Production is **not** subscription-gated (no feature maps `production.*`). **TR3 done** (migration `20251211100000_production_links.sql`, applied live): organisation settings `use_lots_and_serials` (default on; off hides Lots and Serial numbers), `allow_inline_orders` and `require_production_order` (default off; the latter is enforced when a job is completed); `app.create_order_inline` and `POST /production-orders/inline` (orders only, never lots or serials); `links` on inspections and NCs, `PUT /jobs/{id}/production-links`, pickers on the job hub, Start job, NC form (`production/pickers.jsx`, `OrderPickerWithCreate`, `LinkNotices`, hook `useProductionSettings`), Settings → Organisation → Production (`Settings/ProductionSettings.jsx`); SPC subgroup basis `order`; the **backfill** `app.system_backfill_production_links` (API login only) via `POST /production/backfill {dryRun}` (default dry run): makes orders, lots and serials from the work order, lot and serial typed on existing inspections and NCs and links the records, leaving typed text untouched, guessing nothing (an order typed against several parts is skipped). Tests that move records the backfill touches: `app.production_backfill` is the setting that lets only the link columns change. Pushing the API before the migration breaks the settings and links endpoints (they select the new columns). The inspection register has a Production order column and filter (`?order=`, `sort=order`; the "Lot / serial" column and the SPC "One lot" subgroup hide when lots are off). **TR4 done** (migration `20251212100000_ncr_affected_lots.sql`, applied live): `ncr_affected_lots` (lot of the NC's part, quantity, optional serial numbers of that lot; removed with a reason, restored, never deleted; live lots never exceed `quantity_affected`), optional `lot_id` on dispositions and containment actions (must be a live affected lot; per-lot disposition quantities never exceed the lot's; a lot cannot be removed while one names it), and the gate: an NC that names lots needs approved dispositions naming **each** lot to cover it before Dispositioned (an NC that names none behaves as before). `raise_ncr_from_inspection` now copies the order, lot and serial **links**. API `GET|POST /ncrs/{id}/affected-lots`, `PATCH /ncr-affected-lots/{id}`, `POST …/remove|restore`; UI `NcrAffectedLots.jsx` (only while `useLotsAndSerials`; the NC's own lot is **suggested**, never added silently). Pushing the API before the migration breaks the NC containment and disposition endpoints (they select `lot_id`). The traceability page (TR5) is still to do. Pushing the API before the migration breaks endpoints that select the new columns.
- Combo boxes: every option list (`RHFComboBox`, `ComboBox`, `CurrencyComboBox`, the status and user combos) renders in a `fixed` portal on `document.body` with `data-popover` through `ui/useFloatingList.js`, so dialogs and panes never clip it.
- Subscriptions (`docs/subscription-plan.md`, migration `20251110100000_subscriptions.sql`): packages are separate from RBAC;
  `app.has_permission` = RBAC AND MFA AND entitlement (`app.check_entitlement`), only for organisations with
  `organisation_settings.entitlements_enforced`. Billing permissions `subscription.*`/`invoices.read`; API `api/src/billing/`;
  Settings → Subscription & billing; `RequireModule` + `useModuleAccess` for UI gating; seat limit error `QM009` → `409 subscription_rule`.
  Stripe arrived with ON3 (below).
- Notifications (in-app; `docs/notifications-plan.md`): `emit_notification` trigger on `audit.events` → `notifications`; event catalogue `notification_event_types`; visibility = permission + subscription + user preference (defaults follow access); API `api/src/notifications/`, hooks `src/hooks/useNotifications.jsx`, Settings → Notifications. Email later.
- NC register filters live in the URL (`FILTER_KEYS` in `src/hooks/useNCMFilters.jsx`); `/ncrs` takes
  stage, severity, from/to, partId, customerId, supplierId, costMin/costMax, qtyMin/qtyMax; slider limits from
  `GET /ncrs/ranges`. List parameters go to SQL as one text value (`string_to_array`), never a JS array.
- NCR files: upload to `nc-files` at `<org>/ncr/<ncr id>/<uuid>-<name>` (`uploadFileToSupabase`), then
  `POST /ncrs/{id}/attachments`; storage policies allow uploads only into an existing NCR's folder and
  never delete. Forms built with react-hook-form use `noValidate` (TextInput sets native `required`).
- Settings pages use `src/components/ui/MenuCard.jsx` for every card (header strip with title, subtitle and an
  optional `action`; `as="form"` etc., extra props go to the root; `Accordion` is a collapsible MenuCard).
  Profile pictures: `ModalImageUploader` crops to a square with `ui/ImageCropper.jsx` and uploads a 512 × 512
  WebP made by `cropToBlob` (`src/lib/cropImage.js`), so large photos fit the bucket limit.
- **Optimistic UI for all new features:** toggles, quick edits and similar small saves update the screen immediately (TanStack `onMutate` + `setQueryData`), then revert to the previous data in `onError` (with an error toast) and refetch in `onSettled`. Example: `usePreferenceMutation` in `src/hooks/useNotifications.jsx`. Use a pending/loading button only for heavier submits.
- **Refresh after every action:** every mutation hook calls `refreshOrganisation(queryClient, organisationId)` from `src/lib/refresh.js` on success (`settle` in `lib/optimistic.js` does it for the optimistic hooks), which marks all of the organisation's cached data stale (`["api","org",<org>]`; only what is on screen refetches at once). Pass `{ me: true }` when an action can change what people may do (roles, members, subscriptions, organisation details). Never invalidate only your own module's keys: other screens (My alerts and the menu badge, banners, SPC, NC and calibration views) show what the action changed. Direct `apiFetch` calls outside a hook (e.g. `AttachmentDrop`) must refresh too. `src/lib/refresh.test.js` checks every mutation hook.
- **Required fields:** every field needed to save a form or to move a record on a stage gets the `required` prop (`Field`, `SelectField`, `TextAreaField`, `TextInput`, `RHFComboBox`, `RHFDatePickerPopout`, `RHFTextArea`, pickers). It sets `data-required` on the label, which `src/index.css` draws as a red `*` (not part of the label text, so `getByLabelText("Title")` still matches), plus `aria-required`. Conditionally needed fields take `required={condition}`; on raw labels or card titles use `data-required` directly. The D-steps' "still needed" lists, NC "needed to open" and quality-alert issue rules decide what counts as required.
- Icons: **Lucide only**, imported from `@/components/icons` (`<Name>Icon`, default size 1em so
  icons follow text size). Add new icons there; ESLint rejects `react-icons` and direct
  `lucide-react` imports elsewhere.
- `.env` is untracked; copy `.env.example`. Build passes; lint has 0 errors (warnings remain).

## Agreed plan

`docs/phase-0-assessment.md` holds the Phase 0 assessment and the agreed decisions (§8):
NestJS API added in Phase 1 alongside the Vite frontend; holiday-let code archived on
branch `archive/holiday-let` then removed; Supabase project `xvpgrmujayytbbmhnoan` ("React QMS") is
canonical and its data is test data; RLS enabled in the first Phase 1 migration with policies.
Step 0 (Stabilise) and Phase 1 slices 1.1 (tenancy + RLS), 1.2 (audit trail) and 1.3 (API
skeleton), 1.4 (organisations, sites, departments, onboarding) and 1.5 (members, invitations,
roles) and 1.6 (exit check) are done — Phase 1 is complete; see `docs/phase-1-exit-report.md`. Plan and agreed decisions
in `docs/phase-1-plan.md` (API hosting decided later — a Vercel dev environment for `Dev` is described in `docs/deployment-vercel.md`; migrations checked locally with
`npm run db:check`, rehearsed on a live-data copy, then applied via the SQL editor; Supabase
built-in email for now). **Phase 2** (first complete QMS workflow) is planned and agreed in `docs/phase-2-plan.md`
(slices 2.0 auth gate → 2.1 parts → 2.2 inspection plans → 2.3 results → 2.4 NCR core → 2.5
containment/investigation/disposition → 2.6 CAPA → 2.7 exit check); slices 2.0 (password flows, MFA), 2.1 (master data: units, customers, suppliers, parts,
revisions, outbox) and 2.4 (NCR core, brought forward: `nonconformances`, `ncr_classifications`,
stages, soft delete, legacy NCM copy; NC registers and form on the API) are done, plus NCR costs and
attachments with the NC page in the original form layout (`ncr_costs`, `ncr_attachments`, `FileDrop`,
`NcrCosts`) — see plan §9–§12;
Calibration (Phase 4) was brought forward as a complete slice (`docs/calibration-plan.md`, migrations `20251106100000_calibration.sql`, `20251107100000_calibration_attributes.sql`; demo data `supabase/seed/calibration_demo.sql`);
slices 2.2/2.3 are replaced by the process control plan (`docs/process-control-plan.md`); PC1–PC6 (and PC3b) are done; the process control plan is complete.
The project still signs tokens with the legacy HS256 secret (JWKS endpoint is empty), so the API
needs `SUPABASE_JWT_SECRET` until the project moves to signing keys.

## Commands

- `npm run dev` — dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm test` — Vitest unit/component tests (`src/**/*.test.{js,jsx}`)
- `npm run db:check` — apply all migrations to a throwaway local Postgres and run `supabase/tests/*.test.sql`

- `npm run journey` — browser journey of the whole onboarding (sign-up to invited colleague) against the real app, API and a migrated throwaway database, with fake Supabase and Stripe; needs Playwright; ~2 minutes

- `npm run api:build` / `npm run api:test` / `npm run api:test:e2e` — API build, unit tests, e2e tests against a migrated throwaway Postgres

Before committing: `npm run lint && npm test && npm run build`, plus `npm run db:check` for any
migration change and `npm run api:test && npm run api:test:e2e` for API changes.

Guardrails that will fail on purpose when something new is added without tenancy:
- `supabase/tests/guardrails.test.sql` (new table without RLS/policy/organisation_id, view without
  security_invoker, function without search_path, anon privileges, missing audit trigger);
- `supabase/tests/tenancy_sweep.test.sql` (new tenant table must be seeded for the sweep);
- `api/test/tenancy-sweep.e2e-spec.ts` (new route must be `@OrganisationScoped` or allowlisted;
  new `{id}` route needs a sample body).
`supabase/checks/guardrails.sql` can be run read-only against the live project.

## Git

- Working branch: `Dev` (capital D). `main` is the other long-lived branch.
- **Do not push to `Dev` (or any branch) until the user says so** — every push triggers Vercel
  builds. Commit locally and tell the user what is waiting to be pushed.
