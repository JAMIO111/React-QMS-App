# The public website (`site/`)

A small static site in front of the product: landing page, about, FAQ, contact, help guides and the legal pages.
Agreed 2026-11-17: **a separate Vercel project built from this repository's `site/` folder**, with the marketing site on the bare
domain and the application on `app.fortress-qms.com`.

## Why separate

The application is a client-rendered single-page app. A landing page needs real HTML for search engines and link previews,
and its wording should change without rebuilding the application. The site shares the brand (the blueprint look of the sign-in
page) but none of the application's code.

## What is in it

- **Design:** the drawing-sheet idea. Dark blueprint sections and light drafting paper, a sheet border with zone numbers, a title
  block footer, red-pen markup, mono labels. Poppins and IBM Plex Mono are bundled with the site (no Google Fonts request).
  Light and dark follow the visitor's system.
- **Landing page:** a self-drawing flange with a **measuring demo** (drag a reading out of tolerance, raise a non-conformance,
  watch an 8D run D0 to D8; made-up numbers, labelled as such), the parts list of modules, the traceability thread, the
  append-only audit trail, security, integrations and the closing call to action.
- **Pages:** `/about`, `/faq` (FAQPage structured data), `/contact` (the form writes a `mailto:` so no server is involved),
  `/help` and the guides (`src/content/docs`, one for each module and the main admin jobs, grouped Start here, Everyday work, Quality system, Suppliers and customers, Admin and security; **every module needs a guide: add one when a module is added**), `/legal/terms|privacy|cookies` (`src/content/legal`), a 404.
- **The navbar button** is **Log in** and links to `<app>/login`; hero and closing buttons go to `<app>/signup`.
- **SEO:** titles, descriptions, canonical links, Open Graph image (`public/og.png`), sitemap, robots, JSON-LD.
- **No tracking at all.** That is why the cookie page can say the site sets no cookies and shows no banner. Adding analytics
  later means updating `cookies.md` and `privacy.md` and asking for consent.

## Truth rules for the copy

Say only what the product does today. Every claim on the site was taken from `CLAUDE.md` or the app. Before adding one, check it.
Two things to keep in mind:

- **SAML single sign-on** is built and covered by tests but has **not been run against a real identity provider**, and Supabase
  needs the Pro plan for it (see `docs/sso-exit-report.md`). The site mentions it (hero facts, security cards, FAQ, help guide).
  Either upgrade and run the live check before launch, or soften those lines.
- Example references, names and readings on the page are marked as examples.

## Legal texts

`terms.md`, `privacy.md` and `cookies.md` are **drafts written for a UK business**, not legal advice. Until a solicitor has
reviewed them the pages show a "Draft" notice. Things only the owner can supply:

| Item | Where |
| --- | --- |
| Company name, registered office, company number | `PUBLIC_COMPANY_NAME`, `PUBLIC_COMPANY_ADDRESS`, `PUBLIC_COMPANY_NUMBER` (empty shows a visible marker) |
| Retention periods, liability cap | the `todo` spans in `terms.md` and `privacy.md` |
| Review sign-off | `PUBLIC_LEGAL_REVIEWED=true` removes the draft notice |
| Subprocessors | the table in `privacy.md` lists Supabase, Vercel, Stripe, Cloudflare and Resend (Resend only once switched on); keep it true |

The application's sign-up and first-sign-in pages link to the terms and privacy policy through `VITE_TERMS_URL` and
`VITE_PRIVACY_URL` (`src/lib/terms.js`). `TERMS_VERSION` there is what is stored when someone accepts, so **bump it when the terms
change materially**.

## Putting it live (done 2026-11-17; kept as the record and for a rebuild)

**Step 1: deploy the site without touching the app.**

1. Vercel → Add New Project → this repository, **Root Directory `site`**, framework Astro. Name it `qms-site`.
2. Settings → Git → Ignored Build Step, same pattern as the other projects (build only `main`):
   `if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then exit 1; else exit 0; fi`
3. Environment variables (Production): `PUBLIC_CONTACT_EMAIL`, the three `PUBLIC_COMPANY_*` values and, when reviewed,
   `PUBLIC_LEGAL_REVIEWED=true`. Create the mailbox first (for example Cloudflare Email Routing forwarding `hello@` to you).
4. Check the `*.vercel.app` address before touching DNS.

**Step 2: move the app to `app.fortress-qms.com`.** Do all of it in one sitting, in this order, because the bare domain changes
hands and email links must keep working.

1. Cloudflare DNS (DNS only, grey cloud): add `CNAME app → cname.vercel-dns.com`.
2. `qms-web`: add the domain `app.fortress-qms.com`. Then remove `fortress-qms.com` and `www.fortress-qms.com` from it.
3. `qms-site`: add `fortress-qms.com`, and `www.fortress-qms.com` redirecting to it.
4. `qms-api` (Production variables): `CORS_ORIGINS=https://app.fortress-qms.com`, `APP_BASE_URL=https://app.fortress-qms.com`,
   `INVITE_REDIRECT_URL=https://app.fortress-qms.com/set-password?mode=invite`. Redeploy the API.
5. `qms-web` (Production variables): `VITE_TERMS_URL=https://fortress-qms.com/legal/terms`,
   `VITE_PRIVACY_URL=https://fortress-qms.com/legal/privacy`. Redeploy.
6. Supabase → Authentication → URL configuration: **Site URL `https://app.fortress-qms.com`** (the email templates build their
   buttons from it) and add `https://app.fortress-qms.com/**` to Redirect URLs. Keep the old bare-domain entry for a week so
   emails already sent still land somewhere, then remove it.
7. Check: log in from the site's button, sign up, send yourself an invitation and a password reset, open the Stripe checkout
   and return, and open `https://fortress-qms.com/login` (it redirects to the app).

Not affected: the worker schedule and the Stripe webhook (both use `api.fortress-qms.com`), connector agents (`AGENT_API_URL`),
SSO's callback (it is on the app's own address).

## Commands

`cd site && npm install && npm run dev` (port 4321) · `npm run build` · see `site/README.md`.
The root `npm run lint` skips `site/`, and Tailwind in the app scans only `src/`, so the two projects do not affect each other.
Known: `npm audit` reports a path-matching advisory in build-time tooling (`picomatch` via Astro and Vite). Nothing from it is shipped.

## State after the move (2026-11-17)

- `fortress-qms.com` and `www` (308 to the bare domain) → `qms-site`; `app.fortress-qms.com` → `qms-web`; `api.fortress-qms.com` → `qms-api`. All three DNS records are DNS only (grey cloud) in Cloudflare.
- `qms-site` was created through the Vercel connector and first deployed from `Dev`; its production branch is `main`, so the next release merge (`Dev` into `main`) is what keeps it current.
- API production variables: `CORS_ORIGINS=https://app.fortress-qms.com`, `APP_BASE_URL=https://app.fortress-qms.com`, `INVITE_REDIRECT_URL=https://app.fortress-qms.com/set-password?mode=invite`. `qms-web` production: `VITE_TERMS_URL`, `VITE_PRIVACY_URL` pointing at the website.
- Still to do by the owner: the Supabase redirect entry for the old bare domain can be removed after about a week; the contact mailbox (`hello@`), the `PUBLIC_COMPANY_*` values and the legal review (`PUBLIC_LEGAL_REVIEWED`) are set on the `qms-site` project when known.
