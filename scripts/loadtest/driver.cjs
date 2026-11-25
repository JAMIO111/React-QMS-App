/**
 * Plays a working day against the API. Each virtual person loops: do something a person of that role does, think, repeat. A day of `workingDaySec`
 * is squeezed into `run.durationSec` by dividing every think time and poll interval by `run.timeScale`, so the mix per person-hour is the real one and
 * only the pace is faster. Every call is labelled for the report: page: (interactive read), dash: (dashboard), write: (save), poll: (background polling).
 *
 * Think times below are real seconds. Numbers come from how the product is used: an inspector records a sample every few minutes while a job runs;
 * engineers and managers browse registers and dashboards; everyone's browser polls the badge counts every five minutes.
 */
const B = require('./bodies.cjs');
const { sleep, rng } = require('./stats.cjs');

const POLLS = [
  '/notifications?limit=100',
  '/workflow-tasks/mine?status=open',
  '/my-documents/count',
  '/quality-alerts/mine/count',
  '/risk-work/count',
  '/changes/mine/count',
  '/fmea-actions/mine?status=open',
  '/management-review-actions/mine?status=open',
  '/capa-actions/mine?status=open',
];
const POLL_EVERY_SEC = 300;

const range = () => ({ from: B.day(90), to: B.day(0) });
const qs = (o) => '?' + new URLSearchParams(o).toString();

function personas(state, profile, rec) {
  const r = rng(11);
  const hot = state.hotParts;
  const firstChar = 'D1';
  const picks = {
    part: () => r.pick(hot),
    anyPart: () => r.pick(state.parts),
    nc: () => r.pick(state.ncs),
    po: () => r.pick(state.purchaseOrders).id,
    supplier: () => r.pick(state.suppliers),
  };

  const reads = {
    ncrList: (u) => u.get('/ncrs' + qs({ page: 1, pageSize: 25 }), { label: 'page:ncr-list' }),
    ncrOne: (u) => u.get(`/ncrs/${picks.nc()}`, { label: 'page:ncr-detail' }),
    partsList: (u) => u.get('/parts' + qs({ page: 1, pageSize: 25, q: `LT-0${r.int(0, 9)}` }), { label: 'page:parts-search' }),
    partOne: (u) => u.get(`/parts/${picks.anyPart()}`, { label: 'page:part-detail' }),
    poList: (u) => u.get('/purchase-orders' + qs({ status: 'all', page: 1, pageSize: 25, q: `LTPO-${r.int(0, 9)}` }), { label: 'page:po-search' }),
    poOne: (u) => u.get(`/purchase-orders/${picks.po()}`, { label: 'page:po-detail' }),
    receipts: (u) => u.get('/goods-receipts' + qs({ page: 1, pageSize: 25 }), { label: 'page:receipts' }),
    suppliers: (u) => u.get('/supplier-quality/suppliers' + qs({ page: 1, pageSize: 25 }), { label: 'page:suppliers' }),
    inspections: (u) => u.get('/inspections' + qs({ page: 1, pageSize: 25 }), { label: 'page:inspections' }),
    spc: (u) => u.get('/spc/chart' + qs({ partId: picks.part(), characteristicKey: firstChar }), { label: 'dash:spc-chart', expect: [409, 422] }),
    spcAlerts: (u) => u.get('/spc/alerts?limit=50', { label: 'page:spc-alerts', expect: [403] }),
    ncDash: (u) => u.get('/ncr-dashboard' + qs(range()), { label: 'dash:ncr' }),
    pcDash: (u) => u.get('/process-control-dashboard' + qs(range()), { label: 'dash:process-control', expect: [403] }),
    home: (u) => u.get('/home-dashboard', { label: 'dash:home' }),
    supplierDash: (u) => u.get('/supplier-quality/dashboard' + qs(range()), { label: 'dash:supplier', expect: [403] }),
    me: (u) => u.get('/me', { label: 'page:me' }),
  };

  /** One pass of an inspector's job: start, record each planned sample (viewing the page first), complete. */
  async function inspection(u, rr, think, n) {
    const partId = rr.chance(profile.counts.hotInspectionShare) ? rr.pick(hot) : rr.pick(state.parts);
    const rec1 = (await u.post('/inspections', B.startInspection(1_000_000 + n, state.siteId, partId, profile.counts.lotSize), { label: 'write:inspection-start' })).json;
    const shift = rr.chance(profile.counts.shiftedShare) ? 3 : 0;
    for (const entry of rec1.schedule) {
      await sleep(think());
      await u.get(`/inspections/${rec1.id}`, { label: 'page:inspection' });
      await u.post(`/inspections/${rec1.id}/samples`, B.sampleBody(entry, rec1.requirements, state.gaugeIds, rr, shift), { label: 'write:sample' });
    }
    const detail = (await u.get(`/inspections/${rec1.id}`, { label: 'page:inspection' })).json;
    for (const m of detail.measurements ?? []) if (m.result === 'fail' && !m.supersededById && !m.acknowledgement) {
      await u.post(`/inspection-measurements/${m.id}/acknowledge`, { note: 'Load test: noted' }, { label: 'write:acknowledge', expect: [409] });
    }
    await u.post(`/inspections/${rec1.id}/complete`, {}, { label: 'write:inspection-complete', expect: [409] });
  }

  const mixes = {
    inspector: { think: 137, pause: 20, run: (u, rr, think, n) => inspection(u, rr, think, n) },
    engineer: {
      think: 40,
      steps: [
        [3, reads.spc], [2, reads.partOne], [2, reads.partsList], [2, reads.ncrList], [1, reads.ncrOne], [2, reads.pcDash],
        [1, reads.inspections], [1, reads.spcAlerts], [1, reads.home],
      ],
    },
    manager: {
      think: 60,
      steps: [
        [2, reads.ncDash], [2, reads.home], [1, reads.supplierDash], [1, reads.pcDash], [2, reads.ncrList], [2, reads.ncrOne],
        [2, reads.poList], [1, reads.poOne], [1, reads.receipts], [1, reads.suppliers],
      ],
      writes: [[1, (u) => u.post('/ncrs', B.nc(2_000_000 + r.int(0, 1e6), { siteId: state.siteId, partId: picks.anyPart(), categoryId: state.categoryId }, r), { label: 'write:ncr-create' })]],
    },
    viewer: { think: 90, steps: [[3, reads.home], [2, reads.ncrList], [1, reads.ncrOne], [1, reads.partsList], [1, reads.inspections]] },
  };

  const weighted = (arr, rr) => {
    const total = arr.reduce((a, [w]) => a + w, 0);
    let x = rr.next() * total;
    for (const [w, f] of arr) if ((x -= w) < 0) return f;
    return arr[0][1];
  };
  mixes.owner = mixes.manager;
  return { mixes, weighted, reads };
}

/**
 * @param o { api (client with recorder), state, profile, recorder, log, secret (cron), base, signal: { stop: boolean } }
 * Resolves when the day is over and every person has finished their current action.
 */
async function runDay(o) {
  const { api, state, profile, recorder, log } = o;
  const T = profile.run.timeScale;
  const { mixes, weighted, reads } = personas(state, profile, recorder);
  const deadline = Date.now() + profile.run.durationSec * 1000;
  const jitter = (rr, sec) => (sec * (0.5 + rr.next())) * 1000 / T; // real seconds -> compressed ms, +-50%
  let counter = 0;

  const person = async (p, idx) => {
    const u = api.as(p.id);
    const rr = rng(1000 + idx);
    const mix = mixes[p.role];
    await sleep(rr.next() * 5000); // people do not all start in the same millisecond
    await reads.me(u).catch(() => {});
    let nextPoll = Date.now() + rr.next() * POLL_EVERY_SEC * 1000 / T;
    while (Date.now() < deadline) {
      try {
        if (Date.now() >= nextPoll) {
          nextPoll = Date.now() + (POLL_EVERY_SEC * 1000) / T;
          for (const path of POLLS) await u.get(path, { label: `poll:${path.split('?')[0]}`, expect: [403] });
        }
        if (mix.run) await mix.run(u, rr, () => jitter(rr, mix.think), (counter += 1));
        else {
          const writes = mix.writes && rr.chance(0.08);
          await (writes ? weighted(mix.writes, rr) : weighted(mix.steps, rr))(u);
        }
      } catch (e) {
        // The request is already in the recorder with its status; keep the person going, as a real one would reload.
        if (o.verbose) log(`  ${p.role}: ${e.message}`);
      }
      await sleep(jitter(rr, mix.pause ?? mix.think));
    }
  };

  // The worker, called the way pg_cron calls it: every five minutes of the (real) day, so every 300/T seconds of the compressed one.
  const tickMs = profile.run.workerTickEverySec ? profile.run.workerTickEverySec * 1000 : (300 * 1000) / T;
  const ticker = (async () => {
    while (Date.now() < deadline) {
      await sleep(tickMs);
      if (Date.now() >= deadline) break;
      const t = performance.now();
      let status = 0;
      let text = '';
      try {
        const res = await fetch(`${o.base}/internal/worker/tick?source=pg_cron`, { method: 'POST', headers: { Authorization: `Bearer ${o.cronSecret}` } });
        status = res.status;
        text = await res.text();
      } catch (e) {
        text = String(e);
      }
      recorder.record('tick:worker', performance.now() - t, status, status === 200 ? 'ok' : 'server');
      if (status !== 200) recorder.note('tick:worker', text);
    }
  })();

  const people = state.people.filter((p) => mixes[p.role]);
  log(`day: ${people.length} people, ${profile.run.durationSec}s, time scale ${T.toFixed(1)}x`);
  await Promise.all([...people.map(person), ticker]);
}

module.exports = { runDay, POLLS };
