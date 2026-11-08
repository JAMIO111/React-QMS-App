/**
 * The audit schedule through the API (AU2): slots made when the schedule is read, upcoming / overdue / missed worked out from the dates and the grace period, counts, filters,
 * skipping with a reason, retired and on-demand audits, a changed frequency, and who may do what. The generation rules are in supabase/tests/audit_schedule.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a2');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const schedule = async (query = '', h?: Record<string, string>) => (await api().get(`/api/v1/audit-schedule${query}`).set(h ?? (await as(ids.ownerA))).expect(200)).body;
const make = async (over: object) =>
  (await api().post('/api/v1/audits').set(await as(ids.ownerA)).send({ title: 'x', auditType: 'process', frequency: { kind: 'weekly', firstDueOn: day(-20) }, graceDays: 2, ...over }).expect(201)).body.id as string;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sch');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.machine = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-1', name: 'Lathe' }).expect(201)).body.id;
  ctx.machine2 = (await api().post('/api/v1/machines').set(h).send({ code: 'CNC-2', name: 'Mill' }).expect(201)).body.id;
  // A weekly audit with 2 days' grace, due 17, 10 and 3 days ago, then in 4 days … and one with 10 days' grace first due 5 days ago.
  ctx.weekly = await make({ title: 'Weekly LPA', frequency: { kind: 'weekly', firstDueOn: day(-17) }, targets: [{ kind: 'machine', machineId: ctx.machine }] });
  ctx.slow = await make({ title: 'Slow monthly', frequency: { kind: 'monthly', firstDueOn: day(-5) }, graceDays: 10, targets: [{ kind: 'operation', operationCode: 'OP-20' }, { kind: 'machine', machineId: ctx.machine2 }] });
  ctx.onDemand = await make({ title: 'On request', frequency: { kind: 'on_demand' } });
  // They were defined a month ago, so that earlier slots can have been missed.
  await admin.query(`update public.audit_definitions set created_at = now() - interval '60 days' where organisation_id = $1`, [ids.orgA]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('reading the schedule', () => {
  it('makes the slots and works out what is missed, overdue and coming up', async () => {
    const s = await schedule();
    expect(s.today).toBe(day(0));
    expect(s.window).toEqual({ from: day(-30), to: day(30) });
    const weekly = s.data.filter((i: { audit: { id: string } }) => i.audit.id === ctx.weekly);
    expect(weekly.map((i: { dueOn: string; state: string }) => `${i.dueOn}:${i.state}`)).toEqual([
      `${day(-17)}:missed`,
      `${day(-10)}:missed`,
      `${day(-3)}:missed`,
      `${day(4)}:upcoming`,
      `${day(11)}:upcoming`,
      `${day(18)}:upcoming`,
      `${day(25)}:upcoming`,
    ]);
    expect(weekly[0]).toMatchObject({ daysFromToday: -17, graceDays: 2, audit: { reference: 'AUD-001', title: 'Weekly LPA', passMark: 100, relevantTo: ['CNC-1'] } });
    const slow = s.data.find((i: { audit: { id: string } }) => i.audit.id === ctx.slow);
    expect(slow).toMatchObject({ dueOn: day(-5), state: 'overdue', graceDays: 10 });
    expect(slow.audit.relevantTo).toEqual(['CNC-2', 'OP-20']);
    expect(s.data.some((i: { audit: { id: string } }) => i.audit.id === ctx.onDemand)).toBe(false);
    expect(s.data.map((i: { dueOn: string }) => i.dueOn)).toEqual([...s.data.map((i: { dueOn: string }) => i.dueOn)].sort());
    expect(s.counts).toMatchObject({ missed: 3, overdue: 1, upcoming: 5, dueNext7Days: 1, skipped: 0 });
    expect(s.counts.total).toBe(s.data.length);
    expect(s.truncated).toBe(false);
  });

  it('is repeatable and does not make a slot twice', async () => {
    const a = await schedule();
    const b = await schedule();
    expect(b.data.map((i: { id: string }) => i.id)).toEqual(a.data.map((i: { id: string }) => i.id));
  });

  it('shows another window, and only what is asked for', async () => {
    const h = await as(ids.ownerA);
    const missed = await schedule('?state=missed', h);
    expect(missed.data.map((i: { dueOn: string }) => i.dueOn)).toEqual([day(-17), day(-10), day(-3)]);
    expect((await schedule('?state=overdue,upcoming&to=' + day(5))).data.map((i: { state: string }) => i.state).sort()).toEqual(['overdue', 'upcoming']);
    expect((await schedule(`?auditId=${ctx.slow}`)).data.every((i: { audit: { id: string } }) => i.audit.id === ctx.slow)).toBe(true);
    expect((await schedule(`?machineId=${ctx.machine}`)).data.every((i: { audit: { id: string } }) => i.audit.id === ctx.weekly)).toBe(true);
    expect(new Set((await schedule(`?machineId=${ctx.machine2}`)).data.map((i: { audit: { id: string } }) => i.audit.id))).toEqual(new Set([ctx.slow]));
    expect(new Set((await schedule('?operationCode=op-20')).data.map((i: { audit: { id: string } }) => i.audit.id))).toEqual(new Set([ctx.slow]));
    const wide = await schedule(`?from=${day(-60)}&to=${day(0)}`);
    expect(wide.window).toEqual({ from: day(-60), to: day(0) });
    expect(wide.data[0].dueOn >= day(-60)).toBe(true);
    expect(wide.data.every((i: { dueOn: string }) => i.dueOn <= day(0))).toBe(true);
    await api().get(`/api/v1/audit-schedule?from=${day(5)}&to=${day(1)}`).set(h).expect(400);
    await api().get(`/api/v1/audit-schedule?from=${day(-500)}&to=${day(0)}`).set(h).expect(400);
    await api().get('/api/v1/audit-schedule?from=tomorrow').set(h).expect(400);
    await api().get('/api/v1/audit-schedule?state=done2').set(h).expect(400);
    await api().get('/api/v1/audit-schedule?surprise=1').set(h).expect(400);
  });

  it('can be read by people who may read audits, and is closed to other organisations', async () => {
    expect((await schedule('', await as(ids.inspectorA))).counts.total).toBeGreaterThan(0);
    await api().get('/api/v1/audit-schedule').set(await as(ids.outsider)).expect(404);
    expect((await schedule('', await as(ids.ownerB, ids.orgB))).data).toEqual([]);
  });
});

describe('skipping', () => {
  it('needs the right to manage audits and a reason, and a skipped slot is not missed', async () => {
    const h = await as(ids.ownerA);
    const slot = (await schedule('?state=missed', h)).data[0];
    await api().post(`/api/v1/audit-occurrences/${slot.id}/skip`).set(await as(ids.inspectorA)).send({ reason: 'Machine down' }).expect(403);
    await api().post(`/api/v1/audit-occurrences/${slot.id}/skip`).set(h).send({}).expect(400);
    await api().post(`/api/v1/audit-occurrences/${slot.id}/skip`).set(h).send({ reason: '  ' }).expect(400);
    const skipped = (await api().post(`/api/v1/audit-occurrences/${slot.id}/skip`).set(h).send({ reason: 'Machine down for repair' }).expect(200)).body;
    expect(skipped).toMatchObject({ id: slot.id, state: 'skipped', skippedReason: 'Machine down for repair' });
    const again = await api().post(`/api/v1/audit-occurrences/${slot.id}/skip`).set(h).send({ reason: 'again' }).expect(409);
    expect(again.body.error).toMatchObject({ code: 'audit_rule', message: expect.stringContaining('already skipped') });
    const s = await schedule('', h);
    expect(s.counts).toMatchObject({ missed: 2, skipped: 1 });
    await api().post(`/api/v1/audit-occurrences/${slot.id}/skip`).set(await as(ids.ownerB, ids.orgB)).send({ reason: 'x' }).expect(404);
    const back = (await api().post(`/api/v1/audit-occurrences/${slot.id}/unskip`).set(h).expect(200)).body;
    expect(back).toMatchObject({ state: 'missed', skippedReason: null });
    await api().post(`/api/v1/audit-occurrences/${slot.id}/unskip`).set(h).expect(409);
    await api().post('/api/v1/audit-occurrences/00000000-0000-4000-8000-000000000001/skip').set(h).send({ reason: 'x' }).expect(404);
  });
});

describe('changes to an audit', () => {
  it('stop a retired audit being scheduled further, keep its past, and follow a changed frequency', async () => {
    const h = await as(ids.ownerA);
    const own = await make({ title: 'To be retired', frequency: { kind: 'weekly', firstDueOn: day(0) } });
    await admin.query(`update public.audit_definitions set created_at = now() - interval '10 days' where id = $1`, [own]);
    const before = (await schedule(`?auditId=${own}&to=${day(28)}`, h)).data;
    expect(before.length).toBe(5);
    await api().post(`/api/v1/audits/${own}/retire`).set(h).send({ reason: 'No longer needed' }).expect(200);
    const after = (await schedule(`?auditId=${own}&to=${day(60)}`, h)).data;
    // Retired: what is past or today stays, the future is gone.
    expect(after.map((i: { dueOn: string }) => i.dueOn)).toEqual([day(0)]);

    // Weekly becomes monthly: slots that no longer fit disappear from the future, the past stays.
    const before2 = (await schedule(`?auditId=${ctx.weekly}&to=${day(30)}`, h)).data;
    await api().patch(`/api/v1/audits/${ctx.weekly}`).set(h).send({ frequency: { kind: 'monthly', firstDueOn: day(40) } }).expect(200);
    const after2 = (await schedule(`?auditId=${ctx.weekly}&to=${day(60)}`, h)).data;
    expect(after2.filter((i: { dueOn: string }) => i.dueOn <= day(0)).map((i: { dueOn: string }) => i.dueOn)).toEqual(before2.filter((i: { dueOn: string }) => i.dueOn <= day(0)).map((i: { dueOn: string }) => i.dueOn));
    expect(after2.filter((i: { dueOn: string }) => i.dueOn > day(0)).map((i: { dueOn: string }) => i.dueOn)).toEqual([day(40)]);
    // An audit that becomes on demand has no future slots.
    await api().patch(`/api/v1/audits/${ctx.weekly}`).set(h).send({ frequency: { kind: 'on_demand' } }).expect(200);
    expect((await schedule(`?auditId=${ctx.weekly}&from=${day(1)}&to=${day(60)}`, h)).data).toEqual([]);
  });
});

describe('the grace period', () => {
  it('counts as overdue up to and including its last day, and as missed the day after', async () => {
    const h = await as(ids.ownerA);
    const edge = await make({ title: 'Edge of grace', frequency: { kind: 'monthly', firstDueOn: day(-2) }, graceDays: 2 });
    const over = await make({ title: 'Just past grace', frequency: { kind: 'monthly', firstDueOn: day(-3) }, graceDays: 2 });
    const none = await make({ title: 'No grace, due today', frequency: { kind: 'monthly', firstDueOn: day(0) }, graceDays: 0 });
    await admin.query(`update public.audit_definitions set created_at = now() - interval '10 days' where id = any ($1::uuid[])`, [[edge, over, none]]);
    const state = async (id: string) => (await schedule(`?auditId=${id}&to=${day(1)}`, h)).data[0]?.state;
    expect(await state(edge)).toBe('overdue');
    expect(await state(over)).toBe('missed');
    expect(await state(none)).toBe('upcoming');
  });
});
