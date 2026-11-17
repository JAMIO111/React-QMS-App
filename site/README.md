# Fortress QMS website

The public marketing site: landing page, about, FAQ, contact, help guides and legal pages. Plain static HTML built with
[Astro](https://astro.build); no framework runs in the browser, only a few small scripts. It is **not** the application
(that is the Vite app in the repository root) and has its own Vercel project.

```bash
cd site
npm install
npm run dev        # http://localhost:4321
npm run build      # static output in site/dist
```

Where things live:

| What | Where |
| --- | --- |
| Look and feel (tokens, frame, nav, footer, long text) | `src/styles/global.css` |
| Page shell, metadata, sheet frame | `src/layouts/Base.astro` |
| Landing sections | `src/components/` (`Hero`, `Modules`, `Thread`, `AuditLog`, `Security`, `Connect`, `FinalCta`) |
| Help guides | `src/content/docs/*.md` (front matter: `title`, `summary`, `group`, `order`) |
| Terms, privacy, cookies | `src/content/legal/*.md` |
| Addresses, contact email, company details | `src/config.ts` (or `PUBLIC_*` environment variables) |

Settings (Vercel project environment variables, all optional):

| Variable | Default | Use |
| --- | --- | --- |
| `PUBLIC_APP_URL` | `https://app.fortress-qms.com` | Where **Log in** and **Start trial** go |
| `PUBLIC_CONTACT_EMAIL` | `hello@fortress-qms.com` | The contact address; must be a real mailbox |
| `PUBLIC_COMPANY_NAME`, `PUBLIC_COMPANY_ADDRESS`, `PUBLIC_COMPANY_NUMBER` | empty | Shown on the legal pages; empty shows a visible "to be added" marker |
| `PUBLIC_LEGAL_REVIEWED` | `false` | Set `true` once a solicitor has signed off the legal texts; until then the pages say they are a draft |

Rules for the content: say only what the product does today (check `CLAUDE.md` and the app), keep numbers in examples
marked as examples, and add a guide by dropping a Markdown file in `src/content/docs`.
