/** Collects request timings per label and turns them into percentiles. Pure; no I/O. */
class Recorder {
  constructor() {
    this.by = new Map();
    this.startedAt = Date.now();
    this.measuring = true;
  }

  /** `kind`: 'ok' | 'server' (5xx / network) | 'client' (4xx that the harness did not expect) | 'expected' (a 4xx the scenario allows). */
  record(label, ms, status, kind) {
    if (!this.measuring) return;
    let e = this.by.get(label);
    if (!e) this.by.set(label, (e = { ms: [], ok: 0, server: 0, client: 0, expected: 0, statuses: new Map(), first: null }));
    e.ms.push(ms);
    e[kind] += 1;
    e.statuses.set(status, (e.statuses.get(status) ?? 0) + 1);
    if (kind !== 'ok' && kind !== 'expected' && !e.first) e.first = { status };
  }

  /** Remember the first problem body per label, to show in the report. */
  note(label, text) {
    const e = this.by.get(label);
    if (e && e.first && !e.first.text) e.first.text = String(text).slice(0, 400);
  }

  static percentile(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i];
  }

  summary(seconds) {
    const rows = [];
    for (const [label, e] of this.by) {
      const sorted = Float64Array.from(e.ms).sort();
      const n = sorted.length;
      const mean = n ? e.ms.reduce((a, b) => a + b, 0) / n : 0;
      rows.push({
        label,
        count: n,
        perSecond: seconds > 0 ? n / seconds : 0,
        mean,
        p50: Recorder.percentile(sorted, 50),
        p95: Recorder.percentile(sorted, 95),
        p99: Recorder.percentile(sorted, 99),
        max: n ? sorted[n - 1] : null,
        server: e.server,
        client: e.client,
        expected: e.expected,
        statuses: Object.fromEntries([...e.statuses].sort((a, b) => a[0] - b[0])),
        firstProblem: e.first,
      });
    }
    rows.sort((a, b) => a.label.localeCompare(b.label));
    return rows;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn(item, index)` over `items` with at most `n` in flight; rejects on the first failure after letting running ones finish. */
async function pool(items, n, fn) {
  let next = 0;
  let failure;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (failure === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await fn(items[i], i);
      } catch (e) {
        failure = failure ?? e;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
}

/** A small repeatable random generator (mulberry32) so a seeded year is the same every time for the same seed. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Standard normal (Box–Muller). */
    normal: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
    chance: (p) => next() < p,
  };
  return r;
}

module.exports = { Recorder, sleep, pool, rng };
