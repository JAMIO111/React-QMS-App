# Document control — plan

**Status:** agreed (decisions DC1–DC16, 2026-11-11) · **Branch:** `Dev`
**Module:** Documentation (beside Quality alerts) · **Brief:** `docs/design-brief.md` §6.5, Phase 4

Controlled documents: procedures, work instructions, forms, specifications and the external documents you rely on. Every
document has an identity (`SOP-001`) separate from its revisions (rev A, B, C). A revision is written, reviewed, approved,
becomes effective on a date, and is then **frozen**. A change is always a new revision. The people who must read a document
acknowledge each new revision. Like quality alerts, **nothing here blocks work**.

**DC1–DC3 are built** (see §12–§14); the rest is not. It is delivered as complete, tested vertical slices (§9), each with SQL tests, API e2e tests (both sweeps),
frontend tests, lint and build, and finished by an exit check with a browser journey step.

## 1. What it reuses

- **Permissions** `documentation.read / .manage / .issue` (owner, admin and quality manager hold all three; quality engineer read and
  manage; everyone else read). No new permission (DC9).
- **Department membership, targets → recipients → acknowledgement**, the menu badge and the overdue view from quality alerts.
- The **files pattern** (private bucket, functions only, removed with a reason, never deleted, `AttachmentDrop`).
- **Versions with a reason**, preparer ≠ approver and "frozen once approved" from audits, supplier quality and import templates.
- **`own_record` notifications** (CO4) for "you must read this" and "your review is waiting".
- Competence (skills) for the training link (DC12).

## 2. Decisions

| # | Decision |
|---|---|
| DC1 | **Content is chosen per document:** a **file** document (one main file, e.g. Word, PDF or Excel, plus optional attachments) or a **text** document written in an editor inside Fortress. The kind is fixed when the document is created. |
| DC2 | **Approval:** the author names **one or more reviewers** and **one approver**, and neither may be the author. **A reviewer may also be the approver**, so two people are enough (DC15). Each reviewer accepts or **sends it back with a comment**. Once every reviewer has accepted, the approver approves or sends it back. A send-back returns the revision to draft for the author, and every review starts again. |
| DC3 | **Numbering:** each **document type** has a prefix and its own sequence (`SOP-001`, `WI-014`, `FRM-007`). Revisions are **letters** (A, B, … Z, AA …). When bringing existing documents across, a manager may type the number and the current revision letter (unique per organisation, any case). |
| DC4 | **Reading:** each document names who must read it (departments, roles, people, as quality alerts do). The list of readers is **fixed when a revision becomes effective**, and every new revision asks them to **acknowledge again**. Overdue readers are listed. An acknowledge-by date can be set per revision. |
| DC5 | **Periodic review:** each type sets an interval in months, which a document may override. The **next review date** is worked out when a revision becomes effective. A review either records "**no change needed**" (kept, with who, when and a note; no new revision) or **starts a revision**. Overdue reviews are worked out on read, with no worker. |
| DC6 | **Where documents show:** a document can be **linked to parts, part families, machines and operation codes**. The job hub, part and machine pages list the effective documents linked to them, in the same way as `ActiveAlertsBanner`. This is information only. |
| DC7 | **Access:** by default anyone with `documentation.read` opens every effective document. A document can be marked **restricted**, so only its readers (DC4) and document managers open it. **Drafts and revisions in review** are seen only by their author, reviewers, approver and document managers. |
| DC8 | **Effective date:** approving sets the date the revision takes effect (today or later). It becomes **effective on that date**, worked out on read like quality-alert expiry, with no worker. The revision it replaces is **superseded** at the same moment, and until then the old one stays in force. |
| DC9 | **Who does what:** drafting, reviewing set-up and types need `documentation.manage`. **Approving, withdrawing and making an external document effective need `documentation.issue`.** A reviewer only needs to be an active member named on the revision, with no permission needed. |
| DC10 | **External documents** (customer specifications, standards, supplier manuals) are documents with origin `external`. Their reference, revision and issuer are typed in, and they carry a file, a review date and readers. They have **no internal review or approval**: someone with `documentation.issue` records each revision as effective. |
| DC11 | **Change requests:** any member who may read a document can **ask for a change** (what and why). A document manager **accepts** it, which starts or adds to a draft revision linked to the request, or **declines** it with a reason. The person who asked is told either way (in-app). |
| DC12 | **Training link and controlled copies.** A document can name **skills** it trains, and acknowledging it then shows on the person's competence record as **evidence** (never an assessment). Downloads of an effective **PDF** carry a **"Controlled copy, SOP-001 rev B, effective …, printed … by …"** stamp, and superseded revisions are stamped **"Superseded, not for use"**. Other file types download as they are, see §11 Q2. |

## 3. Life of a revision

```
draft ──submit──▶ in_review ──all reviewers accept──▶ awaiting_approval ──approve(date)──▶ approved ──date reached──▶ effective ──next revision effective──▶ superseded
  ▲                  │                                     │                                                          │
  └──── send back ◀──┴──────────────── send back ◀─────────┘                                          withdraw(reason) ▼
                                                                                                                  withdrawn
draft ──discard(reason)──▶ discarded
```

- **One revision in progress per document** at a time (draft, in review, awaiting approval or approved but not yet effective).
- A **draft** is edited by its author and document managers, and that is the only state where content changes. Submitting freezes the
  content for review. A send-back returns it to draft, keeping the comments.
- **Approved and effective revisions are frozen** by a trigger, so SQL is held to it too.
- **Withdrawing** a document (reason) withdraws its effective revision. The document then has no effective revision and shows as
  withdrawn everywhere it is linked. A withdrawn document can be **revised back into use** (a new revision through the normal route).
- **Revision letters** are given at submission from the document's last letter, so a discarded draft does not use up a letter.

## 4. Data model (tenant tables: `organisation_id`, RLS, audit trigger, composite FKs, **no table writes, SECURITY DEFINER functions only**)

| Table | Holds |
|---|---|
| `document_types` | Per organisation: name, **prefix** (unique, letters/digits/hyphen), next number (`app.document_type_counters`), default review interval in months, `content_hint` (file / text, a default only), active. Seeded: Procedure (SOP), Work instruction (WI), Form (FRM), Specification (SPEC), Policy (POL), External (EXT). Managed in Settings → Data Management → Documents. |
| `documents` | Number (unique per organisation, any case), title, type, **content kind** `file` / `text` (fixed), **origin** `internal` / `external` (+ `external_reference`, `issuer`), owner (member), restricted flag, review interval override, **next review date**, status `active` / `withdrawn` (with reason), `current_revision_id`, skills trained (array or child table). |
| `document_revisions` | Letter, sequence, status (§3), author, change summary (required from rev B: what changed and why), **text body** (text documents: editor JSON plus a sanitised HTML rendering, ≤ 500 kB), main file (file documents), `effective_from`, approved by and at, acknowledge-by date, superseded or withdrawn stamps, `change_request_id`s. External revisions carry the issuer's revision label as typed. |
| `document_revision_files` | Main file and attachments per revision: private **`document-files`** bucket at `<org>/document/<revision id>/<uuid>-<name>`. Written only while the revision is a draft, removed with a reason, never deleted. A new draft **copies** the previous revision's file rows, pointing at the same stored files. |
| `document_signoffs` | Per revision: reviewer or approver, the person, decision `pending` / `accepted` / `returned` / `approved`, comment, decided at. Frozen once decided. A send-back closes the round and starts a new set of pending rows on resubmission (`round`). |
| `document_targets` | Who must read the document (department, role, person). Replaced as a whole, and **copied onto the revision** when it becomes effective. |
| `document_recipients` | Fixed per effective revision: person, reached via, first viewed, acknowledged at and note. Written only by functions, as for quality alerts. |
| `document_links` | Part, part family, machine or operation code. Replaced as a whole, kept on the document (not per revision). |
| `document_periodic_reviews` | Append-only: outcome `no_change` / `revision_started`, note, who, when, the revision reviewed. |
| `document_change_requests` | Reference `DCR-YY-NNNN`, document, what and why, requester, status `open` / `accepted` (→ revision) / `declined` (reason) / `withdrawn`. |

**Worked out on read, never stored:** which revision is in force today (DC8), periodic review overdue, readers overdue, and whether a person
has acknowledged the revision in force.

## 5. Rules held by the database

- The author is neither a reviewer nor the approver of their own revision (a reviewer may also be the approver). Reviewers and the approver must be active members, and the approver must hold
  `documentation.issue` when the approval is recorded.
- Content changes only in **draft**. The revision row and its files are frozen from submission (trigger).
- Approval needs every reviewer of the current round accepted. The effective date is today or later, and a text document needs a body
  while a file document needs a main file.
- One revision in progress per document. The letter is given at submission, contiguous, and never reused.
- Recipients are resolved and stored when a revision becomes effective. An effective revision that reaches nobody is allowed (no
  readers named), unlike quality alerts.
- A restricted document is readable only by its readers and managers (RLS on documents, revisions, files and links), and its
  linked-document list hides it from others.
- Nothing is deleted: documents are withdrawn, drafts discarded, files removed (all with reasons).
- Errors use **`QM025`** → `409 document_rule`. Another organisation's id gives `P0002` → 404.

## 6. Becoming effective without a worker

`app.document_in_force(document)` returns the latest approved revision whose `effective_from` ≤ today (the caller's day). The API runs
`app.settle_documents(org)` when the register or a document is read. It is idempotent and stamps the moment an approved revision took
effect: it marks it `effective`, supersedes the previous one, resolves recipients, sets the next review date and sends the reading
notices. A daily cron (`/internal/cron/settle-documents`, production only, as for quality-alert expiry) does the same for
organisations nobody opened that day. Until a revision is settled, the reading screens already show the revision in force.

## 7. API (`api/src/documents/`, all through `DatabaseService.asUser`)

- **Types:** `GET|POST /document-types`, `PATCH /document-types/{id}`.
- **Documents:** `GET /documents` (page-based register: `q` over number, title, text body and file names; `type`, `status`,
  `origin`, `owner=me`, `reviewOverdue`, `linkedTo` (part / machine / operation), `sort`, `order`, `page`, `pageSize`), `POST /documents`
  (with the first draft), `GET|PATCH /documents/{id}` (header: title, owner, restricted, review interval, links, targets, skills),
  `POST …/withdraw`, `GET …/history`.
- **Revisions:** `POST /documents/{id}/revisions` (start a draft, optionally from change requests), `GET|PATCH /document-revisions/{id}`
  (draft content: text body, change summary, acknowledge-by, reviewers and approver), `POST …/submit|discard|review|approve|send-back`,
  `GET|POST …/files`, `POST /document-files/{id}/delete|restore`, `GET …/compare?with=` (text: paragraph diff; file: which files changed).
- **Reading:** `GET /documents/mine` (to acknowledge, plus counts for the menu badge), `POST /document-revisions/{id}/acknowledge`,
  `GET …/recipients`, `POST …/recipients` (add a person later, audited).
- **Periodic review:** `POST /documents/{id}/periodic-review {outcome, note}`.
- **Change requests:** `GET|POST /document-change-requests`, `POST …/{id}/accept|decline|withdraw`.
- **Where work happens:** `GET /documents/in-force?partId|partFamilyId|machineId|operationCode`.
- **Controlled copies:** `GET /document-files/{id}/controlled-copy`, which stamps a PDF with `pdf-lib` in the API and streams it. Other
  types get a signed link and an "uncontrolled when printed" notice.
- **Dashboard:** `GET /documents-dashboard?from&to`.

Every command answers with the whole revision or document. The new routes are `@OrganisationScoped` and get sample bodies in the
tenancy sweep.

## 8. UI (`src/components/documents/`, hooks `useDocuments.js`, helpers `lib/documents.js`)

Menu **Documentation**: **Dashboard**, **Documents** (register), **My documents** (badge: to acknowledge plus reviews waiting on me),
**Change requests**, then the existing **My alerts** and **Quality alerts**.

- **Register** (`/Documentation/Documents`): the shared table pattern, saved filters (scope `document_register`), columns for number,
  title, type, revision in force, effective from, owner, next review, readers acknowledged, and status. **New document** dialog.
- **Document page** (`/Documentation/Documents/:id`): the revision in force (text rendered, or the file with **Download controlled copy**),
  a banner for a revision in progress, revisions with status, readers and progress, links, review history, change requests, and the
  history of changes.
- **Revision page** (`/Documentation/Documents/:id/revisions/:revisionId`): the **editor** for a text draft (§11 Q1) or the file drop, the
  change summary, reviewers and approver pickers, the **Submit** button with a "still needed" list, the review panel (accept / send back
  with comment) for a reviewer, approve with effective date for the approver, and **compare with the previous revision**.
- **My documents:** documents to acknowledge (overdue first), reviews and approvals waiting on me, and change requests I raised.
- **Where work happens:** `DocumentsInForce` on the job hub (a side pane like Alerts), part, part family and machine pages.
- **Settings → Data Management → Documents:** document types (prefix, interval, default kind, on/off).
- **Dashboard:** documents by status, reviews overdue, revisions waiting for review or approval and for how long, readers overdue,
  change requests open, and documents becoming effective soon.

## 9. Slices

| Slice | Content |
|---|---|
| **DC1** (done) | Types, documents and draft revisions (file and text kinds, editor), numbering, register, document page, revision page for drafts, files bucket. |
| **DC2** (done) | Review and approval rounds, effective date and supersession (settle on read and cron), frozen revisions, withdraw, discard, revision compare, notices to reviewers and approver. |
| **DC3** (done) | Readers: targets, recipients fixed at effect, acknowledge, My documents and badge, overdue, restricted access, reading notices, competence evidence link. |
| **DC4** | Periodic review (intervals, outcomes, overdue), change requests, links to parts, families, machines and operations, and "in force" panels on the job hub, part and machine pages. |
| **DC5** | External documents, controlled PDF copies, the dashboard. |
| **DC6** | Exit check: live guardrails, advisors, browser journey step (write → review → send back → approve → effective → acknowledge → revise), `docs/document-control-exit-report.md`, `CLAUDE.md`. |

## 10. Out of scope (stated so it is not assumed)

Editing Word files inside Fortress or converting them to PDF, electronic signatures with re-entered passwords (21 CFR Part 11), email
reminders, a public document portal for customers or suppliers, retention and destruction schedules, bulk import of documents (a later
integrations entity), documents that block work (CP3-style: information only), and translations.

## 11. Questions answered (2026-11-11)

| # | Decision |
|---|---|
| DC13 | **Text documents use TipTap** (a new frontend dependency): headings, lists, tables, bold and italic, and images uploaded into the document's bucket. The body is stored as TipTap JSON plus a sanitised HTML copy, which is the one rendered and compared. |
| DC14 | **Controlled copies are stamped on PDFs only.** Word, Excel and other files download unchanged, with an "Uncontrolled when printed or saved" notice on screen. Authors are advised to upload a PDF as the main file and attach the editable source. There is no server-side conversion. |
| DC15 | **The approver must differ only from the author.** A reviewer may also approve. |
| DC16 | **A restricted document opens only for its readers (DC4) and document managers.** There is no separate viewers list. |

Bringing existing documents across: a manager types the number and current revision letter for each document (DC3). A CSV import
belongs to a later integrations slice.

## 12. DC1 as built (2026-11-11)

Migration `20260202100000_document_control_core.sql` (applied live 2026-11-11); SQL test `supabase/tests/document_control_core.test.sql`; API `api/src/documents/` (e2e
`api/test/documents.e2e-spec.ts`, both sweeps); UI `src/components/documents/` and Settings → Data Management → Documents.

- **Document status** has a fourth value, `draft` = never yet in force (the plan listed active / withdrawn); a document whose only draft is discarded is
  `discarded`, and its number is kept and never reused.
- **Text bodies are stored as TipTap JSON only**, with a plain-text copy worked out by the database for search. There is **no stored HTML**: the body is
  shown through the editor's own schema, so nothing can be injected. This replaces "a sanitised HTML copy" in DC13; comparing revisions (DC2) works on the
  JSON. **Images inside the text are not built yet** (attach them as files); headings, lists, tables, bold, italic and links are.
- **Who reads a draft:** its author, the document's owner and `documentation.manage`. Reviewers and approvers are added in DC2.
- **The register** is a simple sortable table with search, type, content, owner and status filters; the shared table with column choice and saved filters
  comes with the reader columns in DC3.
- Files: one live main file per revision (a new one replaces the old, which is kept as removed with "Replaced by …"); the bucket allows 50 MB, the drop
  zone 25 MB as everywhere else.

## 13. DC2 as built (2026-11-11)

Migration `20260203100000_document_control_review.sql` (applied live 2026-11-11); SQL test `supabase/tests/document_control_review.test.sql`; API e2e `api/test/document-review.e2e-spec.ts`
(+ both sweeps, cron test); unit test `api/src/documents/document-compare.spec.ts`.

- Reviewers are kept in `document_revision_reviewers` and the approver on the revision; each submission starts a **round** of `document_signoffs`
  (one per reviewer, then the approver's once all accepted). A send-back closes the other pending sign-offs of the round.
- **Settling** (approved → effective, the previous one superseded) runs on every documents read (`app.settle_documents`), at approval when the date
  is today, and in the daily cron `/internal/cron/settle-documents` (00:15 UTC, production only). Settling on read is recorded in the audit trail
  as the person whose read caused it.
- **Comparing** is done in the API from the stored JSON (blocks of text by a longest-common-subsequence diff; files by the stored file), not from HTML.
- **Withdrawing** withdraws the revision in force and any approved one waiting; a draft in progress is left alone. A withdrawn document is revised
  back into use the normal way, and the document is active again when that revision takes effect.
- A new revision copies the text and the live file rows of the revision in force (or the last one issued), pointing at the same stored files.
- Notices: `document_signoffs.created` ("A document is waiting for you", addressed to the reviewer or approver, emailed by default like the other
  personal notices). Nobody is told when a revision is sent back or approved yet.
- The approver list offers members holding `documentation.issue` through any role; the check that counts is made again when they approve.

## 14. DC3 as built (2026-11-11)

Migration `20260204100000_document_control_readers.sql` (applied live 2026-11-11); SQL test `supabase/tests/document_control_readers.test.sql`; API e2e `api/test/document-readers.e2e-spec.ts`
(+ both sweeps).

- **Readers** (`document_targets`: departments, roles, named people) are kept on the document; `document_recipients` are fixed on each revision when
  it takes effect (inside `app.settle_document`), with how each was reached. An effective revision that reaches nobody is allowed.
- **The deadline is a number of days, not a date** (`document_revisions.acknowledge_within_days`, 1–365, set on the draft): the effective date is not
  known while drafting, so the due date is worked out as effective date + days and stored on each recipient. Someone added later gets today + days.
- **Opening the revision records the first view** (the API calls `app.mark_document_viewed` on every open; a no-op for anyone else). Acknowledging
  is the revision in force only, once, with an optional note.
- **Restricted** documents open only for the people they reach (targets now, or recipients of any revision) and document managers, plus the owner,
  authors and signers as before; hidden from the register, the revision page and storage for everyone else.
- **My documents** (`/Documentation/My-Documents`) and the badge: documents to acknowledge, overdue first, plus reviews waiting; the Documentation menu
  badge adds this to the alerts count.
- **Competence:** a document names the skills it trains; acknowledgements of such documents appear as "Documents read" on the person's competence
  record (evidence only), through `app.competence_document_evidence` (competence.read or the person themselves).
- The "a document for you to read" notice has **no actor**, so the person whose own read settled the revision is still told.
