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
| **PT1** | Foundation: settings, `external_access`, invite and accept (reusing the invitation mailer), `PortalGuard`, `/portal/me`, portal layout and organisation switcher, audit, access report, sweep tests that externals reach nothing else. | An invited supplier contact signs in and sees an empty portal; staff cannot be impersonated; both guardrail sweeps pass. |
| **PT2** | Sharing and conversation: `portal_shares`, comments, viewed tracking, notices and email to external people, Share control on NC, 8D, document. | Staff share an NC; the supplier sees the curated view, comments, staff see "viewed". |
| **PT3** | Supplier action: SCAR list and response (root cause, containment, corrective action, evidence upload), extension requests, tasks assigned to them, acknowledgements of documents and quality alerts. | A supplier answers a SCAR end to end; internal review works unchanged. |
| **PT4** | Supplier performance: their scorecard, open items, trend, optional anonymised ranking band; staff choose tiles per supplier. | Scorecard equals the internal Performance tab (same database function). |
| **PT5** | Customer side: complaints and 8Ds shared with them, containment and closure confirmation, quality KPIs for their parts, inspection and certificate evidence, raising a complaint. | A customer raises a complaint that becomes a draft NC. |
| **PTX** | Exit check: live guardrails, advisors, journey step (invite, MFA, respond, comment, withdraw share), exit report. | As other modules. |

Out of scope (later): cross-tenant linking (X13), customer delivery performance (X10), self-registration,
company SSO for external users, a general inbox.

## 7. Open points to settle before PT1

1. Exact external field list for an NC, 8D and SCAR (PT0).
2. Whether a supplier admin can see other contacts' activity, or only manage them.
3. Customers: does `customers` need a contacts table like `supplier_contacts`?
4. Retention: how long a removed external user's comments and responses stay attributed (proposal: forever, name kept).
