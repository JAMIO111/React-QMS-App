/**
 * Orchestrates a load test run:  guard → start the real API → seed a year → play a day → report.
 *
 *   npm run loadtest                       (a client's year and one working day, ~2 h; needs ~10 GB of disk and Postgres server binaries)
 *   LOADTEST_PROFILE=smoke npm run loadtest   (a few minutes: proves the harness works)
 *
 * Flags (environment): LOADTEST_PHASE=seed|test|all (default all), LOADTEST_OUT=<dir>, LOADTEST_STATE=<state.json to resume from>,
 * LOADTEST_REDATE=1 (spread the seeded timestamps over the year), LOADTEST_VERBOSE=1, plus everything in profile.cjs.
 * Read scripts/loadtest/README.md first. The harness refuses to start unless the database is a throwaway one (guard.cjs).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const guard = require('./guard.cjs');
const profileLib = require('./profile.cjs');
const { Recorder, sleep } = require('./stats.cjs');
const { client } = require('./http.cjs');
const { seed } = require('./seed.cjs');
const { runDay } = require('./driver.cjs');
const rep = require('./report.cjs');

const ROOT = path.resolve(__dirname, '../..');
const env = process.env;
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${stamp()}] ${m}`);

async function main() {
  const profile = profileLib.load(env);
  const phase = env.LOADTEST_PHASE ?? 'all';
  if (!['seed', 'test', 'all'].includes(phase)) throw new Error('LOADTEST_PHASE must be seed, test or all');

  // 1. The guard. Nothing below runs unless this passes.
  const targets = guard.resolveTargets(env);
  if (!targets.ok) {
    console.error('The load test will not start:\n- ' + targets.problems.join('\n- '));
    process.exit(2);
  }
  const admin = new Pool({ connectionString: targets.adminUrl, max: 4 });
  await guard.assertEmptyOfRealOrganisations(admin);
  log(`target ok (${targets.local ? 'local throwaway database' : 'separate test project'}); profile ${profile.name}, scale ${profile.scale}`);
  if (targets.local && phase === 'seed') log('note: a local throwaway database is deleted when this command ends, so a seed-only run leaves nothing to test against');

  const out = env.LOADTEST_OUT ?? path.join(os.tmpdir(), `loadtest-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(out, { recursive: true });
  const statePath = env.LOADTEST_STATE ?? path.join(out, 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  const save = async () => fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  log(`output in ${out}`);

  // 2. The real API, compiled, as a child process with its own memory and connection pool (so its CPU and RSS are the API's alone).
  const jwtSecret = crypto.randomBytes(24).toString('hex');
  const cronSecret = crypto.randomBytes(16).toString('hex');
  const port = Number(env.LOADTEST_API_PORT ?? 3499);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const apiLog = fs.createWriteStream(path.join(out, 'api.log'));
  const child = spawn(process.execPath, [path.join(ROOT, 'api/dist/main.js')], {
    cwd: path.join(ROOT, 'api'),
    env: {
      PATH: env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: targets.url,
      DATABASE_POOL_MAX: String(profile.run.apiPoolMax),
      SUPABASE_JWT_SECRET: jwtSecret,
      JWT_ISSUER: 'loadtest-issuer',
      CORS_ORIGINS: 'http://localhost:5173',
      RATE_LIMIT_PER_MINUTE: '1000000',
      TRUST_PROXY_HOPS: '0',
      CRON_SECRET: cronSecret,
      EXCHANGE_RATES: 'off',
      MAIL_PROVIDER: 'none',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(apiLog);
  child.stderr.pipe(apiLog);
  let apiExited = false;
  child.on('exit', (code) => {
    apiExited = true;
    log(`API process exited (${code})`);
  });
  const stopApi = async () => {
    if (apiExited) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 50 && !apiExited; i += 1) await sleep(100);
    if (!apiExited) child.kill('SIGKILL');
  };

  let exitCode = 0;
  try {
    for (let i = 0; ; i += 1) {
      if (apiExited) throw new Error(`The API did not start; see ${path.join(out, 'api.log')}`);
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (i > 150) throw new Error('The API did not answer /health within 30 s');
      await sleep(200);
    }
    log('API is up');

    // 3. Seed.
    if (phase !== 'test') {
      const seedApi = client({ base, secret: jwtSecret, orgId: state.orgId ?? require('./seed.cjs').ORG });
      await seed({ admin, api: seedApi, profile, state, save, log, redate: env.LOADTEST_REDATE === '1' });
      state.seedReport = await rep.tableReport(admin);
      await save();
      log(`seeded: ${state.seedReport.readings} readings, database ${Math.round(state.seedReport.databaseMb)} MB`);
    }
    if (phase === 'seed') return;
    if (!state.seeded) throw new Error('Nothing was seeded: run with LOADTEST_PHASE=seed first, or all');

    // 4. The day.
    const recorder = new Recorder();
    recorder.measuring = false;
    const dayApi = client({ base, secret: jwtSecret, orgId: state.orgId, recorder });
    try {
      await admin.query('create extension if not exists pg_stat_statements');
      await admin.query('select pg_stat_statements_reset()');
    } catch {
      /* needs shared_preload_libraries; the report simply omits it */
    }
    const sampler = new rep.Sampler({ admin, apiPid: child.pid });
    sampler.start();
    const startedAt = Date.now();
    setTimeout(() => {
      recorder.measuring = true;
      log('warm-up over: measuring');
    }, profile.run.warmupSec * 1000);
    await runDay({ api: dayApi, state, profile, recorder, log, base, cronSecret, verbose: env.LOADTEST_VERBOSE === '1' });
    await sampler.stop();
    const seconds = (Date.now() - startedAt) / 1000 - profile.run.warmupSec;

    // 5. The report.
    const rows = recorder.summary(seconds);
    const verdict = rep.evaluate(rows, profile.thresholds);
    const settings = (await admin.query(`select name, setting from pg_settings where name in ('shared_buffers','work_mem','max_connections','effective_cache_size')`)).rows;
    const version = (await admin.query('show server_version')).rows[0].server_version;
    const meta = {
      'Profile': `${profile.name} (scale ${profile.scale}, ${profile.run.durationSec} s for an 8 hour day = ${profile.run.timeScale.toFixed(1)}x)`,
      'People': Object.entries(profile.users).map(([k, v]) => `${v} ${k}`).join(', '),
      'Machine': `${os.cpus().length} cores, ${Math.round(os.totalmem() / 1024 ** 3)} GB, ${os.platform()} ${os.release()}, Node ${process.version}`,
      'Postgres': `${version}; ${settings.map((s) => `${s.name}=${s.setting}`).join(', ')}`,
      'API pool': `${profile.run.apiPoolMax} connections`,
      'Database': targets.local ? 'local throwaway cluster (same machine as the API and the load: CPU is shared)' : 'separate test project',
      'Started': new Date(startedAt).toISOString(),
    };
    const notes = [
      'A PASS here means: on this machine, with this data, every interactive read was under its p95 limit and fewer than the allowed share of requests failed. It is not a promise about Supabase or Vercel, whose CPUs and network differ.',
      'A local run puts the API, the database and the load on one machine, so CPU-bound figures are pessimistic for the database and optimistic for network latency. Read the database and API CPU peaks first: if the machine itself was saturated, a slow label is the harness, not the product.',
      'Compare the API memory peak with the function memory limit and the database size and connection peak with the plan you intend to buy (see the capacity assessment). Run the same profile against a separate Supabase test project (README: remote runs) to prove the real thing.',
      'The seed is one compressed year, spread by the optional redate step; time-based queries only see a year if LOADTEST_REDATE=1 was set when the seed ran.',
      'Expected 4xx statuses (for example 403 on a dashboard a role may not read) are listed apart and do not count as failures; any other 4xx or 5xx does. If a label shows 400 or 404, a path or query in driver.cjs no longer matches the API: fix the harness.',
    ];
    const slow = await rep.slowStatements(admin);
    const md = rep.render({ meta, seedReport: state.seedReport, summaryRows: rows, verdict, sampler: sampler.summary(), slow, notes });
    fs.writeFileSync(path.join(out, 'report.md'), md);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ meta, verdict, rows, sampler: sampler.summary(), seedReport: state.seedReport, samples: sampler.rows }, null, 1));
    log(`${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.total} requests, ${verdict.bad} failed. Report: ${path.join(out, 'report.md')}`);
    if (!verdict.ok) exitCode = 1;
  } catch (e) {
    console.error(e instanceof Error ? e.stack : e);
    exitCode = 1;
  } finally {
    await stopApi();
    await admin.end().catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
