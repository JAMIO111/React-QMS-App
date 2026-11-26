/**
 * What the harness builds and how it behaves: the size of the seeded year, the people, the day's mix and the pass criteria.
 * Everything can be overridden from the environment; nothing here reads a database.
 *
 * LOADTEST_PROFILE = smoke (a few minutes to prove the harness itself works) | day (the default: a client's year of data, an 8 hour working day
 *                    compressed into half an hour) | stress (twice the people at half the think time).
 * LOADTEST_SCALE   = a multiplier on the seeded volumes (1 = the full year described in docs/capacity-assessment.md).
 */
const PROFILES = {
  smoke: { scale: 0.003, durationSec: 90, userFactor: 0.4, thinkFactor: 1 },
  day: { scale: 1, durationSec: 1800, userFactor: 1, thinkFactor: 1 },
  stress: { scale: 1, durationSec: 1800, userFactor: 2, thinkFactor: 0.5 },
};

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

function load(env = process.env) {
  const name = env.LOADTEST_PROFILE ?? 'day';
  const base = PROFILES[name];
  if (!base) throw new Error(`Unknown LOADTEST_PROFILE "${name}" (use smoke, day or stress)`);
  const scale = num(env.LOADTEST_SCALE, base.scale);
  const durationSec = num(env.LOADTEST_DURATION_SEC, base.durationSec);
  const workingDaySec = 8 * 3600;

  // The shape of a year at the client we are proving: 300 inspections a working day for 250 days; each inspection samples a 300-piece lot every 60 parts (5 samples)
  // of a plan with 8 checks (6 measured, 2 pass/fail) = 40 readings.
  const counts = {
    families: Math.max(3, Math.round(100 * scale)),
    parts: Math.max(30, Math.round(10000 * scale)),
    suppliers: Math.max(6, Math.round(300 * scale)),
    purchaseOrders: Math.max(30, Math.round(100000 * scale)),
    poLinesPerOrder: 3,
    receiptShare: 0.4, // the share of orders that have had a delivery recorded
    ncs: Math.max(6, Math.round(3000 * scale)),
    inspections: Math.max(40, Math.round(75000 * scale)),
    gauges: 5,
    machines: 20,
    checksPerPlan: 8,
    measuredChecks: 6,
    lotSize: 300,
    sampleEveryParts: 60,
    hotPartShare: 0.1, // this share of the parts takes ...
    hotInspectionShare: 0.8, // ... this share of the inspections, as a real plant's runners do (it makes the SPC series long where they would be)
    shiftedShare: 0.03, // inspections whose mean has drifted: failures, acknowledgements and SPC alerts happen
    daysSpread: 365,
  };

  // Thirty people: the user count of the client being proven.
  const total = Math.max(5, Math.round(30 * base.userFactor));
  const users = {
    owner: 1,
    managers: Math.max(1, Math.round(total * 0.07)),
    engineers: Math.max(1, Math.round(total * 0.2)),
    inspectors: Math.max(2, Math.round(total * 0.33)),
  };
  users.viewers = Math.max(1, total - users.owner - users.managers - users.engineers - users.inspectors);

  return {
    name,
    scale,
    counts,
    users,
    run: {
      durationSec,
      warmupSec: Math.min(60, Math.round(durationSec * 0.05)),
      // How much faster than real life the day runs: 8 hours in `durationSec` seconds. Think times and poll intervals are divided by it; the request
      // mix per person-hour is therefore the real one, only squeezed.
      timeScale: (workingDaySec / durationSec) / base.thinkFactor,
      apiPoolMax: num(env.LOADTEST_POOL_MAX, 15), // Supabase's pooler gives the API about 15 server connections on Micro/Small
      workerTickEverySec: num(env.LOADTEST_TICK_SEC, 0), // 0 = every 5 real minutes, as pg_cron does, compressed like everything else
      seedConcurrency: num(env.LOADTEST_SEED_CONCURRENCY, 16),
    },
    // Pass criteria. A label that starts "page:" is an interactive read, "dash:" a dashboard, "write:" a save, "poll:" the background polling.
    thresholds: {
      'page:': { p95: num(env.LOADTEST_P95_PAGE_MS, 1000) },
      'dash:': { p95: num(env.LOADTEST_P95_DASH_MS, 3000) },
      'write:': { p95: num(env.LOADTEST_P95_WRITE_MS, 1500) },
      'poll:': { p95: num(env.LOADTEST_P95_POLL_MS, 500) },
      errorRate: num(env.LOADTEST_MAX_ERROR_RATE, 0.001),
    },
  };
}

module.exports = { load, PROFILES };
