# Organisation security — exit report

**Date:** 2026-11-14 · **Plan:** `docs/security-plan.md` (decisions S1–S12) · **Slices:** SE0–SE6, SX · **Branch:** `Dev`

## What was built

An organisation can say **where** Fortress may be used from and, alongside two-factor, **who** may be invited and how long a sign-in lasts. All of it is on **Settings → Security** (owner and admin: `security.read` / `security.manage`).

- **Address source (SE0):** checked on the Vercel deployment. Vercel overwrites every forwarding header with the caller's real address, so `req.ip` with one trusted hop cannot be forged (plan §9).
- **Networks and modes (SE1–SE2):** approved IPv4 / IPv6 addresses and ranges (`organisation_networks`; normalised by the database, private / special / very wide ranges refused, removed with a reason, never deleted). The policy is **off / monitor / enforce**. The check runs in `OrganisationGuard`'s one query, so every organisation route is covered, a change applies on the very next request, and a denied request answers `403 network_not_allowed`. Denied and monitored requests are recorded per person, address and hour (`access_denials`, 90 days). **Lockout rule:** enforcing needs an active network holding your own address, and while enforced nothing that would shut you out is accepted.
- **Files (SE3):** organisation files go through the API (`POST /files/upload-url|download-url|remove`). The API checks the network and the bucket's rule, then signs a short link. Storage policies refuse direct access while the organisation enforces. A test fails if browser code calls Supabase Storage directly.
- **Screens and emails (SE4):** the Security tab (two-factor switch moved here, modes, "Your address as Fortress sees it" with **Add this address**, networks, a typed "enforce" confirmation, blocked attempts), a **blocked screen** in place of the app, the organisation switcher marking blocked organisations, and **short emails while enforced** ("You have a new notification in Fortress — <organisation>").
- **History and recovery (SE5):** every policy change is kept (`network_policy_changes`, frozen) and told to owners and admins, in full by email even while enforced, with what to do if everyone is locked out. A **platform operator with MFA** can put an enforcing organisation back to monitor, giving a reason and how ownership was checked. Networks are kept and the policy is never switched off.
- **Who rules (SE6):** **allowed email domains** for invitations (sub-domains included; enforced by a trigger, so every way of inviting obeys it; members already outside are listed, never removed) and a **maximum session age** (1 hour to 30 days, from the token's sign-in time; `401 reauthentication_required`; the app signs the person out and the sign-in page says why).
- **Exit check (SX):** this report, the live checks below and a browser journey step.

## Evidence

| Check | Result |
|---|---|
| `npm run db:check` (all migrations through `20260304100000`; 125 SQL tests incl. `organisation_security`, `storage_through_api`, `network_policy_recovery`, `security_who_rules`, guardrails and the tenancy sweep) | pass |
| `npm run api:test` (388) and `api:test:e2e` (1,067 tests incl. `security`, `client-address`, `files`, `network-recovery`, `security-who`, and the API tenancy sweep for every new route) | pass |
| `npm test` (1,563 Vitest tests), `npm run lint` (0 errors), `npm run build` | pass |
| Live guardrails (`supabase/checks/guardrails.sql` against the live project, full lists) | **0 violations**; the audited list includes `organisation_networks` and `network_policy_changes` |
| Live objects | every migration (`20260228100000` … `20260304100000`) checked after it was applied: tables, columns, functions and their grants (none callable by `anon`; the `system_` functions only by the API login), triggers (`organisation_users_email_domain`, the policy history), storage policies, the `clock_timestamp()` default and the fixed recovery function |
| Advisors (security) | nothing new. The two project-wide warnings remain: every table is visible to GraphQL (233 objects, protected by RLS) and **leaked-password protection is off** (a Supabase dashboard setting) |
| Advisors (performance) | INFO only for these tables: foreign keys without a covering index (the actor columns `created_by` / `updated_by` / `removed_by` / `changed_by` and `access_denials.user_id`) and indexes not yet used (no organisation has used the feature) |
| Browser journey (`npm run journey`) | the whole journey passes with the new step (`networkRestrictions()`): the owner, appearing at the head office (203.0.113.10), sees that address on Settings → Security, adds it with **Add this address** and switches to **Monitor**; Colin signs in from home (198.51.100.200), is let in, and his request is listed under Recent blocked attempts; the owner **enforces** (typed confirmation); Colin's reload shows the **blocked screen** with his address while the owner carries on; a platform operator (MFA token) recovers access, the organisation is back on monitor, Colin's **Try again** gets him in; the history lists the recovery; the owner switches restrictions off; owners were told of all four changes |

## Proxy set-up per environment

The check relies on `req.ip`, which depends on Express's `trust proxy` (`TRUST_PROXY_HOPS`).

| Environment | `TRUST_PROXY_HOPS` | Why |
|---|---|---|
| Vercel (dev today; production when it exists) | **1** (the default for `NODE_ENV=production`; leave unset) | Vercel replaces `X-Forwarded-For`, `X-Real-IP`, `X-Vercel-Forwarded-For` and `Forwarded` with the caller's address (checked in SE0, plan §9) |
| Local development, unit and e2e tests | 0 (the default elsewhere) | No proxy: forwarding headers are ignored and the socket address is used |
| Browser journey | 1 | Stands for Vercel: Playwright sets `X-Forwarded-For` on the browser's API requests to give the owner an office address and Colin a home one |
| A CDN or proxy in front of Vercel (e.g. Cloudflare) | 2, **and** the Vercel origin must refuse traffic that does not come through it | Otherwise a caller could reach Vercel directly with a forged header. Re-run the SE0 check (plan §9) after any such change |

Customers whose traffic leaves through a pool of addresses (many corporate firewalls and VPNs) must approve the **range**. Monitor mode shows the addresses that would be refused before anything is enforced.

## What the browser found

No fault in the app. The step needed two test-side changes:

1. `access_denials.address` is stored as text (it can be `unknown`), so the journey compares it as text, not `inet`.
2. Colin's page is refused on purpose while enforced, so its watcher accepts `403` (`watch(page, who, extra)` in `scripts/journey/run.cjs` now takes extra expected answers). Everything else in the journey still fails on any unexpected `4xx`.

## Rules held by the database (not only the screens)

Networks, the policy, email domains and the session limit change only through SECURITY DEFINER functions that need `security.manage`, and the lockout rule is in the database. The policy history is written by a trigger and frozen. Recovery is a function only a platform operator with an MFA session can call; it goes to monitor, never off. Invitations outside the allowed domains are refused by a trigger whatever path inserts them. Storage policies call the same file rule as the API and refuse direct access while enforced, except for the API's own login. Nothing is deleted.

## Design notes and limits

- **Network control, not device or identity control.** It does not prove a device is the company's, and it does not replace SSO.
- **Sign-in itself is not restricted.** Supabase Auth is shared by every organisation. The rule applies to the organisation's data, so a blocked person can sign in and sees the blocked screen.
- **A file link already issued** works anywhere until it expires (at most five minutes while enforced).
- **The worker, emails and system jobs** act without a person's request and are not checked (S10). What they produce is read through the API, where the rule applies. Email content is reduced while enforced.
- **The session age** is measured from the newest sign-in method in the token's `amr` claim. A token without one is not limited.
- Not built: SSO, per-person or per-site allowlists, country rules, automatic discovery of networks, a daily digest of blocked attempts, revoking an issued file link, a subscription feature.
- Not load-tested.

## Go-live runbook

Nothing to switch on: every organisation starts with restrictions **off**, no domains and no session limit. To restrict one:

1. An owner or admin opens **Settings → Security** from the office or VPN and adds its address or range (**Add this address**, then any other sites).
2. Switch to **Monitor** for a few days. Add the networks that **Recent blocked attempts** shows are the company's own.
3. Switch to **Enforce** and type the word. Owners and admins are told, with what to do if everyone is locked out.
4. If everyone is locked out, the owner contacts Fortress. A platform operator checks it is the owner, then uses **Recover access** on the operator panel's Organisations tab. The organisation goes back to monitor with its networks kept.

Check before relying on it in production: the API runs on Vercel with `TRUST_PROXY_HOPS` unset (or 1), and `SUPABASE_SERVICE_ROLE_KEY` is set so file links can be signed (otherwise `503 file_storage_unavailable`).
