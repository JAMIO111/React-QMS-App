# Non-conformance: category and source as separate things — plan

**Status:** NS1 (database), NS2 (API) and NS3 (UI) are built and committed locally; NS4 (exit check) next. The migration `20251218100000_ncr_category_source.sql` is **not applied live yet**. Decisions D1–D4 were chosen by the product owner; the product owner then confirmed: source labels stay fixed (not renameable), the final-inspection and external-audit sources are chosen by hand for now, the backfill of factual origins (D7) is wanted, and **D9 (finding owner → NC responsible employee) is dropped**.

## 1. What is wrong today

`nonconformances.source` is a single field with three real values (`internal`, `customer`, `supplier`; `inspection` is allowed but never written). It does three jobs at once:

1. **Where it came from** — but only three places, so an NC raised from a failed calibration, an audit or a goods-in check is all "internal".
2. **Which register and form it appears in** — three registers (`/Non-Conformance/Internal|Customer|Supplier`) and `NC_TYPES` in `src/lib/ncr.js`; about 20 places hard-code `/Non-Conformance/Internal/<id>` links.
3. **Which fields are required** — customer for `customer`, supplier for `supplier` (`app.assert_ncr_openable`).

and it is **locked once created** (`nonconformances` trigger, `QM005`). There is **no category** (what kind of problem it is); `ncr_classifications` holds failure modes, sub-failure modes and processes only.

Result: the module cannot say "a gauge failed calibration" (source) "and it is a Calibration problem" (category), or "an internal audit found a Process failure". Integration-raised NCs (inspection, calibration, audit) all had to be labelled `internal`.

## 2. Target model

**Category = what the problem is. Source = where it originated or was detected.** Independent: any combination is valid (e.g. source *Calibration* with category *Equipment*; source *Internal audit* with category *Process*).

### Categories (organisation-managed)
Initial defaults, seeded for every organisation (and each new one): **Product, Process, Tooling, Equipment, Calibration, Material, Documentation, Inspection, System, Traceability, Packaging & Handling.** Organisations add, rename, reorder and switch off their own; nothing is deleted. Stored as a new `kind = 'category'` in `ncr_classifications` (single level, no parent), so the existing Settings → Data Management list, API and RLS are reused. A stable `code` (`PRODUCT`, `PROCESS`, …) marks the seeded ones.

### Sources (fixed list of eleven, D2)
| Key | Label | Example |
|---|---|---|
| `internal` | Internal | Employee identifies a defect |
| `customer` | Customer | Customer raises a complaint |
| `supplier` | Supplier | Supplier-side problem found (e.g. at incoming inspection) |
| `internal_audit` | Internal audit | Auditor identifies a process failure |
| `external_audit` | External audit | Certification auditor raises a finding |
| `production_inspection` | Production inspection | Operator finds an out-of-tolerance dimension |
| `final_inspection` | Final inspection | Finished product fails inspection |
| `calibration` | Calibration | Gauge fails calibration |
| `goods_receiving` | Goods receiving | Incoming material is incorrect |
| `engineering` | Engineering | Engineering finds an incorrect specification |
| `management_review` | Management review | Management identifies a system issue |

Sources are code-defined because they drive behaviour (below). Labels are fixed in this plan (organisation-specific renaming is **not** built; say if you want it).

### What a source drives (replaces the old "type")
| Source | Party fields | Work order |
|---|---|---|
| `customer` | customer **required to open**, customer reference | shown |
| `supplier` | supplier **required to open**, purchase order | hidden (as today) |
| `goods_receiving` | supplier **optional**, purchase order | hidden |
| all others | none | shown |

## 3. Decisions

| # | Decision | Source |
|---|---|---|
| D1 | **One register** with Source and Category columns and filters; quick-filter tabs *All / Customer / Supplier*. `/Non-Conformance/Register` and `/Non-Conformance/Register/:id` (and `new`). The old `/Non-Conformance/Internal\|Customer\|Supplier[/:id]` URLs **redirect** (bookmarks and the 20 hard-coded links keep working; the links are then changed to a helper `ncrPath(id)`). | chosen |
| D2 | Sources are the **fixed list of eleven** above. | chosen |
| D3 | A **category is required to open** an NC (draft → open); existing NCs are **grandfathered** (no category, shown "Uncategorised", never blocked later). Once an NC is past draft its category may be changed but not cleared. Existing *drafts* need one to open. | chosen |
| D4 | **Source and category are editable** by people with `ncr.update`; a **source change needs a reason** and is audited (`source_change_reason` on the row, `ncr.source_changed` event, history entry). Moving to `customer`/`supplier` on an NC that is already open needs the party chosen first. | chosen |
| D5 | Changing source **keeps** previously entered party data (customer, supplier, PO); the form simply shows what the source needs. Nothing is deleted silently. | proposed |
| D6 | **Integrations set the source** (they no longer all say `internal`): inspection → `production_inspection` (the person can switch to `final_inspection`); calibration → `calibration`; audit finding → `internal_audit`; job hub / manual → as chosen. Integrations pre-select a category only where obvious (calibration → *Calibration*); otherwise they leave it for the person (the open gate asks). This also closes the gap I reported on the audit work ("source type Internal Audit"). | proposed |
| D7 | **Backfill of factual origins only:** NCs linked in `inspection_ncr_links` → `production_inspection`; in `audit_ncr_links` → `internal_audit`; raised from a calibration (`calibrations.nonconformance_id`) → `calibration`; any stray `inspection` → `production_inspection`. Everything else keeps its source; no category is guessed. | proposed |
| D8 | **8D (CAPA) source** stays three-valued: `customer`→`customer`; `supplier` and `goods_receiving`→`supplier`; everything else→`internal`. | proposed |
| D9 | ~~Audit finding → NC also carries the finding's owner to the NC's responsible employee.~~ **Dropped** by the product owner. | dropped |
| D10 | NC dashboard: the source filter takes any source; add *by source* and *by category* breakdowns. | proposed |
| D11 | Reference numbering, stage machine, gates, containment/disposition are **unchanged**. | proposed |
| D12 | Pushing the API before its migration breaks the NC endpoints (new columns), as with earlier slices: migrations are applied live first, only when you say. | standing rule |

## 4. Slices (each complete and tested)

**NS1 — database.** Migration `2025121xxx_ncr_category_source.sql`: `ncr_classifications.kind` allows `category`; seed function + trigger on new organisations (as audit finding classifications); `nonconformances.category_id` (composite FK, must be a `category`-kind row of the same organisation, trigger) and `source_change_reason`; `source` CHECK widened to eleven; `app.change_ncr_source(ncr, source, reason)` (SECURITY DEFINER, `ncr.update`, reason required, party check when past draft, event) with the immutability trigger honouring only that function; `assert_ncr_openable` gains *category* and the per-source party rules; "category cannot be cleared past draft"; backfill (D7); the three raising functions set the source (D6; inspection has several definitions — the latest is in `20251212100000`); CAPA start mapping (D8, two definitions); guardrails list and both tenancy sweeps. **Blast radius:** about 15 SQL test files and `api/test/{ncr,capa}.e2e-spec.ts` insert NCs directly as `open`; they need a category (helpers `pg_temp.default_category(org)` / `api/test` equivalent).

**NS2 — API.** `NcrSource` enum of eleven; `categoryId` on create/patch/read; list `source` (comma-separated) and `categoryId` filters; ranges and dashboard accept any source, add by-source/by-category; `POST /ncrs/{id}/source {source, reason}`; classification routes accept `kind=category`; calibration `raise-ncr` sets source and category; e2e and sweep updated (new route needs a sample body).

**NS3 — UI.** One register page (columns Source, Category; filters; tabs All/Customer/Supplier; URL filters in `useNCMFilters`); routes and redirects; NC form with **Source** and **Category** pickers, the *change source* reason dialog, party fields by source, "Uncategorised" for old NCs; "New non-conformance" asks for source first (defaulting from the active tab); Settings → Data Management **Categories** list (existing `ClassificationList`); dashboard breakdowns; `ncrPath()` and the ~20 hard-coded links; menu (Dashboard, Register); tests and browser journey.

**NS4 — exit check.** Full suite, mutation checks on the new rules, live guardrails after applying (when you say), docs (`CLAUDE.md`, this plan, `docs/phase-2-plan.md` note).

## 5. Risks and what I'd like you to confirm

1. **Test churn** in NS1 is the biggest cost (many fixtures create open NCs). I'll fix them mechanically through shared helpers rather than loosening the rule.
2. **Labels are not renameable** (D2); the earlier option text mentioned renaming. Say if you want it.
3. **Final inspection** has no trigger of its own in the inspection module today (first-off / planned / manual), so an inspection-raised NC defaults to *Production inspection* and a person switches it. A "final inspection" notion would be a separate inspection-module change.
4. **External audit** has no audit module support (audits are internal), so that source is chosen by hand for now.
5. D9 (finding owner → NC responsible employee) is a small extra; drop it if you prefer.

## 6. What was built (NS1–NS3)

- **NS1** `supabase/migrations/20251218100000_ncr_category_source.sql`: categories (kind `category`, seeded per organisation and by trigger), `category_id`, `source_change_reason`, eleven sources (a stray `inspection` source is rewritten first), the source writable only through `app.change_ncr_source` (a transaction-local setting the trigger honours), category and party rules in `assert_ncr_openable`, integrations setting their source, 8D mapping, `app.backfill_ncr_sources()`. Test `supabase/tests/ncr_category_source.test.sql`; mutation-checked (one equivalent mutant: the change function's read check is covered by the update check).
- **NS2** API (`api/src/ncr/`, inspection, calibration): category on read/create/patch, `source`/`categoryId`/`uncategorised` filters and sorts, `POST /ncrs/{id}/source`, multi-source ranges and dashboard, by-source/by-category breakdowns. `api/test/ncr-category-source.e2e-spec.ts` (14 tests); API mutation checks caught all nine mutants.
- **NS3** UI as listed in `CLAUDE.md`.
