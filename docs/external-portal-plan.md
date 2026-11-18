# External portal (suppliers and customers) — plan

Status: **draft for agreement, nothing built.** Follows `docs/design-brief.md` and supersedes decision D5 of
`docs/supplier-quality-plan.md` (supplier portal "out of scope now"; response tables were kept portal-ready).

## 1. Decisions agreed (2026-11-18)

| # | Topic | Decision |
|---|---|---|
| X1 | Identity | **One account, many organisations.** An external person has one sign-in and a separate access row per organisation and party. |
| X2 | Visibility | **Hybrid.** SCARs (once issued) and tasks assigned to the party are automatic; NCs, 8Ds and documents are shared explicitly by staff. |
| X3 | Actions | **Respond and update.** Suppliers answer SCARs, upload evidence, complete tasks, acknowledge; customers can raise complaints and confirm closure. |
| X4 | Billing | **Free, unlimited.** External users never take a seat. |
| X5 | Shape | **Same app, own portal area** (own layout, menu and routes). No second domain. |
| X6 | Controls | Organisation owner switches the portal on (off by default), then **each supplier / customer is opted in separately** and their dashboard tiles chosen. |
| X7 | Invites | Staff with a new permission invite the first contact; that contact becomes the party's admin and invites or removes colleagues. |
| X8 | Security | The organisation's existing **require-MFA setting applies**, defaulting to on for external users. |
| X9 | Collaboration | **Comment threads** on each shared record, visible to both sides. Internal notes are separate and never shown. |
| X10 | Ranking and delivery | Ranking is opt-in, anonymised (a band, never names) and shown only with **at least 5 scored suppliers**. Customer delivery performance is **deferred** (no outbound shipment data exists). |
| X11 | What is shown | A **curated, live external view** per record type: a fixed field list, never internal fields. |
| X12 | Audit | Everything an external user does is audited under their name; staff see **viewed / last seen** on shared records. |
| X13 | Cross-tenant | Design for it (reserve a nullable link to another organisation on the party row); **build nothing** for it. |
| X14 | Order | Suppliers first, customers second. |

## 2. Design principles

1. **External users are never members.** `app.is_member` stays false for them, so every existing RLS rule and
   function already refuses them. Nothing existing is widened to let them in.
2. **Portal reads and writes are narrow SECURITY DEFINER functions** that return the curated fields and check
   `app.portal_access(org, kind, party)` themselves. No portal route reads a table under RLS.
3. **Internal-only data cannot leak by omission:** each record type has one explicit external projection
   (a function returning named columns). Adding a column to a table does not add it to the portal.
4. **Own guard.** `PortalGuard` (not `OrganisationGuard`): resolves the person, the party and the access row, checks
   status, MFA and session age. It does **not** apply the organisation's IP allow-list or "SSO required" mode to
   external users (they sit outside the company network); the organisation can still suspend a party at once.
5. Every write goes through a function that stamps the external person, so the audit trail names them.

## 3. Data model (sketch)

- `external_access` — (organisation, party kind `supplier|customer`, party id, user id, role `admin|member`,
  status invited / active / suspended / removed, invited by, last sign-in, optional per-user tile limits).
  Unique per organisation, party and user. Functions only, audited.
- `organisation_settings.portal_enabled` (default false) and `portal_ranking_enabled`; per party
  `portal_enabled`, `portal_tiles jsonb`, and a **reserved nullable `linked_organisation_id`** (X13, unused).
- `portal_shares` — record kind (`ncr`, `capa`, `document`), record id, party, shared by/at, withdrawn with reason.
  Withdrawing hides the record at once; nothing is deleted.
- `portal_comments` — record kind and id, party, author (staff or external), body, created at. Visible to both.
- `portal_views` — first and last view per record and external person (for staff "viewed").
- Responses reuse existing frozen tables where they exist (`supplier_scar_responses`, evidence files), written
  through the same functions with an external author column; SCAR and NC rows never gain internal fields in
  those response tables (D5 already required this).
- Tasks: external assignees via a portal task view over SCAR actions and 8D actions already assigned to an
  external team member / contact; no new task system.

## 4. API and screens

- `api/src/portal/`: `GET /portal/me` (organisations and parties the person can act for), `GET /portal/{org}/…`
  home, SCARs, NCs, 8Ds, tasks, documents, scorecard, `POST` for responses, comments, acknowledgements, uploads.
  Files go through the existing `/files` signed-link route with a portal rule.
- Frontend: `src/components/portal/` — portal layout, organisation switcher, menu (Home, To do, Corrective
  actions, Non-conformances, 8Ds, Documents, Performance), supplier home and scorecard tiles, comment thread.
- Staff side: Settings → External access (switch, per-party opt-in, tiles, ranking, users per party, access
  report), a **Share with supplier / customer** control on NC, 8D and document pages, "viewed" marker.
- Email: portal notices addressed to the external person ("A SCAR needs your response", "New comment"), using
  the existing outbox, extended to people who are not members.

## 5. Risks to design out

- **Leak through reuse:** any function that checks `has_permission` could be called by an external. External
  users hold no role, so `has_permission` is false; a test lists every callable function and proves an external
  account gets nothing (extends the tenancy sweep).
- **Seat and network rules:** `seat_blocked_organisations`, network policy and SSO-required must be **skipped for
  external access only**, never for members. Needs explicit tests both ways.
- **Account takeover of a supplier contact:** MFA default on, invitation expiry, removal of leavers by the party
  admin, access report for staff.
- **Over-sharing:** projections are fixed; sharing is staff-initiated; a share can be withdrawn instantly.
- **Ranking inference:** band only, minimum five, never shown to a party with fewer comparators.

## 6. Slices

| Slice | Content | Exit |
|---|---|---|
| **PT0** | Threat model, final field lists per projection, wireframes of the supplier home. | Agreed in this file. |
| **PT1** (built; migration not yet applied live) | Foundation: settings, `external_access`, invite and accept (reusing the invitation mailer), `PortalGuard`, `/portal/me`, portal layout and organisation switcher, audit, access report, sweep tests that externals reach nothing else. | An invited supplier contact signs in and sees an empty portal; staff cannot be impersonated; both guardrail sweeps pass. |
| **PT2** (built; migration not yet applied live) | Sharing and conversation: `portal_shares`, comments, viewed tracking, email to external people, Share control on NC and 8D. **Moved to PT3:** documents (they come with acknowledgements), files on a shared record (they need the portal file rule), notices to staff when a party replies. | Staff share an NC; the supplier sees the curated view, comments, staff see "viewed". |
| **PT3** (PT3a built: SCARs; PT3b built: evidence files on a response; PT3c built: documents and quality alerts shared and acknowledged; PT3d built: actions staff set on a SCAR, completed by the supplier — see CLAUDE.md) | Supplier action: SCAR list and response (root cause, containment, corrective action, evidence upload), extension requests, tasks assigned to them, acknowledgements of documents and quality alerts. | A supplier answers a SCAR end to end; internal review works unchanged. |
| **PT4** | Supplier performance: their scorecard, open items, trend, optional anonymised ranking band; staff choose tiles per supplier. **Built** (see CLAUDE.md). | Scorecard equals the internal Performance tab (same database function). |
| **PT5** | Customer side: complaints and 8Ds shared with them, containment and closure confirmation, quality KPIs for their parts, inspection and certificate evidence, raising a complaint. | A customer raises a complaint that becomes a draft NC. **PT5a built** (complaints → draft NC); **PT5b built** (closure confirmation); **PT5c–PT5f built** (customer contacts, quality figures — PPM shipped and first-pass yield deliberately not built, no shipment data —, files on a complaint, certificates and reports from a lot). |
| **PT6** | The portal looks and works like the main app: side menu per kind of party, a dashboard as the default page, and registers (non-conformances, corrective actions for suppliers, 8D reports for customers, documents and alerts) with search, filters, columns and CSV. | **Built** (migration `20260411100000_portal_registers.sql`). Sharing stays the gate; the registers list only what staff have shared. Not browser-checked. |
| **PTX** | Exit check: live guardrails, advisors, journey step (invite, MFA, respond, comment, withdraw share), exit report. | As other modules. |

Out of scope (later): cross-tenant linking (X13), customer delivery performance (X10), self-registration,
company SSO for external users, a general inbox.

## 7. Open points — settled (2026-11-18)

| # | Point | Decision |
|---|---|---|
| X15 | External fields | **Facts plus containment and disposition.** A shared NC shows: reference, title, description, part and revision, quantity affected, lot, detected date, severity, status, requirement and actual result, shared files, comments, **containment actions** (kind, description, status, result) and the **approved disposition** (decision, quantity, instructions, reference/RMA). Never: costs, internal notes, owner and employee names, other parties, root-cause and investigation work, proposed (unapproved) dispositions. SCAR and 8D projections follow the same rule: what was asked of the party and what they answered, never internal reviews' working notes. Exact lists are fixed in PT0 per record type, as functions returning named columns. |
| X16 | Party admin view | The party's admin manages access **and sees an activity list of their own people** (responses, comments, uploads, acknowledgements, sign-ins). Staff see the same list per party. |
| X17 | Customer contacts | **Add `customer_contacts`** in the shape of `supplier_contacts` (several per customer, one primary, deactivated never deleted). Done in PT5 so suppliers are not delayed; portal access rows for customers link to a contact. |
| X18 | Retention | Everything an external user wrote **stays, under their name, marked "former contact"** once removed. The audit trail keeps the account id. |

## 8. PT0 — threat model, projections and wireframe (2026-11-18)

### 8.1 Threat model

| # | Threat | Control (and the test that proves it) |
|---|---|---|
| T1 | An external user reads a table directly (Supabase client, REST) | They hold no membership, no role and no seat, so `app.is_member` is false and every RLS policy refuses. **SQL test:** an external account selects from every tenant table and gets zero rows; the tenancy sweep gains an "external" caller. |
| T2 | An external user calls an internal API route | `OrganisationGuard` refuses a non-member (404/403); portal routes live under `/portal` only and use `PortalGuard`. **API sweep:** every non-`/portal` route answers an external token with 403/404. |
| T3 | A portal function leaks an internal column | One projection function per record type returns named columns; no `select *`, no `to_jsonb(row)`. **Drift test:** the function's column list must equal the list in §8.2 (a new column on the table changes nothing). |
| T4 | Reading another party's data in the same organisation | Every portal function takes the party from the access row, never from the request, and filters on it. **Test:** supplier A's contact asks for supplier B's SCAR by id → 404. |
| T5 | Reading another organisation's data | The access row is per organisation; the guard resolves it from `X-Organisation-Id` and the person. **Test:** a contact of org 1 using org 2's id → 404. |
| T6 | A share that was withdrawn still readable | The projection joins `portal_shares` on `withdrawn_at is null` on every call; files use short signed links (5 min) issued per request. **Test:** withdraw, then read and download → 404. |
| T7 | Files: reading or overwriting other files | Portal uploads only into a folder named for the response / comment being written (`app.portal_file_allowed`); downloads only for files attached to a visible record. Staff files marked internal are never listed. |
| T8 | Stolen or shared supplier login | MFA on by default (X8), invitation expiry (7 days), party admin can remove at once, session age setting applies, staff see last sign-in per person. |
| T9 | Leaver keeps access | Access report with "last sign-in"; party admin and staff can remove; removal ends the access row immediately and is audited. |
| T10 | Abuse: spam comments, huge uploads, scraping | Rate limit per external person (stricter than staff), comment ≤ 4,000 characters, file size and type limits as for staff, per-person daily upload cap. |
| T11 | Existing security rules wrongly applied or wrongly skipped | Network allow-list, SSO-required and seat checks are skipped **only** on `/portal`, never for members. **Tests both ways:** a member outside the allow-list is still blocked; an external contact outside it is allowed. |
| T12 | A staff-only internal note shown by mistake | Internal notes live in different tables from `portal_comments`; the comment function accepts no table name. |
| T13 | Impersonation of staff in comments | Every portal comment shows the party's name and "(supplier)" badge; staff comments show the organisation's name, never a personal profile photo of staff. |
| T14 | Audit gap | Every portal write function sets the acting external user; the audit trigger records them with their account id (X12). **Test:** each portal write produces an `audit.events` row naming the external user. |

### 8.2 Projections (what the external person sees)

Common rule: only records **of their party**, live, `deleted_at is null`, not draft. Staff names are never returned; the organisation's own name is.

**Non-conformance** (shared NC; supplier NCs have `supplier_id` = the party, customer NCs `customer_id` = the party)
- Shown: `reference`, `title`, `description`, `requirement`, `actual_result`, `severity`, `stage` (in words), `detected_at`, `quantity_affected`, `quantity_inspected`, part number and name, revision label, `lot_number`, `serial_number`, `purchase_order`, `customer_reference` (customer NCs), shared files, comments.
- **Containment actions:** kind, description, due date, status, quantity contained, result note once done (not owner).
- **Disposition:** approved dispositions only: decision, quantity, instructions, reference / RMA. Proposed or cancelled ones never.
- Hidden: costs, `site`, `work_order`, internal notes, history, owner / detected-by / responsible people, root-cause and investigation fields, categories, 8D links, other parties, custom fields (unless marked "share with external" later).

**SCAR** (automatic once issued)
- Shown: reference, title, problem description, requirement breached, objective evidence, containment requirements, severity, status (in words), due date (and original if extended), affected items, linked shared NC references, our contact's **organisation role name** ("Supplier quality"), responses they wrote, our review outcome and note per response (accepted / revision requested + the note we wrote for them), implementation and verification outcome, extension requests and decisions.
- Hidden: internal owner, status history, internal links to an 8D, who reviewed, anything in `supplier_scar_status_history`.

**8D** (shared explicitly; customers mainly)
- Shown: reference, title, severity, stage, problem statement, D2 (what, where, when, how many, how, who as written), D3 containment actions, D4 **verified** root causes (occurrence and escape, words only), D5 corrective actions, D6 verification result and date, D7 preventive actions and lessons learned, D8 closure date, shared files, the printable 8D report.
- Hidden: team members (shown as "8D team" count only), analysis workings (Ishikawa / 5 whys / Is-Is-Not), unverified causes, internal notes, owner.

**Task** (automatic): SCAR actions, 8D actions and acknowledgements assigned to the party's external contact — description, due date, status, the record it belongs to; completing writes findings (as the internal actionee flow does).

**Documents / quality alerts** (shared explicitly): number, title, revision, effective date, the controlled copy (PDF stamped for them); acknowledge once.

**Performance (supplier)** — the same figures as the Performance tab, from `app.supplier_performance` (T3 applies: one function, named outputs): on-time %, in-full %, PPM (both measures), lot rejection %, NC counts by severity, SCAR on-time %, certification status, overall score and band, the period trend, and the optional ranking **band** (X10). Hidden: other suppliers, the scoring weights' internals are shown as a short "how this is scored" text only if the organisation switches it on.

**Performance (customer)**: NCs and 8Ds for their parts (counts, ageing, closure time), PPM and first-pass yield for parts supplied to them, inspection and certificate-of-conformance evidence they were shared. Delivery performance is deferred (X10).

### 8.3 Wireframe — supplier home

```
┌ Fortress ▸ [Acme Aerospace ▾]            Colin Ward ▾ ┐   ← organisation switcher (X1)
│ Home │ To do (3) │ Corrective actions │ Non-conformances │ Documents │ Performance │
├────────────────────────────────────────────────────────┤
│  Needs your attention                                  │
│  ┌ 3 to do ───────────┐ ┌ 1 overdue ───┐ ┌ 2 new ─────┐│
│  │ SCAR-26-0007 answer │ │ SCAR-26-0004 │ │ shared NCs ││
│  │ due 21 Nov          │ │ 4 days late  │ │            ││
│  └─────────────────────┘ └──────────────┘ └────────────┘│
│  Your score (last 90 days)          [ 82  Good ]       │
│  On time 94% ▮▮▮▮▮▮▮▮▮▯   In full 98%   PPM 410         │
│  Trend ▁▂▃▃▄▅▅▆ (monthly)      Position: top half*     │
│  Open items                                             │
│  SCARs  2 awaiting you · 1 under review · 3 closed      │
│  NCs    4 open (1 major) · oldest 12 days               │
│  Recent comments from <Organisation>                    │
└────────────────────────────────────────────────────────┘
* only when ranking is on and ≥ 5 suppliers are scored
```
SCAR page: header (reference, status steps, due date), the request, **Our response** form (root cause, containment, corrective action, preventive action, planned completion, files), reviews of earlier responses, comments, history in words. Customer home (PT5): complaints and 8Ds in progress, closure confirmations waiting, quality figures for their parts.

### 8.4 PT0 open points (defaults accepted 2026-11-18)

1. **Our contact:** show the NC / SCAR / 8D owner's display name to the external party (people like to know who to talk to)? *Proposal:* show a single organisation-chosen "contact name" per party (set when sharing, defaulting to the sharer), not the owner.
2. **Custom fields** on shared NCs: *Proposal:* a per-field switch "Show to suppliers/customers" in Settings → Custom fields, off by default; deferred to after PT2 if needed.
3. **Comment mentions / edits:** *Proposal:* no mentions; a comment can be withdrawn by its author within 10 minutes, otherwise permanent (audit stays).
