const test = require('node:test');
const assert = require('node:assert');
const { Recorder, rng, pool } = require('./stats.cjs');
const { evaluate } = require('./report.cjs');
const { load } = require('./profile.cjs');
const B = require('./bodies.cjs');

test('percentiles come from the sorted timings', () => {
  const r = new Recorder();
  for (let i = 1; i <= 100; i += 1) r.record('page:x', i, 200, 'ok');
  const [row] = r.summary(10);
  assert.equal(row.p50, 50);
  assert.equal(row.p95, 95);
  assert.equal(row.count, 100);
});

test('a warm-up period is not measured', () => {
  const r = new Recorder();
  r.measuring = false;
  r.record('page:x', 5000, 200, 'ok');
  assert.equal(r.summary(1).length, 0);
});

test('the generator repeats for the same seed', () => {
  const a = rng(7);
  const b = rng(7);
  assert.deepEqual([a.int(0, 1e6), a.int(0, 1e6)], [b.int(0, 1e6), b.int(0, 1e6)]);
});

test('the verdict fails on a slow label and on errors, and allowed 4xx do not count', () => {
  const t = { 'page:': { p95: 1000 }, 'dash:': { p95: 3000 }, errorRate: 0.001 };
  const row = (label, p95, extra = {}) => ({ label, count: 1000, p95, server: 0, client: 0, expected: 0, ...extra });
  assert.equal(evaluate([row('page:a', 900), row('dash:b', 2500)], t).ok, true);
  assert.equal(evaluate([row('page:a', 1200)], t).ok, false);
  assert.equal(evaluate([row('page:a', 100, { server: 5 })], t).ok, false);
  assert.equal(evaluate([row('page:a', 100, { expected: 500 })], t).ok, true);
});

test('pool never runs more than n at once and surfaces the first failure', async () => {
  let live = 0;
  let peak = 0;
  await pool([1, 2, 3, 4, 5, 6], 2, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live -= 1;
  });
  assert.equal(peak, 2);
  await assert.rejects(pool([1, 2], 1, async (i) => { if (i === 2) throw new Error('boom'); }), /boom/);
});

test('the profiles scale and keep the client shape', () => {
  const day = load({});
  assert.equal(day.counts.parts, 10000);
  assert.equal(day.counts.purchaseOrders, 100000);
  assert.equal(day.users.owner + day.users.managers + day.users.engineers + day.users.inspectors + day.users.viewers, 30);
  assert.equal(Math.round(day.run.timeScale), 16);
  const smoke = load({ LOADTEST_PROFILE: 'smoke' });
  assert.ok(smoke.counts.parts < 100);
  assert.throws(() => load({ LOADTEST_PROFILE: 'nope' }), /Unknown/);
});

test('a sample body gives every requirement of its schedule entry one reading, and a gauge where the check names a gauge type', () => {
  const r = rng(1);
  const reqs = [
    { id: 'a', nominal: 10, lowerLimit: 9.9, upperLimit: 10.1, gaugeType: { id: 'g' } },
    { id: 'b', nominal: null, lowerLimit: null, upperLimit: null, gaugeType: null },
  ];
  const body = B.sampleBody({ position: 1, trigger: 'first_off', requirementIds: ['a', 'b'] }, reqs, ['gauge-1'], r);
  assert.equal(body.readings.length, 2);
  assert.equal(body.readings[0].gaugeId, 'gauge-1');
  assert.equal(typeof body.readings[0].valueNumeric, 'string');
  assert.equal(typeof body.readings[1].valuePass, 'boolean');
});
