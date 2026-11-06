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
  Supplier; NC form at `/Non-Conformance/:type/:id`, `new` creates; hooks in `src/hooks/useNcr.js`), Human Resources (employee list), Settings.
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
- Subscriptions (`docs/subscription-plan.md`, migration `20251110100000_subscriptions.sql`): packages are separate from RBAC;
  `app.has_permission` = RBAC AND MFA AND entitlement (`app.check_entitlement`), only for organisations with
  `organisation_settings.entitlements_enforced`. Billing permissions `subscription.*`/`invoices.read`; API `api/src/billing/`;
  Settings → Subscription & billing; `RequireModule` + `useModuleAccess` for UI gating; seat limit error `QM009` → `409 subscription_rule`.
  Stripe/webhooks deferred.
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
