/**
 * Builds the client's year in the throwaway database: one organisation, its people, then everything else through the real API so every rule, trigger,
 * audit event and outbox row is the production one. Only the organisation and people (which a person creates by signing up) are made with SQL, and an
 * optional "redate" at the end spreads the timestamps over the year so time-based queries (dashboards, SPC windows, expiry) see a year, not an hour.
 *
 * Stages are recorded in the state file as they finish, so a stopped seed resumes at the stage it was in (a stage that was half done is repeated from
 * its start: the loops skip what already exists by number/code).
 */
const B = require('./bodies.cjs');
const { pool, rng } = require('./stats.cjs');
const { SLUG_PREFIX } = require('./guard.cjs');

const uuid = (kind, n) => `10ad0000-${String(kind).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = uuid(1, 1);
const SITE = uuid(2, 1);

function planPeople(profile) {
  const u = profile.users;
  const people = [];
  let n = 0;
  const add = (role, roleKey, count) => {
    for (let i = 0; i < count; i += 1) people.push({ id: uuid(10, (n += 1)), role, roleKey, email: `${role}${i + 1}@loadtest.example` });
  };
  add('owner', 'owner', u.owner);
  add('manager', 'quality_manager', u.managers);
  add('engineer', 'quality_engineer', u.engineers);
  add('inspector', 'inspector', u.inspectors);
  add('viewer', 'viewer', u.viewers);
  return people;
}

async function seedOrganisation(admin, people) {
  const exists = await admin.query('select 1 from public.organisations where id = $1', [ORG]);
  if (exists.rowCount) return;
  await admin.query('begin');
  try {
    await admin.query(`insert into auth.users (id, email) select id::uuid, email from unnest($1::text[], $2::text[]) as t(id, email)`, [people.map((p) => p.id), people.map((p) => p.email)]);
    await admin.query(`insert into public.organisations (id, name, slug) values ($1, 'Load Test Precision', $2)`, [ORG, `${SLUG_PREFIX}main`]);
    await admin.query(`insert into public.organisation_settings (organisation_id, base_currency, vat_rate) values ($1, 'GBP', 0.2)`, [ORG]);
    await admin.query('select app.create_default_roles($1)', [ORG]);
    await admin.query(`insert into public.sites (id, organisation_id, code, name) values ($1, $2, 'MAIN', 'Main plant')`, [SITE, ORG]);
    for (const p of people) {
      const { rows } = await admin.query(`insert into public.organisation_users (organisation_id, user_id, status, joined_at) values ($1, $2, 'active', now()) returning id`, [ORG, p.id]);
      await admin.query(`insert into public.user_role_assignments (organisation_id, membership_id, role_id) select $1, $2, id from public.roles where organisation_id = $1 and key = $3`, [ORG, rows[0].id, p.roleKey]);
    }
    await admin.query('commit');
  } catch (e) {
    await admin.query('rollback');
    throw e;
  }
}

/**
 * @param ctx { admin, api (client), profile, state (mutable, saved by save()), save(), log(msg), only?: stage name }
 */
async function seed(ctx) {
  const { admin, api, profile, state, save, log } = ctx;
  const { counts, run } = profile;
  const conc = run.seedConcurrency;
  const r = rng(20261125);
  const done = (s) => state.stages?.includes(s);
  const finish = async (s) => {
    (state.stages ??= []).push(s);
    await save();
    log(`seed: ${s} done`);
  };
  const timeStage = async (name, fn) => {
    if (done(name)) return log(`seed: ${name} already done`);
    const t = Date.now();
    log(`seed: ${name} …`);
    await fn();
    (state.timings ??= {})[name] = Math.round((Date.now() - t) / 1000);
    await finish(name);
  };

  const people = planPeople(profile);
  state.people = people;
  state.orgId = ORG;
  state.siteId = SITE;
  const by = (role) => people.filter((p) => p.role === role).map((p) => p.id);
  const owner = by('owner')[0];
  const manager = by('manager')[0];
  const A = api.as(owner);
  const M = api.as(manager);

  await timeStage('organisation', () => seedOrganisation(admin, people));

  await timeStage('structure', async () => {
    const type = (await A.post('/gauge-types', B.gaugeType())).json;
    state.gaugeTypeId = type.id;
    state.gaugeIds = [];
    for (let i = 1; i <= counts.gauges; i += 1) state.gaugeIds.push((await A.post('/gauges', B.gauge(i, type.id, SITE))).json.id);
    const cats = (await A.get('/ncr-classifications?kind=category')).json.data;
    state.categoryId = (cats.find((c) => c.code === 'PRODUCT') ?? cats[0]).id;
    state.families = [];
    await pool(Array.from({ length: counts.families }, (_, i) => i + 1), conc, async (i) => {
      const fam = (await A.post('/part-families', B.family(i))).json;
      const plan = (await A.post('/control-plans', B.plan(i, fam.id))).json;
      const revId = plan.revisions[0].id;
      const rev = (await A.post(`/control-plan-revisions/${revId}/operations`, B.operation())).json;
      const opId = rev.operations[0].id;
      for (let k = 0; k < counts.checksPerPlan; k += 1) await A.post(`/control-plan-revisions/${revId}/characteristics`, B.characteristic(k, opId, type.id, counts.measuredChecks));
      await A.patch(`/control-plan-revisions/${revId}`, { changeReason: 'Load test plan' });
      await A.post(`/control-plan-revisions/${revId}/transitions`, { action: 'submit' });
      await M.post(`/control-plan-revisions/${revId}/transitions`, { action: 'approve' });
      state.families.push({ id: fam.id, index: i });
    });
  });

  await timeStage('parts', async () => {
    state.parts = [];
    const idx = Array.from({ length: counts.parts }, (_, i) => i + 1);
    await pool(idx, conc, async (i) => {
      const fam = state.families[i % state.families.length];
      const p = (await A.post('/parts', B.part(i, fam.id))).json;
      await A.post(`/part-revisions/${p.revisions[0].id}/release`, {});
      state.parts.push(p.id);
    });
    // The hot parts take most of the inspections, as real runners do.
    const hot = Math.max(3, Math.round(state.parts.length * counts.hotPartShare));
    state.hotParts = state.parts.slice(0, hot);
  });

  await timeStage('suppliers', async () => {
    state.suppliers = [];
    await pool(Array.from({ length: counts.suppliers }, (_, i) => i + 1), conc, async (i) => {
      state.suppliers.push((await A.post('/supplier-quality/suppliers', B.supplier(i))).json.id);
    });
  });

  await timeStage('purchase-orders', async () => {
    state.purchaseOrders = [];
    await pool(Array.from({ length: counts.purchaseOrders }, (_, i) => i + 1), conc, async (i) => {
      const sup = state.suppliers[i % state.suppliers.length];
      const body = B.purchaseOrder(i, sup, state.parts.slice(0, 2000), rng(i), counts.poLinesPerOrder);
      const po = (await A.post('/purchase-orders', body)).json;
      state.purchaseOrders.push({ id: po.id, supplierId: sup, lines: po.lines.map((l) => ({ id: l.id, quantity: Number(l.quantityOrdered) })) });
    });
  });

  await timeStage('receipts', async () => {
    const wanted = Math.round(counts.purchaseOrders * counts.receiptShare);
    const chosen = state.purchaseOrders.slice(0, wanted);
    await pool(chosen, conc, async (po, i) => {
      await A.post('/goods-receipts', B.receipt(i + 1, po.supplierId, po.id, po.lines, rng(i + 99)), { expect: [409] });
    });
  });

  await timeStage('non-conformances', async () => {
    state.ncs = [];
    await pool(Array.from({ length: counts.ncs }, (_, i) => i + 1), conc, async (i) => {
      const partId = state.parts[r.int(0, state.parts.length - 1)];
      const nc = (await A.post('/ncrs', B.nc(i, { siteId: SITE, partId, categoryId: state.categoryId }, rng(i + 7)))).json;
      state.ncs.push(nc.id);
    });
  });

  await timeStage('inspections', async () => {
    const hot = state.hotParts;
    const cold = state.parts.slice(hot.length);
    const inspectors = by('inspector');
    const total = counts.inspections;
    const idx = Array.from({ length: total }, (_, i) => i + 1);
    let acknowledged = 0;
    await pool(idx, conc, async (i) => {
      const rr = rng(i * 7919);
      const partId = rr.chance(counts.hotInspectionShare) ? rr.pick(hot) : rr.pick(cold.length ? cold : hot);
      const who = api.as(rr.pick(inspectors));
      const shift = rr.chance(counts.shiftedShare) ? rr.pick([-1, 1]) * rr.int(2, 4) : 0;
      const rec = (await who.post('/inspections', B.startInspection(i, SITE, partId, counts.lotSize))).json;
      for (const entry of rec.schedule) {
        await who.post(`/inspections/${rec.id}/samples`, B.sampleBody(entry, rec.requirements, state.gaugeIds, rr, shift));
      }
      if (shift) {
        // Acknowledge what failed, as a person would before they can complete.
        const detail = (await who.get(`/inspections/${rec.id}`)).json;
        for (const m of detail.measurements ?? []) if (m.result === 'fail' && !m.supersededById && !m.acknowledgement) {
          await who.post(`/inspection-measurements/${m.id}/acknowledge`, { note: 'Load test: noted' }, { expect: [409] });
          acknowledged += 1;
        }
      }
      await who.post(`/inspections/${rec.id}/complete`, {}, { expect: [409] });
    });
    state.acknowledged = acknowledged;
  });

  if (ctx.redate) {
    await timeStage('redate', async () => {
      await redate(admin, counts.daysSpread, log);
    });
  }

  await timeStage('analyse', async () => {
    for (const t of ['inspection_records', 'inspection_samples', 'inspection_measurements', 'nonconformances', 'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'spc_alerts', 'parts', 'part_revisions']) {
      await admin.query(`vacuum (analyze) public.${t}`);
    }
    await admin.query('vacuum (analyze) audit.events');
  });

  state.seeded = true;
  await save();
  return state;
}

/**
 * Spreads the timestamps of the seeded records over `days` days. It writes with triggers off (`session_replication_role = replica`) because it is
 * rewriting history, not recording an action; nothing else in the harness does this.
 */
async function redate(admin, days, log) {
  const c = await admin.connect();
  try {
    await c.query(`set session_replication_role = replica`);
    const step = async (name, sql) => {
      const t = Date.now();
      const res = await c.query(sql, [days]);
      log(`redate: ${name} (${res.rowCount} rows, ${Math.round((Date.now() - t) / 1000)} s)`);
    };
    await step('inspections', `update public.inspection_records set started_at = now() - (abs(hashtext(id::text)) % $1) * interval '1 day' - (abs(hashtext(id::text || 'h')) % 28800) * interval '1 second', created_at = started_at, completed_at = case when completed_at is null then null else started_at + interval '40 minutes' end, updated_at = coalesce(completed_at, started_at)`);
    await step('samples', `update public.inspection_samples s set sampled_at = r.started_at + s.sample_number * interval '7 minutes', created_at = r.started_at + s.sample_number * interval '7 minutes', updated_at = r.started_at + s.sample_number * interval '7 minutes' from public.inspection_records r where r.id = s.inspection_record_id and $1 > 0`);
    await step('measurements', `update public.inspection_measurements m set measured_at = s.sampled_at, created_at = s.sampled_at, updated_at = s.sampled_at from public.inspection_samples s where s.id = m.sample_id and $1 > 0`);
    await step('spc alerts', `update public.spc_alerts a set point_at = m.measured_at, created_at = m.measured_at, updated_at = m.measured_at from public.inspection_measurements m where m.inspection_record_id = a.inspection_record_id and a.point_at is not null and $1 > 0`).catch((e) => log(`redate: spc alerts skipped (${e.message})`));
    await step('non-conformances', `update public.nonconformances set created_at = detected_at::timestamptz + interval '9 hours', updated_at = detected_at::timestamptz + interval '9 hours' where $1 > 0`);
    await step('purchase orders', `update public.purchase_orders set created_at = ordered_on::timestamptz + interval '9 hours', updated_at = ordered_on::timestamptz + interval '9 hours' where $1 > 0`);
    await step('goods receipts', `update public.goods_receipts set created_at = received_on::timestamptz + interval '10 hours', updated_at = received_on::timestamptz + interval '10 hours' where $1 > 0`);
    await step('audit trail', `update audit.events e set created_at = x.at from (
        select r.id::text as id, r.started_at as at from public.inspection_records r
        union all select s.id::text, s.sampled_at from public.inspection_samples s
        union all select m.id::text, m.measured_at from public.inspection_measurements m
      ) x where e.entity_id = x.id and e.entity_type in ('inspection_records','inspection_samples','inspection_measurements') and $1 > 0`);
  } finally {
    await c.query(`set session_replication_role = origin`).catch(() => {});
    c.release();
  }
}

module.exports = { seed, redate, ORG, SITE, uuid, planPeople };
