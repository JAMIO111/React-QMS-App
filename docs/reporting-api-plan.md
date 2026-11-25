# Reporting API for Power BI (and other reporting tools)

Status: building (slices RP1–RP4). Decisions below were agreed on 2026-11-23.
Related: `docs/deployment-agnostic-plan.md` (why a gateway is only a customer-side concern), `docs/design-brief.md` (read-only, RLS, audit).

## 1. What this is

A read-only way for a customer to pull their own Fortress data into Power BI (and any tool that can call a web address with a key), without a person's
short-lived sign-in token. The first customer needs it, so it is built now, in the smallest form that is safe and useful.

## 2. Decisions (agreed)

| # | Decision |
|---|---|
| R1 | **Datasets for the first release:** non-conformances and their costs, and supplier quality (suppliers, SCARs, receipt lines with their decisions, saved scorecards). Others are added the same way later. |
| R2 | **A reporting key acts as the person who made it, read-only.** It sees exactly what that person may see (roles, sites, row-level security), can never write, and stops working when that person is suspended, removed or loses their seat. |
| R3 | **Connection:** Power BI Service scheduled refresh over the internet, **import mode, no gateway** (cloud-hosted Fortress). Power BI Desktop works the same way. A gateway or DirectQuery is a later, separate concern (on-premises Fortress). |
| R4 | Making and revoking keys needs `integrations.manage` (so a Controller seat, as for every integration); listing needs `integrations.read`. **No new permission or package feature is added.** |
| R5 | **A key can only call `GET /reporting/v1/*`.** Anywhere else it is refused, so a leaked key cannot write, cannot make more keys and cannot read the rest of the API. |

## 3. Design

- **Key.** `fqr_` + 32 random bytes (base64url). Shown **once**. Only its SHA-256 and a short prefix are stored (`reporting_keys`). Expires (default 365 days, 1–730),
  can be revoked with a reason, records last used time and address. Making one needs a signed-in, two-factor-satisfied session, which is the only reason a key
  may be treated as having passed two-factor: it carries `aal2`, no `amr`, so the single-sign-on and session-age rules do not apply to it (its own expiry does).
- **Sending it.** Either `Authorization: Bearer <key>` or `Authorization: Basic base64(<anything>:<key>)` (Power BI's Basic credential: user name anything, password = the key,
  so the key is never written into a report file).
- **Who it is.** `AuthGuard` recognises the `fqr_` prefix, asks the database (API login only, `app.system_report_key_lookup`) which organisation and person the key
  belongs to, and sets `req.user` and the organisation header as if that person had called. **Every existing check then still runs unchanged:** active membership,
  two-factor, seat, the organisation's network rule (a key from a disallowed address is refused), and the dataset's read permission. Row-level security does the rest.
- **Datasets.** Plain views in `public` (`report_*`, `security_invoker = true`, so the caller's rights and RLS apply, not the view owner's), flat, with readable
  column names, one stable shape per version. Joins to names use LEFT JOINs so a missing lookup right never drops a row. A new column is added to a view only
  deliberately; the API's list of datasets and columns is the contract and is tested.
- **Paging.** Keyset: `GET /reporting/v1/<dataset>?limit=5000&after=<cursor>&updatedSince=<iso>`; answers `{ data, nextCursor, count, asOf }`. Ordered by (`updated_at`, `id`).
  Power BI follows `nextCursor` with a short Power Query script the app generates. `GET /reporting/v1` lists the datasets and columns.
- **Costs.** Each cost line carries signed amounts (`net_site`, `net_organisation`: credits negative) in the site's and the organisation's currency, so a sum is right.
- **Limits.** Rows per page ≤ 5,000; a key may call at most the normal per-address rate; a statement timeout applies as for every request.
- **Audit.** Key made / revoked is audited (`reporting_keys` has the audit trigger). Reads are not audited row by row; `last_used_at` and address are kept per key.

## 4. Slices

| Slice | Content |
|---|---|
| RP1 | Migration: `reporting_keys` (functions-only writes), `app.create_reporting_key`, `app.revoke_reporting_key`, `app.system_report_key_lookup`, the six `report_*` views; SQL test; guardrail and sweep seeds |
| RP2 | API: key recognition in `AuthGuard`, read-only enforcement, reporting module (datasets, paging), key routes; e2e + sweeps |
| RP3 | UI: Settings → Integrations → **Power BI** card: make a key (shown once), the web address, the Power Query script per dataset, list with last used, revoke |
| RP4 | Checks, CLAUDE.md, commit |

## 5. Not built (and why)

- **OData.** Power BI's OData connector assumes the server honours `$filter`/`$select`/`$top`; a half implementation gives wrong numbers. A Power Query script over plain JSON is honest and simple. OData can follow.
- **DirectQuery.** Needs a live relational source; for the cloud product that would mean giving customers database access, which the tenancy design does not allow. Possible later for single-tenant (private cloud / on-premises) deployments on top of these same views.
- **Incremental refresh** beyond `updatedSince` (Power BI's own incremental refresh policy can use it, but the script does not set it up).
- Inspections and measurements, 8D, audits, risks, calibration: later datasets, same pattern.
- **Not tested against a real Power BI.** The API, paging and script are tested here; the script has not been run in Power BI Desktop or Service. First-customer check needed (§6).

## 6. First-customer checklist

1. Create a key in Settings → Integrations → Power BI (as a Controller seat holder).
2. In Power BI Desktop: Get data → Blank query → Advanced editor → paste the script; choose **Basic** credentials, any user name, the key as the password. Check the table loads.
3. Publish; in the Power BI Service set the data source credentials (Basic, the key) and a refresh schedule.
4. Confirm the figures against the NC register, and that a person with fewer site rights makes a key that sees fewer rows.
5. Note that import mode keeps a copy in Power BI's region (relevant to any data-residency promise).
