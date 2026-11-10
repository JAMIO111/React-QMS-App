# Integrations (Phase 5) — exit report (IN9)

Date: 2026-11-10. Plan: `docs/connectors-plan.md` (decisions D1–D10, E1–E4, F1–F3, slices IN0–IN9). This closes Phase 5.

## 1. What was built

- **Framework (IN1–IN2):** providers, connections with a lifecycle (draft → ready → active ⇄ paused → retired; a different person activates,
  except an organisation-wide Owner or Admin), credentials in Supabase Vault (the table keeps only the secret id; never returned, logged or audited),
  the sync engine (runs as queue and record, staging inbox with content hashes, the external-record map, cursors, append-only run errors, leases,
  back-off), every write through SECURITY DEFINER functions, Controller seat required for every `integrations.*` permission.
- **Files (IN3–IN4, UX1, UI2):** CSV and Excel upload, encoding and separator worked out, the three-step wizard, import templates with frozen
  versions, steps and a closed formula language, a server-side preview, import settings (add / add and update / update only, match existing),
  references by source id or Fortress code, importers for eight kinds of record plus custom fields.
- **Production and purchasing (IN5–IN6):** production orders (status one allowed step at a time), field ownership enforced in the database with a
  review queue, purchase orders, goods receipts (historical mode, returns), received totals and a reconciliation check.
- **REST connector (IN7):** `SafeHttpClient` (https on 443, host names only, every resolved address public, the socket pinned to the checked
  address, no redirects, timeouts and size caps, no hop-by-hop or forwarding headers), API key / bearer / basic, five paging styles, incremental by
  a high-water field, Retry-After, an organisation allow-list.
- **Keeping it healthy (IN8):** a daily schedule per API connection and kind of record, records that disappeared (guarded deactivation), rows that
  need a person (ignore with a reason or bring back; the source row is never edited), import health.
- **Map fields for an API connection** (after IN7): the API's first page feeds the same mapping editor as the file wizard.

## 2. Evidence

### Browser journey (`npm run journey`, all steps pass)

The new step `importFromApi` (`scripts/journey/journey.cjs`) runs against a fake ERP in the stack (`startFakeErp`, `erpConnectors` in
`scripts/journey/stack.cjs`): the API's connector is the real `RestApiAdapter` over the real `SafeHttpClient` with every rule applied; only DNS (one
name → 127.0.0.1, allowed there and nowhere else) and the last hop (plain HTTP to the fake server) are swapped, as in the REST e2e test.

| Step in the browser | What was checked |
|---|---|
| Connect an API: address, bearer sign-in, test path, Machines at `/v1/machines`, list in `data`, page numbers, 2 per page | The connection is saved and opens |
| Store the token, Test connection, Mark ready, Activate (Owner self-approval) | "The API answered 200 at /api/health"; status active; the token does not appear anywhere in the page |
| Map fields from what the API sends; choose Site ← `plant`; Import, saving a new template | Examples from the API (ERP-M1, Erp lathe, MAIN); both pages read; 3 machines created, 1 rejected (no name) |
| The same import again | 0 created, 0 updated, 3 unchanged; still 3 machines and 3 mapped records — **no duplicates** |
| The ERP fixes the rejected record and sends a new bad one; import again | The fixed record is created; the bad one is rejected; the fixed one no longer needs a person |
| Ignore the bad row with a reason | Stored with its reason; "Nothing needs a person" |
| Revoke the credential, then Test connection | "No credential stored"; the test fails with "Store the credential for this connection first" **without calling the ERP** |

Screenshots `80`–`85` in the journey output folder.

### Automated tests

| Suite | Result |
|---|---|
| Frontend (`vitest`) | 1236 passed (121 files) |
| API unit | 307 passed |
| API e2e (incl. tenancy sweep, REST connector, schedules, catalogue drift) | 842 passed (70 suites) |
| SQL (`npm run db:check`) | 86 test files pass |
| Lint / build | 0 errors / passes |

### Live project

- Guardrails (`supabase/checks/guardrails.sql`, read only): **0 violations** after the last integrations migration (IN8, applied 2026-11-10).
- Advisors: security — "signed-in users can see the object in the GraphQL schema" for every table (174, 18 of them integrations; RLS still decides
  what rows anyone reads; the same finding as every earlier module) and leaked-password protection still off (open since ON6: switch it on in
  Supabase Auth). Performance — unindexed foreign keys and unused indexes (INFO; mostly the created-by / updated-by stamps) and one multiple-permissive-
  policies warning on `capa_actions` (deliberate since CAPA6: managers and the assignee). Nothing new or specific to integrations.

## 3. Brief §14 — integration checks

| Check | Where it is shown |
|---|---|
| Repeated imports do not create duplicates | Journey (second import), `integration-runs`, `integration-imports`, `integration-rest` e2e (same import twice writes nothing) |
| Failed records can be inspected and retried safely | Run page rows with errors and the record as it arrived; retry applies only the newest copy (`integration-runs` e2e); ignore / bring back (`integration_schedules_missing.test.sql`, journey) |
| Mapping errors are actionable | Server preview names the field and reason per row; the column check lists missing columns; `mappingProblems` refuses a template with the problem named (`integration-templates` e2e, `ApiMapping.test.jsx`) |
| Sync cursors and pagination work correctly | `rest-api.adapter.spec.ts` (five paging styles), `integration-rest` e2e (incremental sends the high-water mark), journey (page 2 read) |
| Credentials can be revoked / rotated | Journey (revoke, then the test fails without calling out); Replace on the connection page; Vault-only storage (`integrations_core.test.sql`) |
| External writes cannot bypass QMS business rules | Every import goes through `app.import_<kind>` under the requester's claims and the record's own triggers (suppliers pending approval, NCs as drafts, order status one step at a time); `integration_ownership.test.sql`, `integration_purchasing.test.sql` |
| Source provenance is retained | `integration_external_records` (connection, kind, external id → record, hash), `external_system`/`external_id` on orders, audit actor = the person who imported (`app.initiating_user`) |
| Conflict behaviour is explicit and tested | Field ownership source wins / Fortress wins / review, the review queue (`integration_ownership.test.sql`, `integration-ownership` e2e, `IntegrationReview.test.jsx`); disappeared records held over 20% (F1) |
| Tenant boundaries (direct, file, export, background job) | Tenancy sweeps (SQL and API) cover every integration table and route; files only in the organisation's folder; runner functions take the organisation and re-check the lease |

## 4. Found and fixed during the exit check

- **The Map fields page started from a template made for another source.** It defaulted to the template used most recently for the kind of record —
  here the one made from a CSV file earlier in the journey — whose columns the API does not send, so every field showed an error. The Run dialog had
  the same default for API connections. Now an API connection starts from the template its own latest import of that kind used, and otherwise from
  a new mapping (`connectionTemplate` in `src/lib/importTemplates.js`); other templates are still offered to choose. Tests in `ApiMapping.test.jsx`
  and `RestConnector.test.jsx`.
- **The mapping editor spoke of files on an API page** ("column in your file"): it now takes `source="api"` and says "field the API sends" throughout (`SOURCE_WORDS` in `MappingStep.jsx`).
- **The journey had fallen behind IN8:** the master data overview no longer says "No connectors…" (the import health summary replaced it).
- Found just before IN9, from use of the dev environment: every REST call failed before connecting (the pinned socket answered Node's address lookup
  in the wrong shape) — fixed and covered by a real-socket test in `safe-http.spec.ts`; dialogs jumped when a switch was pressed — fixed in `Switch`
  and `Dialog`.

## 5. Not built / limits

- Email or push when an import fails or records wait; a time of day per connection (Vercel runs the daily cron once, in production only — on dev the
  cron is called by hand).
- OAuth client credentials, POST queries, custom headers, non-JSON answers; webhooks; writing back to a source.
- Editing a rejected row in Fortress (by design, F2), reactivating a returned record, bulk decisions in the review queue, reviewing custom fields.
- Production order operations, reconciliation net of returns.
- Bespoke SAP, Dynamics, Sage, Odoo, database agents (brief §7.3: after the generic connectors are proven — they are shown as "Coming soon").
- `IntegrationFiles.test.jsx` (the formula editor test) and `SetPassword` have each failed once under full-suite load and pass on their own; timing,
  not behaviour, but worth hardening.
- Real third-party APIs were not called from here (no outbound access to them in this environment); the dev deployment's Mock API connection is the
  first real one.
