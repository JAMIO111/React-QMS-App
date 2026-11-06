/**
 * CAPA1 through the API: starting an 8D (from an NC and on its own), the register and its filters, the header, the team (members and
 * external contacts), many-to-many NC links, steps D0 and D1 with the "still needed" list, reopening, cancelling, the rule that an NC cannot
 * close while a linked 8D is running, permissions and isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('b2');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};
const owner = () => as(ids.ownerA);

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-capa');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await owner();
  ctx.supplier = (await api().post('/api/v1/suppliers').set(h).send({ code: 'BAR', name: 'Bar Co' }).expect(201)).body.id;
  const mk = async (body: object) => (await api().post('/api/v1/ncrs').set(h).send(body).expect(201)).body.id as string;
  ctx.nc1 = await mk({ source: 'supplier', title: 'Cracked bar stock', description: 'Cracks on lot 77', requirement: 'No cracks', actualResult: '3 of 10 cracked', severity: 'major', quantityAffected: 3, supplierId: ctx.supplier, siteId: ids.siteA });
  ctx.nc2 = await mk({ source: 'internal', title: 'Second problem', siteId: ids.siteA });
  ctx.nc3 = await mk({ source: 'internal', title: 'Third problem', siteId: ids.siteA });
  ctx.ncB = (await api().post('/api/v1/ncrs').set(await as(ids.ownerB, ids.orgB)).send({ source: 'internal', title: 'At B', siteId: ids.siteB }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('starting an 8D', () => {
  it('from a non-conformance: prefilled, linked, numbered, the creator leads and owns it', async () => {
    const res = await api().post('/api/v1/capas').set(await owner()).send({ fromNcrId: ctx.nc1 }).expect(201);
    const c = res.body;
    ctx.c1 = c.id;
    expect(c).toMatchObject({ reference: 'CAPA-000001', method: '8d', title: '8D: Cracked bar stock', source: 'supplier', severity: 'major', stage: 'open', currentStep: 'd0', stepsDone: 0, ncrCount: 1 });
    expect(c.problemStatement).toBe('Cracks on lot 77\nRequirement: No cracks\nActual: 3 of 10 cracked');
    expect(c.steps.map((s: { step: string }) => s.step)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8']);
    expect(c.team).toEqual([expect.objectContaining({ name: 'Ada Owner', role: 'leader', external: false })]);
    expect(c.owner).toEqual({ membershipId: expect.any(String), name: 'Ada Owner' });
    expect(c.ncrs).toEqual([expect.objectContaining({ nonconformanceId: ctx.nc1, reference: expect.any(String), title: 'Cracked bar stock', source: 'supplier', endedAt: null })]);
  });

  it('on its own, with what was typed; the next number', async () => {
    const res = await api().post('/api/v1/capas').set(await owner()).send({ title: 'Recurring burrs', problemStatement: 'Burrs on every third part', severity: 'minor' }).expect(201);
    ctx.c2 = res.body.id;
    expect(res.body).toMatchObject({ reference: 'CAPA-000002', title: 'Recurring burrs', source: 'internal', severity: 'minor', ncrCount: 0 });
  });

  it('needs a title or a non-conformance, and one the caller can read', async () => {
    await api().post('/api/v1/capas').set(await owner()).send({}).expect(400);
    await api().post('/api/v1/capas').set(await owner()).send({ title: 'x', nope: 1 }).expect(400);
    const foreign = await api().post('/api/v1/capas').set(await owner()).send({ fromNcrId: ctx.ncB });
    expect(foreign.status).toBe(409);
    expect(foreign.body.error.code).toBe('capa_rule');
    await api().post('/api/v1/capas').set(await owner()).send({ fromNcrId: '00000000-0000-0000-0000-000000000000' }).expect(409);
  });

  it('is for people who manage 8Ds', async () => {
    await api().post('/api/v1/capas').set(await as(ids.inspectorA)).send({ title: 'Not allowed' }).expect(403);
  });
});

describe('the register', () => {
  it('lists running 8Ds with stage, owner, step progress and NC count; filters by NC, owner, search and stage', async () => {
    const all = (await api().get('/api/v1/capas').set(await owner()).expect(200)).body.data;
    expect(all.map((c: { reference: string }) => c.reference)).toEqual(['CAPA-000002', 'CAPA-000001']);
    expect(all[1]).toMatchObject({ stage: 'open', currentStep: 'd0', stepsDone: 0, ncrCount: 1, owner: { name: 'Ada Owner' } });
    const byNc = (await api().get(`/api/v1/capas?ncrId=${ctx.nc1}`).set(await owner()).expect(200)).body.data;
    expect(byNc.map((c: { id: string }) => c.id)).toEqual([ctx.c1]);
    expect((await api().get('/api/v1/capas?owner=me').set(await owner()).expect(200)).body.data).toHaveLength(2);
    expect((await api().get('/api/v1/capas?owner=me').set(await as(ids.inspectorA)).expect(200)).body.data).toHaveLength(0);
    expect((await api().get('/api/v1/capas?q=burrs').set(await owner()).expect(200)).body.data.map((c: { id: string }) => c.id)).toEqual([ctx.c2]);
    expect((await api().get('/api/v1/capas?q=capa-000001').set(await owner()).expect(200)).body.data).toHaveLength(1);
    expect((await api().get('/api/v1/capas?stage=cancelled').set(await owner()).expect(200)).body.data).toEqual([]);
    await api().get('/api/v1/capas?stage=bogus').set(await owner()).expect(400);
  });

  it('is readable by anyone with capa.read, not by people from another organisation', async () => {
    expect((await api().get('/api/v1/capas').set(await as(ids.inspectorA)).expect(200)).body.data).toHaveLength(2);
    expect((await api().get('/api/v1/capas').set(await as(ids.ownerB, ids.orgB)).expect(200)).body.data).toEqual([]);
    await api().get(`/api/v1/capas/${ctx.c1}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    await api().get(`/api/v1/capas/${ctx.c1}`).expect(401);
  });
});

describe('the header', () => {
  it('edits title, problem statement, source, severity, reference, owner and due date', async () => {
    const people = (await api().get('/api/v1/capas/people').set(await owner()).expect(200)).body.data as { membershipId: string; userId: string; name: string }[];
    ctx.mInspector = people.find((p) => p.userId === ids.inspectorA)!.membershipId;
    expect(people.map((p) => p.userId)).not.toContain(ids.suspendedA); // only active members
    const res = await api().patch(`/api/v1/capas/${ctx.c1}`).set(await owner()).send({
      title: 'Cracked bar stock, lot 77', externalReference: 'SCAR-2026-14', severity: 'critical', dueDate: '2099-01-31', ownerMembershipId: ctx.mInspector,
    }).expect(200);
    expect(res.body).toMatchObject({ title: 'Cracked bar stock, lot 77', externalReference: 'SCAR-2026-14', severity: 'critical', dueDate: '2099-01-31', overdue: false });
    expect(res.body.owner.membershipId).toBe(ctx.mInspector);
    const cleared = (await api().patch(`/api/v1/capas/${ctx.c1}`).set(await owner()).send({ externalReference: null, dueDate: null, severity: null }).expect(200)).body;
    expect(cleared).toMatchObject({ externalReference: null, dueDate: null, severity: null });
    await api().patch(`/api/v1/capas/${ctx.c1}`).set(await owner()).send({ ownerMembershipId: '00000000-0000-0000-0000-000000000000' }).expect(409); // not a member of this organisation
    await api().patch(`/api/v1/capas/${ctx.c1}`).set(await owner()).send({ stage: 'closed' }).expect(400);
    await api().patch(`/api/v1/capas/${ctx.c1}`).set(await owner()).send({}).expect(400);
    await api().patch(`/api/v1/capas/${ctx.c1}`).set(await as(ids.inspectorA)).send({ title: 'Not allowed' }).expect(403);
  });

  it('marks an 8D past its due date as overdue', async () => {
    const res = await api().patch(`/api/v1/capas/${ctx.c2}`).set(await owner()).send({ dueDate: '2020-01-01' }).expect(200);
    expect(res.body.overdue).toBe(true);
    await api().patch(`/api/v1/capas/${ctx.c2}`).set(await owner()).send({ dueDate: null }).expect(200);
  });
});

describe('the team (D1)', () => {
  it('adds members and external contacts, one leader and one champion, nobody twice', async () => {
    const h = await owner();
    let d = (await api().post(`/api/v1/capas/${ctx.c1}/team`).set(h).send({ membershipId: ctx.mInspector, role: 'champion' }).expect(201)).body;
    expect(d.team.map((t: { role: string }) => t.role)).toEqual(['leader', 'champion']);
    d = (await api().post(`/api/v1/capas/${ctx.c1}/team`).set(h).send({ externalName: 'Sam Supplier', externalCompany: 'Bar Co', externalEmail: 'sam@barco.test', role: 'supplier_contact' }).expect(201)).body;
    const sam = d.team.find((t: { name: string }) => t.name === 'Sam Supplier');
    ctx.sam = sam.id;
    expect(sam).toMatchObject({ external: true, company: 'Bar Co', email: 'sam@barco.test', role: 'supplier_contact', membershipId: null });
    await api().post(`/api/v1/capas/${ctx.c1}/team`).set(h).send({ membershipId: ctx.mInspector, role: 'member' }).expect(409); // already on the team
    const second = await api().post(`/api/v1/capas/${ctx.c1}/team`).set(h).send({ externalName: 'Pat', role: 'champion' });
    expect(second.status).toBe(409);
    await api().post(`/api/v1/capas/${ctx.c1}/team`).set(h).send({ externalName: 'Both', membershipId: ctx.mInspector }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c1}/team`).set(h).send({ role: 'member' }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c1}/team`).set(h).send({ membershipId: ctx.mInspector, role: 'supplier_contact' }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c1}/team`).set(await as(ids.inspectorA)).send({ externalName: 'Nope' }).expect(403);
  });

  it('changes a role or contact details and ends a place on the team; the record stays', async () => {
    const h = await owner();
    const changed = (await api().patch(`/api/v1/capa-team/${ctx.sam}`).set(h).send({ externalCompany: 'Bar Co Ltd', role: 'member' }).expect(200)).body;
    expect(changed.team.find((t: { id: string }) => t.id === ctx.sam)).toMatchObject({ company: 'Bar Co Ltd', role: 'member' });
    const ended = (await api().patch(`/api/v1/capa-team/${ctx.sam}`).set(h).send({ ended: true }).expect(200)).body;
    expect(ended.team.find((t: { id: string }) => t.id === ctx.sam).endedAt).not.toBeNull();
    expect(ended.team.map((t: { id: string }) => t.id)).toContain(ctx.sam);
    await api().patch(`/api/v1/capa-team/${ctx.sam}`).set(h).send({ role: 'leader' }).expect(409); // a person who has left is not changed
    await api().patch(`/api/v1/capa-team/00000000-0000-0000-0000-000000000000`).set(h).send({ role: 'member' }).expect(404);
  });

  it('lists active members for the pickers, for people who manage 8Ds', async () => {
    const found = (await api().get('/api/v1/capas/people?q=Ada').set(await owner()).expect(200)).body.data;
    expect(found).toEqual([expect.objectContaining({ name: 'Ada Owner' })]);
    await api().get('/api/v1/capas/people').set(await as(ids.inspectorA)).expect(403);
  });
});

describe('non-conformance links', () => {
  it('many NCs in one 8D, one NC in several 8Ds; ended with a reason, the record stays', async () => {
    const h = await owner();
    let d = (await api().post(`/api/v1/capas/${ctx.c1}/ncrs`).set(h).send({ ncrId: ctx.nc2 }).expect(201)).body;
    expect(d.ncrCount).toBe(2);
    await api().post(`/api/v1/capas/${ctx.c1}/ncrs`).set(h).send({ ncrId: ctx.nc2 }).expect(409);
    await api().post(`/api/v1/capas/${ctx.c2}/ncrs`).set(h).send({ ncrId: ctx.nc2 }).expect(201);
    expect((await api().get(`/api/v1/capas?ncrId=${ctx.nc2}`).set(h).expect(200)).body.data).toHaveLength(2);
    await api().post(`/api/v1/capas/${ctx.c1}/ncrs`).set(h).send({ ncrId: ctx.ncB }).expect(409); // another organisation's
    const link = d.ncrs.find((n: { nonconformanceId: string }) => n.nonconformanceId === ctx.nc2);
    await api().post(`/api/v1/capa-ncr-links/${link.id}/unlink`).set(h).send({}).expect(400);
    d = (await api().post(`/api/v1/capa-ncr-links/${link.id}/unlink`).set(h).send({ reason: 'Linked by mistake' }).expect(200)).body;
    expect(d.ncrCount).toBe(1);
    expect(d.ncrs.find((n: { id: string }) => n.id === link.id)).toMatchObject({ endReason: 'Linked by mistake', endedAt: expect.any(String) });
    await api().post(`/api/v1/capa-ncr-links/${link.id}/unlink`).set(h).send({ reason: 'again' }).expect(409);
    await api().post(`/api/v1/capas/${ctx.c1}/ncrs`).set(await as(ids.inspectorA)).send({ ncrId: ctx.nc3 }).expect(403);
  });

  it('the NC lists the 8Ds it is in', async () => {
    const res = (await api().get(`/api/v1/ncrs/${ctx.nc1}/capas`).set(await owner()).expect(200)).body.data;
    expect(res).toEqual([expect.objectContaining({ capaId: ctx.c1, reference: 'CAPA-000001', stage: 'open', currentStep: 'd0', stepsDone: 0 })]);
    expect((await api().get(`/api/v1/ncrs/${ctx.nc3}/capas`).set(await owner()).expect(200)).body.data).toEqual([]);
    expect((await api().get(`/api/v1/ncrs/${ctx.nc2}/capas`).set(await owner()).expect(200)).body.data.map((x: { capaId: string }) => x.capaId)).toEqual([ctx.c2]);
    await api().get(`/api/v1/ncrs/${ctx.nc1}/capas`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });

  it('an NC cannot be closed while a linked 8D is running; the message names the 8D', async () => {
    const h = await owner();
    // nc2 is in CAPA-000002 only now. Take it to open, then try to close it.
    await api().patch(`/api/v1/ncrs/${ctx.nc2}`).set(h).send({ severity: 'minor', quantityAffected: 1, description: 'Second problem' }).expect(200);
    await api().post(`/api/v1/ncrs/${ctx.nc2}/transitions`).set(h).send({ to: 'open' }).expect(200);
    const refused = await api().post(`/api/v1/ncrs/${ctx.nc2}/transitions`).set(h).send({ to: 'closed' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ncr_rule');
    expect(refused.body.error.message).toMatch(/CAPA-000002/);
    await api().post(`/api/v1/capas/${ctx.c2}/cancel`).set(h).send({ reason: 'Not needed' }).expect(200);
    await api().post(`/api/v1/ncrs/${ctx.nc2}/transitions`).set(h).send({ to: 'closed' }).expect(200);
    await api().post(`/api/v1/capas/${ctx.c2}/reopen`).set(h).send({ reason: 'Needed after all' }).expect(200);
  });
});

describe('steps D0 and D1', () => {
  it('say what is still needed, complete in order, and say why when something is missing', async () => {
    const h = await owner();
    const fresh = (await api().post('/api/v1/capas').set(h).send({ title: 'Steps 8D' }).expect(201)).body;
    ctx.c3 = fresh.id;
    expect(fresh.steps[0]).toMatchObject({ step: 'd0', completed: false, problems: ['Describe the problem in the problem statement'] });
    expect(fresh.steps[1].problems).toEqual(['Add at least two people to the team']);
    expect(fresh.steps[2].problems).toEqual(['This step is not available yet']);
    const early = await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd1' });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'capa_rule', message: 'Complete D0 first' });
    const missing = await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd0' });
    expect(missing.body.error.message).toBe('D0 cannot be completed yet: Describe the problem in the problem statement');
    await api().patch(`/api/v1/capas/${ctx.c3}`).set(h).send({ problemStatement: 'Parts leaking at the weld' }).expect(200);
    const d0 = (await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd0', note: 'Scope agreed' }).expect(200)).body;
    expect(d0).toMatchObject({ stepsDone: 1, currentStep: 'd1' });
    expect(d0.steps[0]).toMatchObject({ completed: true, note: 'Scope agreed', completedBy: { name: 'Ada Owner' }, problems: [] });
    await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd0' }).expect(409);
    await api().post(`/api/v1/capas/${ctx.c3}/team`).set(h).send({ membershipId: ctx.mInspector, role: 'member' }).expect(201);
    const d1 = (await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd1' }).expect(200)).body;
    expect(d1).toMatchObject({ stepsDone: 2, currentStep: 'd2' });
    const blocked = await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd2' });
    expect(blocked.body.error.message).toBe('D2 cannot be completed yet: This step is not available yet');
    await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd9' }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(await as(ids.inspectorA)).send({ step: 'd2' }).expect(403);
  });

  it('reopening a step reopens the later ones too, with a reason', async () => {
    const h = await owner();
    await api().post(`/api/v1/capas/${ctx.c3}/reopen-step`).set(h).send({ step: 'd0' }).expect(400);
    const d = (await api().post(`/api/v1/capas/${ctx.c3}/reopen-step`).set(h).send({ step: 'd0', reason: 'The scope changed' }).expect(200)).body;
    expect(d).toMatchObject({ stepsDone: 0, currentStep: 'd0' });
    expect(d.steps[0]).toMatchObject({ completed: false, reopenReason: 'The scope changed' });
    expect(d.steps[1].reopenReason).toBe('Reopened with D0: The scope changed');
    await api().post(`/api/v1/capas/${ctx.c3}/reopen-step`).set(h).send({ step: 'd0', reason: 'again' }).expect(409);
  });
});

describe('cancelling and reopening', () => {
  it('needs a reason, freezes the content, and reopening runs it again', async () => {
    const h = await owner();
    await api().post(`/api/v1/capas/${ctx.c3}/cancel`).set(h).send({}).expect(400);
    const d = (await api().post(`/api/v1/capas/${ctx.c3}/cancel`).set(h).send({ reason: 'Raised twice' }).expect(200)).body;
    expect(d).toMatchObject({ stage: 'cancelled', stageReason: 'Raised twice' });
    const frozen = await api().patch(`/api/v1/capas/${ctx.c3}`).set(h).send({ title: 'Edited while cancelled' });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.message).toMatch(/cancelled; reopen it/);
    await api().post(`/api/v1/capas/${ctx.c3}/team`).set(h).send({ externalName: 'Late' }).expect(409);
    await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd0' }).expect(409);
    expect((await api().get('/api/v1/capas').set(h).expect(200)).body.data.map((c: { id: string }) => c.id)).not.toContain(ctx.c3); // running only
    expect((await api().get('/api/v1/capas?stage=all').set(h).expect(200)).body.data.map((c: { id: string }) => c.id)).toContain(ctx.c3);
    await api().post(`/api/v1/capas/${ctx.c2}/reopen`).set(h).send({ reason: 'x' }).expect(409); // a running 8D
    const back = (await api().post(`/api/v1/capas/${ctx.c3}/reopen`).set(h).send({ reason: 'It was valid' }).expect(200)).body;
    expect(back.stage).toBe('open');
    await api().patch(`/api/v1/capas/${ctx.c3}`).set(h).send({ title: 'Edited after reopening' }).expect(200);
  });
});
