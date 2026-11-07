/**
 * Browser journey (docs/onboarding-plan.md §16): a new customer signs up, verifies, signs in, starts an organisation, is locked until they pay, buys seats at the fake
 * Checkout, walks the wizard, invites a colleague, reaches the dashboard; the colleague signs up and accepts. Real web app (Vite), real API, real migrated database;
 * Supabase and Stripe are stand-ins (stack.cjs). Fails on console errors, page errors and unexpected failed requests. Screenshots go to JOURNEY_OUT (default /tmp/journey).
 * Run: npm run journey (about two minutes: it migrates a throwaway database first). Needs Playwright with Chromium.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startStack, PORTS } = require('./stack.cjs');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('The journey drives a real browser with Playwright. Install it (npm i -D playwright && npx playwright install chromium) or point NODE_PATH at an installation.');
  process.exit(2);
}

const WEB_PORT = 5199;
const APP = `http://127.0.0.1:${WEB_PORT}`;
const OUT = process.env.JOURNEY_OUT || '/tmp/journey';
fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const log = (m) => console.log(m);
const step = (name) => log(`\n== ${name}`);

async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

function watch(page, who) {
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${who}] console error: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => problems.push(`[${who}] page error: ${String(e).slice(0, 300)}`));
  page.on('response', async (r) => {
    const u = r.url();
    if (r.status() >= 400 && (u.includes(`:${PORTS.api}`) || u.includes(`:${PORTS.supabase}`)) && !ALLOWED.some((a) => a(r.status(), u))) {
      const text = await r.text().catch(() => '');
      problems.push(`[${who}] ${r.status()} ${r.request().method()} ${u} ${text.slice(0, 300)}`);
    }
  });
}
// Answers the app is expected to get during the journey (each is the app's own, handled, behaviour).
const ALLOWED = [
  (s, u) => u.includes('/storage/v1/'), // nothing is stored in the stand-in
  (s, u) => s === 403 && u.includes('/api/v1/') && /subscription_required|mfa_required/.test(u) === false && false,
];

async function shot(page, name) { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }); }

(async () => {
  let stopping = false;
  const web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--host', '127.0.0.1', '--strictPort'], {
    env: { ...process.env, BROWSER: 'none', VITE_SUPABASE_URL: `http://127.0.0.1:${PORTS.supabase}`, VITE_SUPABASE_KEY: 'journey-anon-key', VITE_API_URL: `http://127.0.0.1:${PORTS.api}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  web.stderr.on("data", (d) => { if (!stopping) process.stderr.write(d); });
  const stack = await startStack({ appUrl: APP, log });
  await waitFor(APP);
  const browser = await chromium.launch();
  let failed = null;
  try {
    await require('./journey.cjs')({ browser, stack, APP, watch, shot, step, log, problems });
  } catch (e) {
    failed = e;
    for (const c of browser.contexts()) for (const [i, p] of c.pages().entries()) await p.screenshot({ path: path.join(OUT, `FAILED-${i}.png`) }).catch(() => {});
  } finally {
    stopping = true;
    await browser.close();
    await stack.stop();
    try { process.kill(-web.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (failed) { console.error(`\nJOURNEY FAILED: ${failed.stack ?? failed}`); }
  if (problems.length) { console.error(`\nProblems seen in the browser/stack:\n- ${[...new Set(problems)].join('\n- ')}`); }
  if (failed || problems.length) process.exit(1);
  log(`\nJourney passed. Screenshots in ${OUT}`);
})();
