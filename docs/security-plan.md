# Organisation security: network allowlisting and access rules — plan

**Status:** draft for agreement · **Date:** 2026-11-14 · **Source:** `fortress-ip-allowlisting-feature-brief.md` (uploaded) · **Brief:** `docs/design-brief.md` §5 (security), §14 (definition of done), §15 (non-goals)

## 1. Why

An organisation wants to say **where** Fortress may be used from (its sites, its VPN) and, alongside the two-factor requirement that already exists, **who** may use it. Today any member can reach the organisation's data from any network once signed in. This plan adds:
- a **Security** tab in Settings;
- **network allowlisting** (approved IP addresses and ranges), enforced on the server;
- a safe way to switch it on without locking everyone out, and a recovery path when that happens anyway.

It is network control, not device or identity control: it does not prove the device is the company's, and it does not replace SSO (out of scope, as the brief says).

## 2. What exists today (inspected)

| Area | Today | What it means for this plan |
|---|---|---|
| Sign-in | Supabase Auth; the API checks the JWT (`AuthGuard`) | Sign-in itself stays possible from anywhere; **data** access is what we restrict |
| Organisation context | `OrganisationGuard` (`api/src/tenancy/organisation.guard.ts`): `X-Organisation-Id` header, then one SQL query: `app.is_member`, the permission, and the two-factor block | The network check belongs **in that same query**: the organisation is already proven, no extra round trip, and no cache, so a change applies on the very next request |
| "Who" rules already in place | Roles and permissions, site scope, seats, **Require two-factor** (`organisation_settings.require_mfa`, enforced in the database, API answers `403 mfa_required`) | The two-factor switch moves into the new Security tab |
| Client address | `TRUST_PROXY_HOPS` (default 1 in production) sets Express `trust proxy`, so `req.ip` is the caller's address behind Vercel; the rate limit already uses it | The address source exists, but must be **confirmed on Vercel** before anything relies on it (SE0) |
| Data paths outside the API | The browser talks to **Supabase Storage directly**: `uploadFileToSupabase` / `generateSignedUrl` (`src/api/supabaseApi.js`), `AttachmentDrop`, logos and avatars (14 frontend files; 12 private buckets). It also reads `profiles` and memberships through PostgREST (`OrganisationProvider`, `UserProvider`) | **An API-only check leaves every file reachable from any network.** Decision S3 |
| Realtime / WebSockets | Not used (notifications are polled through the API) | Nothing to cover |
| Exports, reports, controlled copies, CMM files | All through the API | Covered by the guard |
| Emails | Notification emails carry the title and body | Mail is read on any network. Decision S9 |
| Audit | `audit.events` + `audit_changes` trigger; append-only | Configuration changes are audited the usual way |

## 3. Decisions to agree

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **S1** | **Where the rule is enforced** | (a) API guard only; (b) inside `app.is_member` for every query; (c) API guard plus the storage policies | **(c).** The check goes in `OrganisationGuard`'s existing query, so every organisation route is covered, and the tenancy sweep already fails when a route is not organisation-scoped. Putting it inside `app.is_member` (b) would also catch the worker, emails and system jobs, which act without a person's request; it would change the most-used function in the schema. Storage is covered separately (S3). |
| **S2** | **Where the client address comes from** | (a) `req.ip` with Express `trust proxy` = the number of proxy hops; (b) read `X-Forwarded-For` / `X-Real-IP` ourselves | **(a)**, after SE0 shows on the Vercel deployment that Vercel overwrites `X-Forwarded-For` and that a forged header from the browser does not change `req.ip`. IPv4-mapped IPv6 (`::ffff:203.0.113.10`) counts as IPv4. **No address, or an address we cannot read, is a denial while restrictions are enforced.** Each environment's proxy setting is written down (Vercel today; Cloudflare in front would need the origin locked so it cannot be reached directly). |
| **S3** | **Files in Supabase Storage** (direct from the browser today) | (a) storage policies read the client address from the request headers Supabase passes to Postgres; (b) upload and download links come from the API (which checks the network, then signs a short-lived link with the service key), and the storage policies refuse direct access for an organisation whose restrictions are enforced; (c) accept the gap | **(b).** We control it, and it does not depend on what Supabase forwards. The two helpers and `AttachmentDrop` change; the existing `app.*_file_allowed` rules are run as the person by the API before signing. Download links last 60 seconds, upload links one upload. A link already issued works anywhere until it expires, which is the documented limit. (a) stays possible later if SE0 shows a trustworthy address reaches storage policies. Avatars and the profile row are the person's own, not the organisation's, and stay as they are. |
| **S4** | **Modes** | (a) off / on; (b) off / **monitor** / enforce | **(b).** Monitor records who *would* have been blocked without blocking anyone. An administrator can run it for a few days, see the factory's second internet line or the VPN's address, add it, then enforce. This is the best protection against lockout. |
| **S5** | **Lockout prevention** | — | Enforcing (from off or monitor) needs **at least one active network** and **the administrator's own address, as the server sees it, inside one**. While enforced, any change that would put the person making it outside (deactivating, editing or removing their network) is refused with the reason. The page shows "Your address as Fortress sees it: …" with **Add this address**. Explicit confirmation before enforcing. |
| **S6** | **Recovery when everyone is locked out** | (a) a platform operator turns enforcement back to monitor after checking ownership, with a reason, audited, and every owner and admin is told; (b) an owner recovery code; (c) a public link | **(a).** A function callable only by a platform operator with an MFA session (`app.is_platform_admin()`, as for the operator panel). It needs a reason and a note of how ownership was verified, writes an audit event, and puts the policy into **monitor** (not off), so the allowlist is kept and nothing is silently opened for good. Every owner and admin gets an in-app notice and an email. No public endpoint and no standing bypass. Enabling enforcement emails the owners a short "what to do if you are locked out". |
| **S7** | **Who may manage it** | — | New permissions **`security.read` / `security.manage`**: owner and admin only (quality managers do not manage security), organisation-wide only. The two-factor switch moves under the same permissions; today it needs `organisation.manage`, held by the same roles. |
| **S8** | **Denied attempts** | — | `access_denials`: one row per organisation, person, address and hour, with a count, the last path, and whether it was a monitored or an enforced denial. Readable with `security.read`; kept 90 days (worker purge); never a token, body or query string. Shown on the Security tab as **Recent blocked attempts**. No notice per denial (it would flood); a daily digest line can come later. |
| **S9** | **Emails while enforced** | (a) unchanged; (b) emails for that organisation carry only "You have a new notification in Fortress — <organisation>" and the link | **(b).** Otherwise titles and descriptions land in inboxes read on home networks and phones. The link opens the app, which then applies the network rule. |
| **S10** | **Worker and system work** | — | Unaffected: reminders, workflow rules, scheduled scorecards and imports run without a person's request. What they produce is read through the API, so the rule applies when someone opens it. |
| **S11** | **"Who" rules in this plan** | (a) IP allowlisting only; (b) also allowed email domains for invitations and a maximum session age | **(b), as a later slice (SE6) once IP allowlisting is done.** *Allowed email domains:* invitations only to the company's domains; existing members outside are listed, not removed. *Maximum session age:* sign in again after N hours, using the sign-in time in the token's `amr` claim, checked in the same guard query (`401 reauthentication_required`). Both are small and use the same tab and guard. |
| **S12** | **Removing a network** | (a) hard delete; (b) removed with a reason, kept in the history | **(b)**, as everywhere else in Fortress ("nothing is deleted"). It is hidden from the list, the audit trail keeps it, and it can be brought back. |

## 4. Data model (sketch; tenant tables, RLS, audit, functions only)

- **`organisation_settings`** gains:
  - `network_policy` — `off | monitor | enforce`, default `off`;
  - `network_policy_changed_at` / `_by`.
- **`organisation_networks`:**
  - `name`;
  - `network` — Postgres **`cidr`**: native IPv4 and IPv6, normalised by the database, matched with `inet <<= cidr`;
  - `active`;
  - `removed_at` / `_by` / `removed_reason`;
  - created / updated by and at.
  - Audited, read with `security.read`, no table writes.
  - Checks:
    - a single address becomes `/32` or `/128`;
    - host bits set is refused with the network it probably meant (e.g. "198.51.100.5/28 — did you mean 198.51.100.0/28?");
    - `/0`, private, loopback, link-local and documentation ranges are refused, because the server only ever sees public addresses. The documentation ranges stay allowed only in the test fixtures, through a setting the tests switch on.
    - a wide range shows how many addresses it allows;
    - names are unique among active entries.
- **`access_denials`:**
  - organisation, user, address, hour bucket, count, mode, last path, first and last seen;
  - written only by an API-login function, deduplicated by an upsert;
  - read with `security.read`;
  - not audited (it is itself a log).
- **Functions** (all `security.manage` unless said):
  - `app.set_network_policy(org, mode, client_ip)` — refuses enforce without a match for `client_ip`;
  - `app.save_organisation_network(org, jsonb, id?, client_ip)`;
  - `app.set_organisation_network_active(id, active, client_ip)`;
  - `app.remove_organisation_network(id, reason, client_ip)` / `restore_…`;
  - `app.network_allowed(org, ip)` → `allowed | monitored_denial | denied` (used by the guard);
  - `app.system_record_access_denial(…)` — API login only;
  - `app.platform_recover_network_policy(org, reason, verification)` — operator only.
  - `client_ip` is passed in by the API from `req.ip`, never from the browser.
  - Errors **`QM029` → `409 security_rule`**.

## 5. API

- **Guard:**
  - `OrganisationGuard`'s query also returns `app.network_allowed(org, $ip)`;
  - `denied` → **`403 network_not_allowed`** (`details: { address }`, so the person can tell IT what to add), plus a denial row;
  - `monitored_denial` → passes, plus a monitored row.
  - Order as in the brief: token → membership → permission → network. A non-member still gets 404, so the network rule never confirms another tenant's existence.
- **`/me`:** each membership carries `network: { policy, allowed, address }`. The app can then show a clear screen for an organisation blocked on this network, without reading any of its data. `/me` itself returns no organisation data beyond names, as today.
- **Routes** (`security.read` / `.manage`; organisation-scoped; rate-limited like other writes):
  - `GET /security/access-policy` (mode, networks, the caller's address, whether it matches);
  - `PUT /security/access-policy {mode, confirm}`;
  - `POST /security/networks`;
  - `PATCH /security/networks/{id}`;
  - `POST /security/networks/{id}/remove {reason}|restore`;
  - `GET /security/access-denials?from&to&userId`.
- **Files (S3):**
  - `POST /files/upload-url {bucket, folderKind, recordId, fileName}` and `POST /files/download-url {bucket, path}` check the record's own file rule as the person, then the network, then sign;
  - the storage policies of the organisation buckets refuse direct `authenticated` access when the organisation's policy is `enforce`.
- **Operator:** `POST /platform/organisations/{id}/recover-network-policy {reason, verification}` (404 for non-operators, `403 mfa_required` without MFA).

## 6. Screens

- **Settings → Security** — a new menu item, shown with `security.read`, icon `ShieldCheck`:
  - **Two-factor authentication:** the existing switch, moved here from Organisation; Organisation keeps a one-line pointer.
  - **Access restrictions:**
    - Off / Monitor / Enforce as a `SlidingToggle`, with plain words on what each does;
    - "Your address as Fortress sees it";
    - the networks list (name, network, how many addresses, active switch, who changed it and when, "…" Edit / Remove);
    - **Add network** dialog (name, address or range, validation from the server, **Add this address**);
    - the **Enforce** confirmation dialog: who will be blocked (mobile data, home broadband unless on the VPN), what was blocked during monitoring, a typed confirmation.
  - **Recent blocked attempts:** person, address, when, how many times, monitored or enforced, with **Add this address as a network** for a manager.
  - Later (SE6): **Allowed email domains**, **Maximum session age**.
- **Blocked screen:** when `/me` says the current organisation is blocked on this network, the app shows "Access to <organisation> is not allowed from this network (your address: …). Connect through your company network or VPN, or ask an administrator." The organisation switcher still lists the organisation, marked as blocked. Any `403 network_not_allowed` from the API switches to this screen.
- **Operator panel:** on an organisation's row, **Recover access** (reason, how ownership was verified).

## 7. Slices

| Slice | What | Done when |
|---|---|---|
| **SE0** | Spike on the Vercel dev deployment: a temporary diagnostic route returns `req.ip`, the raw forwarding headers, and the result with a forged `X-Forwarded-For`. Also check what client address (if any) Supabase passes to Postgres for PostgREST and Storage requests. | The address source is confirmed and written into this plan; S2 / S3 confirmed or changed |
| **SE1** | Migration: permissions, `organisation_settings` columns, `organisation_networks`, `access_denials`, the functions, audit, guardrails list, tenancy sweep seeds. SQL tests: normalisation, refused ranges, IPv4 / IPv6 / mapped / boundaries, lockout rules, modes, tenant isolation | `db:check` green |
| **SE2** | API: guard check, `403 network_not_allowed`, denial rows, `/me` network state, management routes. E2e tests: allowed, denied, monitor, IPv6, CIDR edges, two organisations with different policies, an existing session blocked on the next request, a forged `X-Forwarded-For` ignored, no address → denied, lockout refusals, tenancy sweep | e2e green |
| **SE3** | Files: the upload-url and download-url routes; the two helpers, `AttachmentDrop`, logos and every direct storage call switched to them; storage policies refuse direct access when enforced. Tests for each bucket's rule through the new routes | No browser code signs or uploads organisation files directly |
| **SE4** | Screens: Security tab, two-factor moved, access restrictions, networks, enforce dialog, blocked attempts, blocked screen, switcher badge; emails reduced while enforced (S9) | Vitest green |
| **SE5** | Recovery: operator function, route and button; owner and admin notices and emails; the "if you are locked out" email when enforcing | Tested end to end |
| **SE6** | "Who" rules (S11): allowed email domains for invitations, maximum session age | Tested |
| **SX** | Exit check: live guardrails, advisors, a browser journey step (add a network, monitor, enforce from an allowed address, a request from another address blocked, recovery), the proxy set-up written down per environment, exit report | Report written |

## 8. Tests that make it safe

- **Database:** `inet <<= cidr` does the matching, so IPv4, IPv6, mapped and boundary cases are tested in SQL against the same function the guard calls.
- **Spoofing:** an e2e test sends a forged `X-Forwarded-For` with `trust proxy` set as in production, and the forged address must not be what is checked.
- **Coverage:** the tenancy sweep already lists every route. A new test fails if an organisation-scoped route is reachable from a denied address.
- **Files:** a test that direct storage access to an enforced organisation's bucket is refused.

## 9. Not in this plan

- SSO (Entra ID, SAML), device certificates, managed devices, country rules.
- Per-person or per-site allowlists (the policy is organisation-wide, as in the brief).
- Automatic discovery of company networks.
- A security dashboard beyond the blocked-attempts list.
- Restricting **sign-in** itself (Supabase Auth is shared by all organisations; the rule applies to the organisation's data).
- Revoking a signed file link already issued (it expires within 60 seconds).
