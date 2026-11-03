# Legacy NC entry form (reference only)

Restored from git history; **not built, not linted, not routed**.

| File | Source |
| --- | --- |
| `NCEntryForm.jsx` | `src/components/NCEntryForm.jsx` at `c37f952^` (last NC version; that commit renamed it to `BookingEntryForm.jsx`) |
| `CostData.jsx`, `CostInputForm.jsx` | `src/components/` at `e06c17b^` (removed in Step 0) |
| `FileDrop.jsx` | `src/components/ui/FileDrop.jsx` at `c37f952^` (a newer copy still lives in `src/components/ui/`) |
| `validationSchema.js` | `src/validationSchema.js` at `c37f952^` (`NCMFormSchema`, `NCCostSchema`) |

The form had four side-menu sections: **NC Details** (date, customer, work orders, part, checked
and defective quantities, description, failure mode, sub-failure mode, causal process, detection
location, responsible operator, status), **Cost** (cost list + add-cost form with currency
conversion), **Investigation** (8D badges, team avatars) and **Additional Info** (drag-and-drop
file upload).

It reads and writes the legacy `"NCM"`, `"Costs"` and `v_nc_files` tables directly through
Supabase. Since slice 2.4 the NC module uses `public.nonconformances` through the API, so this
code would not work against the new model without porting.
