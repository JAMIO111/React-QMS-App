import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// The marketing site: plain static HTML, deployed as its own Vercel project (root directory `site`).
export default defineConfig({
  site: 'https://fortress-qms.com',
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [sitemap({ filter: (page) => !page.endsWith('/404') })],
});
