# Document control — exit report

**Date:** 2026-11-11 · **Plan:** `docs/document-control-plan.md` · **Slices:** DC1–DC6 · **Branch:** `Dev`

## What was built

Controlled documents in the Documentation module: an identity (`SOP-001`) separate from its revisions (rev A, B …). **Information only: nothing here blocks work.**

- **Types, documents and drafts (DC1):** document types with their own prefix and numbering (seeded: SOP, WI, FRM, SPEC, POL, EXT), documents numbered from their type or typed when brought across, drafts written in the TipTap editor (stored as JSON only, never HTML) or held as a main file with attachments.
- **Review and approval (DC2):** named reviewers and an approver (never the author), review rounds, sending back with a comment, approval with an effective date, settling into force without a worker (on every read and a daily cron), superseding the previous revision, withdrawing, starting a new revision from the one in force, comparing revisions.
- **Readers (DC3):** readers by department, role or person, fixed when a revision takes effect; first view and acknowledgement with a due date; restricted documents; My documents and its menu badge; skills a document trains, shown as evidence on the competence record.
- **Life after issue (DC4):** periodic review dates per type or document, "no change needed" reviews kept, change requests raised by readers and accepted or declined by managers, links to parts, part families, machines and operations, and documents in force shown where work happens (part, family, machine, Start inspection, the job hub).
- **External documents, controlled copies, dashboard (DC5):** documents issued by someone else (issuer, their reference and revision, recorded as issued instead of reviewed), PDFs stamped on every page as a controlled copy or "not for use", a stamped print view for written documents, and the documents dashboard at `/Documentation`.
- **Exit check (DC6):** this report, the live checks below and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20260206200000`, 100 SQL tests incl. the five `document_control_*` suites, guardrails and the tenancy sweep) | pass |
| `npm run api:test` (343) and `api:test:e2e` (83 suites, 935 tests incl. `documents`, `document-review`, `document-readers`, `document-periodic-links`, `document-external` and the API tenancy sweep for every documents route) | pass; `integration-schedule` fails in some full runs under load and passes alone (a known, unrelated flake) |
| `npm test` (1,386 Vitest tests), `npm run lint` (0 errors), `npm run build` | pass |
| Live guardrails (`supabase/checks/guardrails.sql` against the live project) | **0 violations**; the "must be audited" rule lists the twelve document tables |
| Live objects (DC5) | `documents.origin` / `issuer` / `external_reference`, `document_revisions.issuer_revision`, `app.create_external_document`, `update_external_details`, `issue_external_revision` present; none executable by `anon`, all with a fixed `search_path` |
| Advisors (security) | no finding about documents. The two warnings are project-wide: every table is visible to GraphQL (198 objects) and **leaked-password protection is off** (a Supabase dashboard setting) |
| Advisors (performance) | nothing about documents beyond INFO: foreign keys without a covering index (the audit and actor columns, like every other module) and indexes not yet used (the tables are new). The one WARN is the CAPA actions table's two update policies (CAPA6, by design) |
| Browser journey (`npm run journey`) | the new step passes: the owner writes a procedure in the editor, names Colin as reviewer and approver and inspectors as readers, sends it; Colin sends it back with a comment; the owner fixes it and sends it again; Colin accepts and approves it for today, it is in force as rev A after two review rounds; Colin (an inspector, so a reader) finds it in My documents and acknowledges it; the owner starts rev B (the text carried over) and the dashboard counts the document in force |

## What the browser found

Two real faults no test had found:

1. **Typing just before "Send for review" could lose the last words.** The editor saves when typing pauses (0.8 s). A click inside that pause sent the draft on first, and the save then arrived after the draft was in review and was refused, losing the last words typed. The page also said "saved" during the pause. Now the page saves what is waiting and waits for that save before sending for review or recording an issue, and the header says "unsaved changes" during the pause.
2. **Switching the editor to read-only fired a save of a revision that was no longer a draft** (TipTap's `setEditable` announces an update). The editor now changes mode silently and never saves while read-only. A failed save is reported once by the page, never as an unhandled error.

A third, older fault showed up because Colin now visits the Documentation pages: the module guard (`RequireModule`, around Documentation, CAPA and Process control) **asked for the plan catalogue for everyone**, so every person without `subscription.read` got a refused call on each visit. It now asks only when the module is locked and the person may read subscriptions (test `RequireModule.test.jsx`).

## Rules held by the database (not only the screens)

No table writes: every change is a SECURITY DEFINER function. A revision's content changes only while it is a draft; letters are never reused; the author never reviews or approves their own revision; the approver needs `documentation.issue`; an approved revision is frozen and takes effect on its date; decided sign-offs, periodic reviews and acknowledgements are frozen; nothing is deleted (drafts are discarded with a reason, files removed with a reason, documents withdrawn with a reason). An external document's origin never changes and it cannot be sent for internal review. Restricted documents are visible only to their readers, managers, owner, authors and signers.

## Design notes and limits

- **No worker.** Revisions take effect on read and by a daily cron (`/internal/cron/settle-documents`, 00:15 UTC, production only); overdue reviews and readers are computed on read. The in-app notices are "a document is waiting for you", "a document for you to read" and the change-request decision; email follows each person's notification settings.
- **Controlled copies** need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the API (else `503 file_storage_unavailable`). Only PDFs are stamped; Word and Excel files say "Uncontrolled when printed or saved". A printed copy is controlled only for the day it was printed (the stamp says so); there is no register of numbered paper copies.
- Not built: images inside the editor text, page watermarks, a document-level approval workflow beyond one approver, distribution to people outside the organisation, import of an existing document library, a subscription feature for documents (like CAPA, audits and competence, it is not gated).
- The dashboard and register were tested for correctness, **not load-tested**.
- **Migration history:** the DC5 migration was first numbered `20260206100000`, the same number as the gauge-type procedure migration from a parallel line of work; it was renamed `20260206200000_document_control_external.sql` before push (same content, already applied). Fix the history row with the SQL below.

```sql
update supabase_migrations.schema_migrations set version = '20260206200000' where version = '20260206100000' and name = 'document_control_external';
insert into supabase_migrations.schema_migrations (version, name) values ('20260206100000', 'gauge_type_procedure') on conflict (version) do nothing;
```

## Go-live runbook

Nothing to switch on. To use the module: a document manager (`documentation.manage`: owner, admin, quality manager, quality engineer) adjusts the document types (Settings → Data Management → Documents), creates documents and writes drafts; someone with `documentation.issue` approves or records external issues. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the API for controlled PDF copies.
