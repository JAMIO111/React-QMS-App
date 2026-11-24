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

function watch(page, who, extra = []) {
  // Saves the app shows before the server answers (optimistic UI) are counted, so the journey's database checks wait for them (see below).
  page.on('request', (r) => { if (isWrite(r)) { r.__sentAt = Date.now(); inFlight.add(r); } });
  for (const done of ['requestfinished', 'requestfailed']) page.on(done, (r) => inFlight.delete(r));
  // A closed window's unfinished requests never finish: forget them.
  page.on('close', () => { for (const r of inFlight) if (r.frame?.()?.page?.() === page) inFlight.delete(r); });
  const allowed = [...ALLOWED, ...extra];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // The browser logs every failed request as a console error; the ones we expect (see ALLOWED) are not problems.
    const status = /status of (\d+)/.exec(m.text());
    if (status && allowed.some((a) => a(Number(status[1]), m.location().url ?? ''))) return;
    problems.push(`[${who}] console error: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => problems.push(`[${who}] page error: ${String(e).slice(0, 300)}`));
  page.on('response', async (r) => {
    const u = r.url();
    if (r.status() >= 400 && (u.includes(`:${PORTS.api}`) || u.includes(`:${PORTS.supabase}`)) && !allowed.some((a) => a(r.status(), u))) {
      const text = await r.text().catch(() => '');
      problems.push(`[${who}] ${r.status()} ${r.request().method()} ${u} ${text.slice(0, 300)}`);
    }
  });
}
const inFlight = new Set();
const isWrite = (r) => r.method() !== 'GET' && r.method() !== 'OPTIONS' && (r.url().includes(`:${PORTS.api}`) || r.url().includes(`:${PORTS.supabase}`));
/** Resolves once no save is on its way to the API (at most 10 s): the screen changes first, the database a moment later. */
async function writesSettled() {
  const until = Date.now() + 10000;
  // Only saves started in the last minute count: anything older is not what the next check is about.
  const recent = () => [...inFlight].filter((r) => Date.now() - (r.__sentAt ?? 0) < 60000).length;
  while (recent() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

// Answers the app is expected to get during the journey (each is the app's own, handled, behaviour).
const ALLOWED = [
  (s, u) => u.includes('/storage/v1/'), // nothing is stored in the stand-in
  (s, u) => s === 409 && /\/api\/v1\/ncrs\/[^/]+\/transitions$/.test(u), // the stage gates refuse a move and say what is missing (the journey provokes it once)
  (s, u) => s === 409 && /\/api\/v1\/ncrs\/[^/]+$/.test(u), // edit conflicts: the owner saves on the version they opened after Colin saved; the app merges or asks (provoked twice)
  (s, u) => s === 409 && /\/api\/v1\/production-orders\/[^/]+$/.test(u), // the database refuses to complete an order with an open operation and says which (provoked once)
  (s, u) => s === 409 && /\/api\/v1\/change-tasks\/[^/]+\/complete$/.test(u), // the database refuses to finish a change task while its revision is still a draft and says so (the journey provokes it once)
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
  // The journey's own database checks wait for the saves the app already shows to reach the server. Only the journey's view of the stack
  // is wrapped: the stand-in Supabase answers the app with the same connection and must never wait for the app's own requests.
  const admin = Object.create(stack.admin);
  admin.query = async (...args) => { await writesSettled(); return stack.admin.query(...args); };
  const journeyStack = Object.create(stack);
  journeyStack.admin = admin;
  const browser = await chromium.launch();
  // Closing a window right after the screen changed would cut off the save still on its way: wait for it first.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const ctx = await newContext(...args);
    const close = ctx.close.bind(ctx);
    ctx.close = async (...a) => { await writesSettled(); return close(...a); };
    return ctx;
  };
  let failed = null;
  try {
    await require('./journey.cjs')({ browser, stack: journeyStack, APP, watch, shot, step, log, problems });
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
