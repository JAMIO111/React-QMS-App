/** Measuring and reporting: samples the database, the API process and the machine while the day runs, then turns the numbers into a verdict. */
const fs = require('fs');
const os = require('os');
const { sleep } = require('./stats.cjs');

const MB = 1024 * 1024;

function procStat(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024; // MB
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(stat[11]) + Number(stat[12]); // utime + stime
    return { rssMb: rss, cpuSec: ticks / 100 };
  } catch {
    return null;
  }
}

class Sampler {
  constructor({ admin, apiPid, everyMs = 5000 }) {
    this.admin = admin;
    this.apiPid = apiPid;
    this.everyMs = everyMs;
    this.rows = [];
    this.running = false;
  }

  async once(t0) {
    const at = (Date.now() - t0) / 1000;
    const row = { at, load1: os.loadavg()[0], freeMb: os.freemem() / MB };
    const p = this.apiPid ? procStat(this.apiPid) : null;
    if (p) {
      row.apiRssMb = p.rssMb;
      if (this.lastCpu) row.apiCpuPct = ((p.cpuSec - this.lastCpu.cpuSec) / ((at - this.lastCpu.at) || 1)) * 100;
      this.lastCpu = { cpuSec: p.cpuSec, at };
    }
    try {
      const a = (await this.admin.query(`select count(*)::int total, count(*) filter (where state = 'active')::int active from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`)).rows[0];
      const d = (await this.admin.query(`select xact_commit + xact_rollback as xacts, blks_read, blks_hit, tup_returned, tup_fetched, deadlocks, temp_files, temp_bytes, pg_database_size(current_database()) as size from pg_stat_database where datname = current_database()`)).rows[0];
      Object.assign(row, { dbConns: a.total, dbActive: a.active, xacts: Number(d.xacts), blksRead: Number(d.blks_read), blksHit: Number(d.blks_hit), deadlocks: Number(d.deadlocks), tempBytes: Number(d.temp_bytes), dbBytes: Number(d.size) });
    } catch (e) {
      row.dbError = e.message;
    }
    this.rows.push(row);
  }

  start() {
    this.running = true;
    this.t0 = Date.now();
    this.loop = (async () => {
      while (this.running) {
        await this.once(this.t0);
        await sleep(this.everyMs);
      }
    })();
  }

  async stop() {
    this.running = false;
    await this.loop;
  }

  summary() {
    const rows = this.rows;
    const max = (k) => rows.reduce((m, r) => (r[k] !== undefined && r[k] > m ? r[k] : m), 0);
    const last = rows[rows.length - 1];
    const first = rows[0];
    const secs = last && first ? last.at - first.at || 1 : 1;
    const hit = last && first ? (last.blksHit - first.blksHit) / Math.max(1, last.blksHit - first.blksHit + (last.blksRead - first.blksRead)) : null;
    return {
      samples: rows.length,
      apiRssMaxMb: max('apiRssMb'),
      apiCpuMaxPct: max('apiCpuPct'),
      load1Max: max('load1'),
      dbConnsMax: max('dbConns'),
      dbActiveMax: max('dbActive'),
      deadlocks: last?.deadlocks ?? 0,
      tempBytes: last?.tempBytes ?? 0,
      cacheHitRatio: hit,
      transactionsPerSecond: last && first ? (last.xacts - first.xacts) / secs : null,
      dbGrowthMb: last && first ? (last.dbBytes - first.dbBytes) / MB : null,
    };
  }
}

/** Row counts and on-disk sizes of what the seed built; the bytes per reading are what the capacity assessment's storage figure is based on. */
async function tableReport(admin) {
  const tables = ['inspection_records', 'inspection_samples', 'inspection_measurements', 'spc_alerts', 'nonconformances', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'parts', 'part_revisions', 'lots', 'outbox_events'];
  const out = [];
  for (const t of tables) {
    try {
      const r = (await admin.query(`select (select count(*) from public.${t})::bigint as n, pg_total_relation_size('public.${t}') as bytes`)).rows[0];
      out.push({ table: t, rows: Number(r.n), mb: Number(r.bytes) / MB });
    } catch {
      /* a table that does not exist in this version is simply not reported */
    }
  }
  const a = (await admin.query(`select count(*)::bigint n, pg_total_relation_size('audit.events') bytes from audit.events`)).rows[0];
  out.push({ table: 'audit.events', rows: Number(a.n), mb: Number(a.bytes) / MB });
  const size = (await admin.query('select pg_database_size(current_database()) b')).rows[0].b;
  const readings = out.find((x) => x.table === 'inspection_measurements')?.rows ?? 0;
  const perReading = readings ? ((out.find((x) => x.table === 'inspection_measurements').mb + (out.find((x) => x.table === 'audit.events').mb)) * MB) / readings : null;
  return { tables: out, databaseMb: Number(size) / MB, readings, bytesPerReadingIncludingAudit: perReading };
}

/** The slowest statements, when pg_stat_statements is installed in the database (it is a bonus; a missing extension is not an error). */
async function slowStatements(admin) {
  try {
    const { rows } = await admin.query(`select left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query, calls::bigint, round(total_exec_time::numeric) as total_ms, round(mean_exec_time::numeric, 1) as mean_ms from pg_stat_statements order by total_exec_time desc limit 12`);
    return rows;
  } catch {
    return null;
  }
}

function evaluate(rows, thresholds) {
  const checks = [];
  const group = (prefix) => rows.filter((r) => r.label.startsWith(prefix));
  for (const [prefix, t] of Object.entries(thresholds)) {
    if (prefix === 'errorRate') continue;
    for (const r of group(prefix)) {
      const ok = r.p95 !== null && r.p95 <= t.p95;
      checks.push({ label: r.label, metric: 'p95', value: r.p95, limit: t.p95, ok });
    }
  }
  const total = rows.reduce((a, r) => a + r.count, 0);
  const bad = rows.reduce((a, r) => a + r.server + r.client, 0);
  const rate = total ? bad / total : 0;
  checks.push({ label: 'all requests', metric: 'error rate', value: rate, limit: thresholds.errorRate, ok: rate <= thresholds.errorRate });
  return { checks, ok: checks.every((c) => c.ok), errorRate: rate, total, bad };
}

const ms = (v) => (v === null || v === undefined ? '–' : `${Math.round(v)}`);
const f1 = (v) => (v === null || v === undefined ? '–' : Number(v).toFixed(1));

function render({ meta, seedReport, summaryRows, verdict, sampler, slow, notes }) {
  const L = [];
  L.push(`# Load test report`);
  L.push('');
  L.push(`**Verdict: ${verdict.ok ? 'PASS' : 'FAIL'}** — ${verdict.total} requests, ${verdict.bad} failed (${(verdict.errorRate * 100).toFixed(3)} %).`);
  L.push('');
  L.push(`| | |`);
  L.push(`|---|---|`);
  for (const [k, v] of Object.entries(meta)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push(`## What was measured against what`);
  L.push('');
  for (const c of verdict.checks.filter((x) => !x.ok)) L.push(`- **FAILED** ${c.label} ${c.metric}: ${c.metric === 'error rate' ? (c.value * 100).toFixed(3) + ' %' : ms(c.value) + ' ms'} (limit ${c.metric === 'error rate' ? (c.limit * 100).toFixed(3) + ' %' : c.limit + ' ms'})`);
  if (verdict.ok) L.push('- Every label met its limit.');
  L.push('');
  L.push(`## Requests`);
  L.push('');
  L.push(`| label | count | /s | mean | p50 | p95 | p99 | max | 5xx | 4xx | allowed 4xx | statuses |`);
  L.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|`);
  for (const r of summaryRows) {
    L.push(`| ${r.label} | ${r.count} | ${f1(r.perSecond)} | ${ms(r.mean)} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.max)} | ${r.server} | ${r.client} | ${r.expected} | ${JSON.stringify(r.statuses)} |`);
  }
  const problems = summaryRows.filter((r) => r.firstProblem);
  if (problems.length) {
    L.push('');
    L.push(`### First problem per label`);
    for (const r of problems) L.push(`- \`${r.label}\` → ${r.firstProblem.status}: ${String(r.firstProblem.text ?? '').replace(/\s+/g, ' ')}`);
  }
  L.push('');
  L.push(`## Database and API during the day`);
  L.push('');
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| API memory, peak | ${f1(sampler.apiRssMaxMb)} MB |`);
  L.push(`| API CPU, peak (100 = one core) | ${f1(sampler.apiCpuMaxPct)} % |`);
  L.push(`| Database connections, peak (active) | ${sampler.dbConnsMax} (${sampler.dbActiveMax}) |`);
  L.push(`| Transactions per second, mean | ${f1(sampler.transactionsPerSecond)} |`);
  L.push(`| Cache hit ratio | ${sampler.cacheHitRatio === null ? '–' : (sampler.cacheHitRatio * 100).toFixed(2) + ' %'} |`);
  L.push(`| Deadlocks | ${sampler.deadlocks} |`);
  L.push(`| Temp file bytes written | ${sampler.tempBytes} |`);
  L.push(`| Database growth during the day | ${f1(sampler.dbGrowthMb)} MB |`);
  L.push(`| Machine load average, peak | ${f1(sampler.load1Max)} |`);
  L.push('');
  if (seedReport) {
    L.push(`## What the seed built`);
    L.push('');
    L.push(`| table | rows | size (MB) |`);
    L.push(`|---|---:|---:|`);
    for (const t of seedReport.tables) L.push(`| ${t.table} | ${t.rows} | ${f1(t.mb)} |`);
    L.push('');
    L.push(`Database total: **${f1(seedReport.databaseMb)} MB**. Readings: ${seedReport.readings}. Bytes per reading including its audit rows: **${seedReport.bytesPerReadingIncludingAudit ? Math.round(seedReport.bytesPerReadingIncludingAudit) : '–'}** (the capacity assessment assumed about 1,900).`);
    L.push('');
  }
  if (slow) {
    L.push(`## Slowest statements (pg_stat_statements)`);
    L.push('');
    L.push(`| total ms | calls | mean ms | statement |`);
    L.push(`|---:|---:|---:|---|`);
    for (const s of slow) L.push(`| ${s.total_ms} | ${s.calls} | ${s.mean_ms} | ${String(s.query).replace(/\|/g, '\\|')} |`);
    L.push('');
  }
  L.push(`## How to read this`);
  L.push('');
  for (const n of notes) L.push(`- ${n}`);
  L.push('');
  return L.join('\n');
}

module.exports = { Sampler, tableReport, slowStatements, evaluate, render };
