# Organisation security: network allowlisting and access rules — plan

**Status:** agreed 2026-11-14 (S1–S12 as recommended) · **SE0 done** · **SE1 done** (migration `20260228100000_organisation_security.sql`, applied live 2026-11-14, live guardrails 0 violations) · **SE2 done** (API, no migration) · **SE3 done** (migration `20260301100000_storage_through_api.sql`, applied live 2026-11-14) · **SE4 done** (migration `20260302100000_network_restricted_emails.sql`, applied live 2026-11-14) · **SE5 done** (migration `20260303100000_network_policy_recovery.sql`, applied live 2026-11-14) · **SE6 done** (migration `20260304100000_security_who_rules.sql`, applied live 2026-11-14) · **SX done** (exit check, `docs/security-exit-report.md`) · **Date:** 2026-11-14 · **Source:** `fortress-ip-allowlisting-feature-brief.md` (uploaded) · **Brief:** `docs/design-brief.md` §5 (security), §14 (definition of done), §15 (non-goals)

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

## 9. SE0 result (2026-11-14, Vercel dev deployment)

`GET /api/v1/health/network` (temporary, public; removed in SE2) was called from outside, once plainly and then with every forwarding header forged (`X-Forwarded-For: 6.6.6.6`, `6.6.6.6, 7.7.7.7`, `X-Real-IP`, `Forwarded: for=6.6.6.6`, `X-Vercel-Forwarded-For`).

**Vercel replaces all of them.** Whatever the caller sends, the function receives `x-forwarded-for`, `x-real-ip` and `x-vercel-forwarded-for` set to the caller's real address. It also receives a signed `forwarded` header with the same address. The connection itself comes from `127.0.0.1` (Vercel's local runtime). So with `trust proxy` = 1 (`TRUST_PROXY_HOPS` default in production), `req.ip` is the caller's real address, and a forged header never reaches it. In every call `address` = `reqIp` = the real address, and the forged 6.6.6.6 appeared nowhere. **S2 is confirmed as planned.**

- **Different addresses on successive calls.** The three calls came from three addresses in one /24 (`160.79.106.x`), because the network they were made from leaves through a pool of addresses. Customers behind such a pool (many corporate firewalls and VPNs) must allow the **range**, not one address. The Add network dialog and the monitor mode (S4) are what make this easy to get right.
- **Per environment.** Vercel (dev, and production when it exists): `TRUST_PROXY_HOPS` = 1, the default for `NODE_ENV=production`. Local and tests: 0 (headers ignored). If a CDN or proxy is ever put in front of Vercel, the hop count changes and the origin must refuse direct traffic. Re-run this check after any such change.
- **Not checked.** IPv6 (the calls were IPv4; the code and the e2e test handle IPv6). What Supabase passes to Postgres for direct PostgREST / Storage calls: not needed, because S3 (b) moves file links behind the API.
- **Tests:** `client-address.spec.ts`, `api/test/client-address.e2e-spec.ts` (one trusted hop takes the last address and ignores what was forged in front of it; no trusted hop ignores the headers).

## 10. SE1 as built (migration `20260228100000_organisation_security.sql`)

- **Permissions** `security.read` / `security.manage`: owner and admin.
- **`organisation_settings`:** `network_policy` (off | monitor | enforce, default off), `network_policy_changed_at` / `_by`. There is no column UPDATE grant, so only `app.set_network_policy` changes it. It is audited with the settings row.
- **`organisation_networks`:**
  - name, `network` (Postgres `cidr`), active, `removed_at` / `_by` / `removed_reason`, created / updated stamps;
  - name and network unique among live entries, at most 100 per organisation;
  - audited, RLS `security.read`, no table writes, never deleted.
  - Removing needs a reason (3+ characters). A restored entry comes back **switched off**, so restoring never widens access by itself.
- **Reading an entry** (`app.parse_network`):
  - trimmed; a single address becomes `/32` or `/128`; an IPv4 address written as IPv6 becomes IPv4;
  - host bits set are refused with the network meant ("198.51.100.5/28 has bits set after the /28: did you mean 198.51.100.0/28?");
  - refused (`app.network_problem`): wider than /8 (IPv4) or /16 (IPv6); private, loopback, link-local, carrier-grade NAT, multicast, reserved and unspecified ranges, which a server never sees as a caller.
  - **Documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`) are allowed**, so tests and examples can use them. This changes the sketch in §4, which had them allowed only in tests.
- **`app.network_allowed(org, address)`** → `open` (off) | `allowed` | `monitored` (monitor mode, outside every network) | `denied` (enforced, outside every network, or no address). It returns NULL for anyone who is not a member, so it never reveals another tenant's policy. IPv4 written as IPv6 matches its IPv4 network (`app.plain_address`).
- **Lockout prevention** (`app.set_network_policy`, `save_ / remove_organisation_network`; the caller's address is passed in by the API):
  - enforce needs an active network and the caller's address inside one;
  - while enforced, switching off, moving or removing the network that covers the caller is refused, unless another active network covers them;
  - off and monitor can always be chosen.
- **`access_denials`:** one row per organisation, person, address, mode and hour, counting attempts.
  - The last path is kept without its query string; an unreadable address is `unknown`.
  - Written only by `app.system_record_access_denial` (API login); read with `security.read`; cleared after 90 days by `app.system_purge_access_denials` (API login; the worker step comes in SE2).
- Errors `QM029` (→ `409 security_rule` in SE2), another organisation `P0002`.
- Tests: `supabase/tests/organisation_security.test.sql`, tenancy sweep seeds and assertions, guardrails audit list.

## 11. SE2 as built (API, no migration)

- **Request context:** `RequestContext.address` = `clientAddress(req.ip)` (`api/src/security/client-address.ts`), set in `contextFrom` for every authenticated request.
- **Guard** (`OrganisationGuard`):
  - its one query also returns `app.network_allowed(org, address)`;
  - **the network is checked right after membership, before the permission**, so a blocked person is told about the network, not about a missing permission;
  - `denied` → `403 network_not_allowed` with `details.address` and the message "This organisation does not allow access from your network…";
  - `denied` and `monitored` both write an `access_denials` row on the API login (`recordDenial`; a failure to record is logged and never changes the answer);
  - non-members still get 404. No cache, so a change applies on the next request.
- **Routes** (`api/src/security/`):
  - `GET /security/access-policy` (`security.read`) → mode, changed at / by, `canManage`, the caller's `address`, `covered`, `activeCount`, `networks`. Each network carries `count` ("16 addresses"), `single`, `includesYou`, removed, and who / when.
  - `PUT /security/access-policy {mode, confirm}` — enforce needs `confirm: true` (400 `confirmation_required`).
  - `POST /security/networks {name, network, active?}`, `PATCH /security/networks/{id}`, `POST …/{id}/remove {reason}|restore` (`security.manage`); each answers with the whole policy.
  - `GET /security/access-denials?from&to&userId&mode&limit` (`security.read`) → person, address, mode, attempts, last path, first / last seen, `nowAllowed` (a network covers it now).
  - Errors `QM029` → `409 security_rule`.
- **`/me`:** each membership carries `network: { state: open | allowed | monitored | denied, address }`, so the app can show the blocked screen (SE4) without touching the organisation's data.
- **Worker:** a `housekeeping` step clears blocked attempts older than 90 days (`app.system_purge_access_denials`).
- **The SE0 diagnostic route `GET /health/network` is removed.**
- **Tests:** `api/test/security.e2e-spec.ts` covers:
  - the address the API checks: one trusted hop takes the proxy's address and ignores a forged one in front; no hop ignores the headers; IPv6;
  - rights and refused ranges;
  - monitor (nobody blocked, attempt recorded);
  - enforce: needs confirmation and your own address;
  - blocked from outside, with the address in the reply; inside allowed; CIDR edges; IPv6; IPv4 written as IPv6; a write blocked too;
  - a forged address in front of the proxy's ignored;
  - the same session blocked after moving networks;
  - a person in two organisations still uses the other one, and `/me` says which is blocked;
  - a non-member still gets 404;
  - lockout refusals;
  - blocked attempts counted;
  - off opens again.
  - Also: tenancy sweep sample bodies, the worker step list.
- **Not covered yet:** emails while enforced (SE4). Files: SE3, below.

## 12. SE3 as built (migration `20260301100000_storage_through_api.sql`)

- **One rule per bucket.** `app.storage_file_allowed(bucket, name, write)` states who may read or add a file in each of the eleven organisation buckets (audit, calibration, CAPA, competence, document, inspection, integration, NC, quality alert, supplier files and logos). The expressions are the ones the policies had. **The storage policies now call it, and so does the API before it signs**, so the two cannot disagree.
- **Direct access refused while enforced.** Every organisation bucket's policies (insert and select; logos also update and delete) add `app.storage_direct_allowed(name)`. It is false when the organisation in the path's first segment enforces its network policy, **unless the request comes from the API's own login** (`session_user = 'qms_api'`). A browser cannot be that login: PostgREST and Storage connect as their own roles. So the API's existing checks that an upload arrived (`select 1 from storage.objects …` as the person) keep working.
- **Avatars** (`users/<user id>/…`) are the person's own and are left as they were, in the browser.
- **API** (`api/src/files/`; any member; the guard checks membership and the network first):
  - `POST /files/upload-url {bucket, path}` → `{ token, signedUrl }`. The path must be in the organisation's folder (`pathProblem`: no empty, `.` or `..` segments, no backslash or control characters, at least three segments), and the rule must allow adding. A Supabase signed upload is for that one path, refuses an existing object and lasts two hours.
  - `POST /files/download-url {bucket, path, expiresIn?, downloadName?}` → `{ url, expiresIn, expiresAt }`. The default is ten minutes and the maximum an hour. **While the organisation enforces, the maximum is five minutes.** A missing file answers 404 `file_not_found`.
  - `POST /files/remove {bucket: 'org-logos', path}`: a replaced or cleared logo (`organisation.manage`).
  - Refusals: `403 file_not_allowed`, `400 invalid_path`. Without `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` the answer is `503 file_storage_unavailable`. Signing is done by `FileLinkSigner` (`SupabaseFileLinkSigner`, with the service key; tests use a fake).
- **Browser:**
  - `src/api/supabaseApi.js`: `uploadFileToSupabase`, `uploadToPath`, `generateSignedUrl` (the organisation is the path's first segment) and `removeOrganisationFile` ask the API, then upload with `uploadToSignedUrl`.
  - The organisation logo hooks use them.
  - Cached links are kept for four minutes.
  - `src/api/supabaseApi.test.js` fails if any file other than the helper and the two avatar files calls `supabase.storage.from`.
- **Tests:**
  - `supabase/tests/storage_through_api.test.sql`: every policy uses the shared rule; direct reads, uploads and deletes are refused while enforced, avatars are not; the API login passes.
  - `api/test/files.e2e-spec.ts`: rule, paths, other organisation, read-only person, network, five-minute cap, logo removal, the arrival check while enforced, 503.
  - The journey's stand-in storage now takes signed uploads.
- **Limit (documented):** a link already issued works from anywhere until it expires: at most five minutes while enforced.

## 13. SE4 as built (migration `20260302100000_network_restricted_emails.sql`)

- **Settings → Security** (`Settings/SettingsSecurity.jsx`, menu item with `security.read`, icon `ShieldCheck`; hooks `src/hooks/useSecurity.js`; words `src/lib/security.js`):
  - **Two-factor authentication:** the switch moved here from Organisation, which now keeps a one-line pointer. The API still needs `organisation.manage` to change it; owners and admins hold both.
  - **Access restrictions:**
    - Off / Monitor / Enforce as a `SlidingToggle` (radio), each explained in plain words. Off and monitor save at once (optimistic).
    - **Enforce** opens a dialog: who will be blocked, how many people or addresses were outside during monitoring, what still stops it (`enforceProblems`: a network switched on, your own address inside one), and the word "enforce" typed to confirm.
    - "Your address as Fortress sees it", with **Add this address** when it is outside every network.
    - The approved networks: name, range, how many addresses, "Includes you", who changed it last, an active switch (optimistic, put back if the lockout rule refuses), and "…" Edit / Remove (with a reason). Removed networks are folded away, with **Bring back**.
    - The network dialog shows the server's message (for example "did you mean 203.0.113.0/24?").
  - **Recent blocked attempts:** who, from where, how often, when, blocked or would-be-blocked, "Now allowed", and **Add this address** for a manager.
- **Blocked screen** (`NetworkBlocked.jsx`): shown in place of the whole app, Settings included, when `/me` says the organisation denies this network. It is also shown straight away when any request answers `403 network_not_allowed`: `apiFetch` raises the `qms:network-blocked` window event and `App.jsx` listens. It shows the address, what to do, **Try again** (re-reads `/me`) and a switch to another organisation. Monitor blocks nobody.
- **Switcher:** an organisation denied on this network reads "<name> (not available on this network)".
- **Emails while enforced (S9):**
  - `app.system_lease_emails` now returns `network_restricted`.
  - For those organisations, `renderNotificationEmail` sends only "You have a new notification in Fortress — <organisation>", a line asking to open it from the company network or VPN, and the link. No title or description.
- **Tests:**
  - `SettingsSecurity.test.jsx`.
  - Blocked-screen cases in `App.test.jsx`.
  - `OrganisationSwitcher.test.jsx`.
  - The event in `api-client.test.js`.
  - Restricted email in `email.spec.ts`.
  - The lease column in `email_notifications.test.sql`.

## 14. SE5 as built (migration `20260303100000_network_policy_recovery.sql`)

- **History of every change.** `network_policy_changes` (functions-free: written only by trigger `organisation_settings_network_policy_history` when `network_policy` changes; frozen even for SQL; audited; read with `security.read`):
  - kind `change` or `recovery`, from and to, who (and their name at the time);
  - for a recovery, the operator's reason and how ownership was verified;
  - a one-line summary and what to do next.
- **Recovery (S6).** `app.platform_recover_network_policy(org, reason, verification)`:
  - Only a platform operator: on the allow-list and with an MFA session (`app.is_platform_admin()`).
  - Only while the organisation **enforces**. It goes back to **monitor**, never off, and the approved networks are kept.
  - Reason and verification are each 10 to 1000 characters.
  - The audit trail shows the operator as the actor.
  - API: `POST /platform/organisations/{id}/recover-network-policy {reason, verification}`. It answers 404 to someone who is not an operator, `403 mfa_required` without MFA, `409 security_rule` when the organisation is not enforcing, and 404 for an unknown organisation. It is on the tenancy sweep's reviewed allowlist, since it spans organisations by design.
  - The operator panel's organisations list shows each organisation's policy (`app.platform_network_policies`, admin-only), with **Recover access** on enforcing ones. The dialog asks why and how ownership was verified.
- **Owners and admins are told.**
  - New event `network_policy_changes.created`: group Security, `security.read`, on by default, emailed by default.
  - The notice has **no actor**, so the person who enforced is told too. Its body says what changed and, when enforced, "If everyone is locked out, an owner can ask Fortress support to put restrictions back to monitor".
  - `app.emit_notification` is the `20260221100000` version plus this table in the no-actor list. That is now the latest definition.
  - `app.system_lease_emails` sends these notices **in full even while enforced**, so the lockout guidance reaches the inbox. They hold no quality data.
  - The notice links to `/Settings/Security`, in both `notificationLink` and the email's `notificationPath`.
- **Settings → Security** shows **Changes**: the latest 20, with a recovery's reason and how ownership was verified (`history` on `GET /security/access-policy`).
- **Tests:**
  - `supabase/tests/network_policy_recovery.test.sql`, plus the sweep seed and the guardrails list.
  - `api/test/network-recovery.e2e-spec.ts`: locked out, the operator panel, who may recover, the policy back to monitor, the owner back in, history, notices.
  - `PlatformPanels.test.jsx`, `SettingsSecurity.test.jsx`, `notifications.test.js`, `email.spec.ts`.

## 15. SE6 as built (migration `20260304100000_security_who_rules.sql`)

- **Allowed email domains (S11):**
  - Set with `organisation_settings.allowed_email_domains` (≤ 20). The only writer is `app.set_allowed_email_domains(org, domains[])` (`security.manage`); `app.normalise_email_domain` lowercases, strips a leading "@" and refuses anything that is not a domain, with the reason.
  - Empty means anyone can be invited. An entry also allows its sub-domains, never a domain that only ends with the same letters.
  - **Enforced by trigger `organisation_users_email_domain`**, so every way of inviting obeys it: one, many, or a removed member invited again (`QM015` → `409 invitation_rule`, "This organisation only invites addresses at …"). In a bulk invitation each row is refused on its own.
  - Members already outside, active or invited, are listed (`app.members_outside_email_domains`, `security.read`) and never removed.
- **Maximum session age (S11):**
  - Set with `organisation_settings.max_session_hours` (1–720, null = no limit), written only by `app.set_max_session_hours` (`security.manage`).
  - `OrganisationGuard` reads it in its one query (`app.max_session_hours(org)`, members only). It takes the sign-in time from the token's `amr` claim, the newest entry (`signedInAt`, `sessionTooOld`).
  - Older than the limit, or with no sign-in time in the token, means **`401 reauthentication_required`** with `maxSessionHours`. Supabase keeps `amr` when it refreshes a token, so refreshing does not reset the clock.
- **API:**
  - `PUT /security/email-domains {domains}` and `PUT /security/session-age {hours|null}` (`security.manage`).
  - The policy carries `allowedEmailDomains`, `outsideDomains` and `maxSessionHours`.
- **Screens:**
  - Settings → Security has **Who can be invited** (domain chips added and removed at once, optimistic, and the members already outside) and **Sign in again after** (No limit, 8 hours, 12 hours, 1 day, 7 days, 30 days).
  - When any request answers `401 reauthentication_required`, `apiFetch` raises `qms:reauthentication-required`. `App.jsx` then signs the person out and leaves the reason in session storage, and the sign-in page shows it once.
- **Fix to SE5 in the same migration:** two policy changes in one transaction had the same `created_at`, so the recovery function's "latest change" was chosen by a random id (it showed as a flaky SQL test). `network_policy_changes.created_at` now defaults to `clock_timestamp()`, and the function picks its own recovery row.
- **Tests:** `supabase/tests/security_who_rules.test.sql`, `api/test/security-who.e2e-spec.ts` (including the `amr` helpers), `SettingsSecurity.test.jsx`, `App.test.jsx`, `api-client.test.js`, `Onboarding.test.jsx` (the sign-in note).

## 16. Not in this plan

- SSO (Entra ID, SAML), device certificates, managed devices, country rules.
- Per-person or per-site allowlists (the policy is organisation-wide, as in the brief).
- Automatic discovery of company networks.
- A security dashboard beyond the blocked-attempts list.
- Restricting **sign-in** itself (Supabase Auth is shared by all organisations; the rule applies to the organisation's data).
- Revoking a signed file link already issued (it expires within five minutes while enforced).
