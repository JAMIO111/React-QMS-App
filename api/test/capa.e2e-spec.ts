/**
 * CAPA1 through the API: starting an 8D (from an NC and on its own), the register and its filters, the header, the team (members and
 * external contacts), many-to-many NC links, steps D0 and D1 with the "still needed" list, reopening, cancelling, the rule that an NC cannot
 * close while a linked 8D is running, permissions and isolation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { categoryId, makeIds, requireDb, seed, settleNcr, startApp, token } from './helpers';

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
    await api().patch(`/api/v1/ncrs/${ctx.nc2}`).set(h).send({ severity: 'minor', quantityAffected: 1, description: 'Second problem', categoryId: await categoryId(admin, ids.orgA) }).expect(200);
    await api().post(`/api/v1/ncrs/${ctx.nc2}/transitions`).set(h).send({ to: 'open' }).expect(200);
    await settleNcr(app.getHttpServer(), h, ctx.nc2);
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
  it('say what is still needed, complete in any order, and say why when something is missing', async () => {
    const h = await owner();
    const fresh = (await api().post('/api/v1/capas').set(h).send({ title: 'Steps 8D' }).expect(201)).body;
    ctx.c3 = fresh.id;
    expect(fresh.steps[0]).toMatchObject({ step: 'd0', completed: false, problems: ['Describe the problem in the problem statement'] });
    expect(fresh.steps[1].problems).toEqual(['Add at least two people to the team']);
    expect(fresh.steps[2].problems).toEqual(['Say what is wrong (the What of 5W2H)', 'Say where it was found (the Where of 5W2H)', 'Say when it was found (the When of 5W2H)']);
    expect(fresh.steps[4].problems).toEqual(['Record at least one occurrence root cause (why the problem happened)']);
    expect(fresh.steps[8].problems).toEqual([...['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'].map((s) => `Complete ${s} first`), 'The corrective actions must be verified as effective before the 8D can be closed']);
    const early = await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd1' });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'capa_rule', message: 'D1 cannot be completed yet: Add at least two people to the team' });
    const missing = await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd0' });
    expect(missing.body.error.message).toBe('D0 cannot be completed yet: Describe the problem in the problem statement');
    await api().patch(`/api/v1/capas/${ctx.c3}`).set(h).send({ problemStatement: 'Parts leaking at the weld' }).expect(200);
    // Any order: D1 can be done before D0 once the team is in place.
    await api().post(`/api/v1/capas/${ctx.c3}/team`).set(h).send({ membershipId: ctx.mInspector, role: 'member' }).expect(201);
    const d1 = (await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd1' }).expect(200)).body;
    expect(d1).toMatchObject({ stepsDone: 1, currentStep: 'd0' });
    const d0 = (await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd0', note: 'Scope agreed' }).expect(200)).body;
    expect(d0).toMatchObject({ stepsDone: 2, currentStep: 'd2' });
    expect(d0.steps[0]).toMatchObject({ completed: true, note: 'Scope agreed', completedBy: { name: 'Ada Owner' }, problems: [] });
    await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd0' }).expect(409);
    const blocked = await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd2' });
    expect(blocked.body.error.message).toBe('D2 cannot be completed yet: Say what is wrong (the What of 5W2H); Say where it was found (the Where of 5W2H); Say when it was found (the When of 5W2H)');
    await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(h).send({ step: 'd9' }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c3}/complete-step`).set(await as(ids.inspectorA)).send({ step: 'd2' }).expect(403);
  });

  it('reopening a step needs a reason and touches no other step', async () => {
    const h = await owner();
    await api().post(`/api/v1/capas/${ctx.c3}/reopen-step`).set(h).send({ step: 'd0' }).expect(400);
    const d = (await api().post(`/api/v1/capas/${ctx.c3}/reopen-step`).set(h).send({ step: 'd0', reason: 'The scope changed' }).expect(200)).body;
    expect(d).toMatchObject({ stepsDone: 1, currentStep: 'd0' });
    expect(d.steps[0]).toMatchObject({ completed: false, reopenReason: 'The scope changed' });
    expect(d.steps[1]).toMatchObject({ completed: true, reopenReason: null });
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

describe('D2: the 5W2H and Is / Is-Not', () => {
  it('is filled from the non-conformance an 8D is started from', async () => {
    const d = (await api().get(`/api/v1/capas/${ctx.c1}`).set(await owner()).expect(200)).body;
    expect(d.problem).toMatchObject({ what: expect.stringContaining('Cracked bar stock'), where: expect.any(String), when: expect.stringMatching(/^Detected \d/), howMany: '3 affected', who: null, why: null, how: null });
    expect(d.steps[2].problems).toEqual([]);
    expect(d.analyses).toEqual([]);
    expect(d.actions).toEqual([]);
  });

  it('saves the 5W2H with the header, trimming, and clears a field with null or blank', async () => {
    const h = await owner();
    const d = (await api().patch(`/api/v1/capas/${ctx.c2}`).set(h).send({ d2What: '  Burrs on the bore  ', d2Who: 'Night shift', d2Where: 'Lathe 2', d2When: 'Since Monday', d2Why: 'Customer rejected 40 parts', d2How: 'Found at final inspection', d2HowMany: '40 of 400' }).expect(200)).body;
    expect(d.problem).toEqual({ what: 'Burrs on the bore', who: 'Night shift', where: 'Lathe 2', when: 'Since Monday', why: 'Customer rejected 40 parts', how: 'Found at final inspection', howMany: '40 of 400' });
    expect(d.steps[2].problems).toEqual([]);
    const cleared = (await api().patch(`/api/v1/capas/${ctx.c2}`).set(h).send({ d2Who: '', d2Why: null }).expect(200)).body;
    expect(cleared.problem).toMatchObject({ who: null, why: null, what: 'Burrs on the bore' });
    await api().patch(`/api/v1/capas/${ctx.c2}`).set(h).send({ d2What: 'x'.repeat(2001) }).expect(400);
    await api().patch(`/api/v1/capas/${ctx.c2}`).set(await as(ids.inspectorA)).send({ d2What: 'Not allowed' }).expect(403);
  });

  it('keeps an Is / Is-Not analysis with its rows; edits it; removes it with the record kept', async () => {
    const h = await owner();
    const rows = [
      { key: 'what_object', dimension: 'what', question: 'Which part has the problem?', is: 'Rod 100', isNot: 'Rod 200', distinctive: 'Bar from the new lot', changes: 'New supplier lot' },
      { key: 'where_site', dimension: 'where', question: 'Where is it found?', is: 'Lathe 2', isNot: 'Lathe 1', distinctive: '', changes: '' },
    ];
    const d = (await api().post(`/api/v1/capas/${ctx.c2}/analyses`).set(h).send({ kind: 'is_is_not', title: 'Is / Is-Not', data: { rows } }).expect(201)).body;
    expect(d.analyses).toEqual([expect.objectContaining({ kind: 'is_is_not', title: 'Is / Is-Not', step: 'd2', createdBy: { id: expect.any(String), name: 'Ada Owner' }, data: { rows } })]);
    const id = d.analyses[0].id;
    const edited = (await api().patch(`/api/v1/capa-analyses/${id}`).set(h).send({ title: 'Is / Is-Not, lot 77', data: { rows: [rows[0]] } }).expect(200)).body;
    expect(edited.analyses[0]).toMatchObject({ title: 'Is / Is-Not, lot 77', data: { rows: [rows[0]] } });
    const removed = (await api().delete(`/api/v1/capa-analyses/${id}`).set(h).expect(200)).body;
    expect(removed.analyses).toEqual([]);
    const gone = await api().patch(`/api/v1/capa-analyses/${id}`).set(h).send({ title: 'Back' });
    expect(gone.status).toBe(404);
    const kept = await admin.query(`select deleted_at is not null as removed from public.capa_analyses where id = $1`, [id]);
    expect(kept.rows[0].removed).toBe(true);
  });

  it('refuses data that does not fit the kind, unknown kinds, and strangers', async () => {
    const h = await owner();
    const bad = await api().post(`/api/v1/capas/${ctx.c2}/analyses`).set(h).send({ kind: 'is_is_not', title: 'x', data: { rows: [{ key: 'a', dimension: 'sideways' }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_analysis');
    await api().post(`/api/v1/capas/${ctx.c2}/analyses`).set(h).send({ kind: 'swot', title: 'x', data: {} }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c2}/analyses`).set(h).send({ kind: 'is_is_not', title: 'x', data: { rows: [], extra: 1 } }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c2}/analyses`).set(await as(ids.inspectorA)).send({ kind: 'is_is_not', title: 'x', data: {} }).expect(403);
    await api().post(`/api/v1/capas/${ctx.c2}/analyses`).set(await as(ids.ownerB, ids.orgB)).send({ kind: 'is_is_not', title: 'x', data: {} }).expect(404);
  });
});

describe('D3: interim containment', () => {
  it('adds actions with an owner from the team and a due date; the owner must be on the team', async () => {
    const h = await owner();
    const d = (await api().get(`/api/v1/capas/${ctx.c1}`).set(h).expect(200)).body; // the inspector joined the team (as champion) in D1
    ctx.tInspector = d.team.find((t: { membershipId: string; endedAt: string | null }) => t.membershipId === ctx.mInspector && !t.endedAt).id;
    const added = (await api().post(`/api/v1/capas/${ctx.c1}/actions`).set(h).send({ phase: 'interim', description: 'Quarantine lot 77', ownerTeamMemberId: ctx.tInspector, dueDate: '2099-01-02' }).expect(201)).body;
    expect(added.actions).toEqual([expect.objectContaining({ phase: 'interim', description: 'Quarantine lot 77', status: 'open', dueDate: '2099-01-02', overdue: false, owner: { teamMemberId: ctx.tInspector, name: expect.any(String) }, doneAt: null })]);
    ctx.act = added.actions[0].id;
    await api().post(`/api/v1/capas/${ctx.c1}/actions`).set(h).send({ phase: 'interim', description: 'x', ownerTeamMemberId: '00000000-0000-0000-0000-000000000000' }).expect(409);
    await api().post(`/api/v1/capas/${ctx.c1}/actions`).set(h).send({ phase: 'bogus', description: 'Not a phase' }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c1}/actions`).set(h).send({ phase: 'interim', description: '' }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c1}/actions`).set(await as(ids.inspectorA)).send({ phase: 'interim', description: 'Not allowed' }).expect(403);
  });

  it('marks an action overdue past its due date, edits it, completes it with evidence, cancels another with a reason, reopens', async () => {
    const h = await owner();
    const edited = (await api().patch(`/api/v1/capa-actions/${ctx.act}`).set(h).send({ description: 'Quarantine lots 77 and 78', dueDate: '2020-01-01' }).expect(200)).body;
    expect(edited.actions[0]).toMatchObject({ description: 'Quarantine lots 77 and 78', overdue: true });
    expect(edited.steps[3].problems).toEqual(['Finish or cancel the 1 open containment action', 'Add an interim containment action, or say why none is needed']);
    const done = (await api().post(`/api/v1/capa-actions/${ctx.act}/complete`).set(h).send({ evidenceNote: 'In the cage' }).expect(200)).body;
    expect(done.actions[0]).toMatchObject({ status: 'done', evidenceNote: 'In the cage', overdue: false, doneAt: expect.any(String), doneBy: { name: 'Ada Owner' } });
    expect(done.steps[3].problems).toEqual([]);
    const second = (await api().post(`/api/v1/capas/${ctx.c1}/actions`).set(h).send({ phase: 'interim', description: 'Check the customer stock' }).expect(201)).body.actions.find((a: { description: string }) => a.description === 'Check the customer stock');
    await api().post(`/api/v1/capa-actions/${second.id}/cancel`).set(h).send({}).expect(400);
    const cancelled = (await api().post(`/api/v1/capa-actions/${second.id}/cancel`).set(h).send({ reason: 'Customer has no stock' }).expect(200)).body;
    expect(cancelled.actions.find((a: { id: string }) => a.id === second.id)).toMatchObject({ status: 'cancelled', cancelReason: 'Customer has no stock' });
    const reopened = (await api().post(`/api/v1/capa-actions/${ctx.act}/reopen`).set(h).send().expect(200)).body;
    expect(reopened.actions.find((a: { id: string }) => a.id === ctx.act)).toMatchObject({ status: 'open', doneAt: null, doneBy: null });
    // The inspector (capa.read) is the actionee of this action: they close it with the findings already written, but cannot change what it is, cancel it or touch anyone else's.
    const inspector = await as(ids.inspectorA);
    expect((await api().post(`/api/v1/capa-actions/${ctx.act}/complete`).set(inspector).send({}).expect(200)).body.actions.find((a: { id: string }) => a.id === ctx.act)).toMatchObject({ status: 'done', isAssignee: true });
    await api().patch(`/api/v1/capa-actions/${ctx.act}`).set(inspector).send({ description: 'Changed by the actionee' }).expect(409);
    await api().post(`/api/v1/capa-actions/${ctx.act}/cancel`).set(inspector).send({ reason: 'Not mine to cancel' }).expect(403);
    const unassigned = (await api().post(`/api/v1/capas/${ctx.c1}/actions`).set(h).send({ phase: 'interim', description: 'Nobody has this yet' }).expect(201)).body.actions.find((a: { description: string }) => a.description === 'Nobody has this yet');
    expect(unassigned.isAssignee).toBe(false);
    await api().patch(`/api/v1/capa-actions/${unassigned.id}`).set(inspector).send({ evidenceNote: 'Not mine' }).expect(403);
    await api().post(`/api/v1/capa-actions/${unassigned.id}/cancel`).set(h).send({ reason: 'Not needed' }).expect(200);
  });

  it('a team member who owns an open action cannot leave until it is done or handed on', async () => {
    const h = await owner();
    const open = (await api().post(`/api/v1/capas/${ctx.c1}/actions`).set(h).send({ phase: 'interim', description: 'Sort 100%', ownerTeamMemberId: ctx.tInspector }).expect(201)).body.actions.find((a: { description: string }) => a.description === 'Sort 100%');
    const refused = await api().patch(`/api/v1/capa-team/${ctx.tInspector}`).set(h).send({ ended: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('This person still owns open actions; give them to someone else first');
    await api().post(`/api/v1/capa-actions/${open.id}/complete`).set(h).send({}).expect(409); // the findings must be written first
    await api().post(`/api/v1/capa-actions/${open.id}/complete`).set(h).send({ evidenceNote: 'Sorted: 4 rejected' }).expect(200);
    await api().patch(`/api/v1/capa-team/${ctx.tInspector}`).set(h).send({ ended: true }).expect(200);
  });

  it('with no containment, a reason is enough; once the step is complete it is read-only until reopened', async () => {
    const h = await owner();
    const fresh = (await api().post('/api/v1/capas').set(h).send({ title: 'No containment needed', problemStatement: 'Found in the lab' }).expect(201)).body;
    expect(fresh.steps[3].problems).toEqual(['Add an interim containment action, or say why none is needed']);
    const d = (await api().patch(`/api/v1/capas/${fresh.id}`).set(h).send({ d3NoContainmentReason: 'No product left the plant' }).expect(200)).body;
    expect(d.d3NoContainmentReason).toBe('No product left the plant');
    expect(d.steps[3].problems).toEqual([]);
    await api().patch(`/api/v1/capas/${fresh.id}`).set(h).send({ d2What: 'Leak at the weld', d2Where: 'Line 3', d2When: 'Today' }).expect(200);
    const after = (await api().post(`/api/v1/capas/${fresh.id}/complete-step`).set(h).send({ step: 'd2' }).expect(200)).body;
    expect(after.steps[2].completed).toBe(true);
    const locked = await api().patch(`/api/v1/capas/${fresh.id}`).set(h).send({ d2Why: 'Edited after D2 was completed' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.message).toBe('D2 is complete; reopen it to change the problem description');
    await api().post(`/api/v1/capas/${fresh.id}/analyses`).set(h).send({ kind: 'is_is_not', title: 'Added after D2 was completed', data: { rows: [] } }).expect(409);
    await api().patch(`/api/v1/capas/${fresh.id}`).set(h).send({ title: 'Other steps are not locked' }).expect(200);
    await api().post(`/api/v1/capas/${fresh.id}/reopen-step`).set(h).send({ step: 'd2', reason: 'More to say' }).expect(200);
    await api().patch(`/api/v1/capas/${fresh.id}`).set(h).send({ d2Why: 'Edited after D2 was reopened' }).expect(200);
    const analysis = (await api().post(`/api/v1/capas/${fresh.id}/analyses`).set(h).send({ kind: 'is_is_not', title: 'Added after D2 was reopened', data: { rows: [] } }).expect(201)).body;
    expect(analysis.analyses).toHaveLength(1);
    await api().post(`/api/v1/capas/${fresh.id}/cancel`).set(h).send({ reason: 'Test' }).expect(200);
    await api().post(`/api/v1/capas/${fresh.id}/actions`).set(h).send({ phase: 'interim', description: 'Too late' }).expect(409);
    await api().post(`/api/v1/capas/${fresh.id}/analyses`).set(h).send({ kind: 'is_is_not', title: 'Too late', data: { rows: [] } }).expect(409);
  });

  it('actions and analyses belong to their organisation', async () => {
    await api().post(`/api/v1/capa-actions/${ctx.act}/complete`).set(await as(ids.ownerB, ids.orgB)).send({}).expect(404);
    await api().patch(`/api/v1/capa-actions/${ctx.act}`).set(await as(ids.ownerB, ids.orgB)).send({ description: 'Hijacked' }).expect(404);
  });
});

describe('D4: root causes and the Ishikawa and 5 Whys tools', () => {
  const fishbone = { effect: 'Burrs on the bore', categories: [{ key: 'machine', causes: [{ id: 'c1', text: 'Worn boring bar', probable: true }] }, { key: 'method', causes: [] }] };
  const whys = { kind: 'occurrence', problem: 'Burrs on the bore', whys: [{ because: 'The tool was worn' }, { because: 'Nobody tracks tool life' }], rootCause: 'No tool life limit' };

  it('keeps an Ishikawa diagram and a 5 Whys chain as analyses of D4, checking their shape', async () => {
    const h = await owner();
    let d = (await api().post(`/api/v1/capas/${ctx.c2}/analyses`).set(h).send({ kind: 'ishikawa', title: 'Ishikawa', data: fishbone }).expect(201)).body;
    d = (await api().post(`/api/v1/capas/${ctx.c2}/analyses`).set(h).send({ kind: 'five_whys', title: '5 Whys: occurrence', data: whys }).expect(201)).body;
    expect(d.analyses.filter((a: { step: string }) => a.step === 'd4').map((a: { kind: string }) => a.kind)).toEqual(['ishikawa', 'five_whys']);
    ctx.fish = d.analyses.find((a: { kind: string }) => a.kind === 'ishikawa').id;
    ctx.why = d.analyses.find((a: { kind: string }) => a.kind === 'five_whys').id;
    expect(d.analyses.find((a: { kind: string }) => a.kind === 'ishikawa').data.categories[0].causes[0]).toEqual({ id: 'c1', text: 'Worn boring bar', probable: true });
    const bad = (body: object) => api().post(`/api/v1/capas/${ctx.c2}/analyses`).set(h).send(body);
    expect((await bad({ kind: 'ishikawa', title: 'x', data: { effect: 'e', categories: [{ key: 'weather', causes: [] }] } })).status).toBe(400);
    expect((await bad({ kind: 'ishikawa', title: 'x', data: { effect: 'e', categories: [{ key: 'man', causes: [{ id: 'a', text: '' }] }] } })).status).toBe(400);
    expect((await bad({ kind: 'five_whys', title: 'x', data: { kind: 'maybe', whys: [] } })).status).toBe(400);
    expect((await bad({ kind: 'five_whys', title: 'x', data: { whys: Array.from({ length: 9 }, () => ({ because: 'x' })) } })).status).toBe(400);
    const edited = (await api().patch(`/api/v1/capa-analyses/${ctx.why}`).set(h).send({ data: { ...whys, whys: [...whys.whys, { because: 'No limit in the control plan' }] } }).expect(200)).body;
    expect(edited.analyses.find((a: { id: string }) => a.id === ctx.why).data.whys).toHaveLength(3);
    // The shape is checked against the analysis's own kind when it is edited.
    const wrong = await api().patch(`/api/v1/capa-analyses/${ctx.why}`).set(h).send({ data: { effect: 'a fishbone shape' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('invalid_analysis');
  });

  it('records causes of each kind, from an analysis or on their own; they start unverified', async () => {
    const h = await owner();
    const first = (await api().post(`/api/v1/capas/${ctx.c2}/root-causes`).set(h).send({ kind: 'occurrence', description: 'No tool life limit', sourceAnalysisId: ctx.why }).expect(201)).body;
    expect(first.rootCauses).toEqual([expect.objectContaining({ kind: 'occurrence', description: 'No tool life limit', sourceAnalysisId: ctx.why, verified: false, verifiedAt: null, verifiedBy: null })]);
    ctx.rc1 = first.rootCauses[0].id;
    const more = (await api().post(`/api/v1/capas/${ctx.c2}/root-causes`).set(h).send({ kind: 'systemic', description: 'No tool monitoring in the control plan' }).expect(201)).body;
    const withEscape = (await api().post(`/api/v1/capas/${ctx.c2}/root-causes`).set(h).send({ kind: 'escape', description: 'Final inspection samples 1 in 50', sourceAnalysisId: ctx.fish }).expect(201)).body;
    expect(withEscape.rootCauses.map((c: { kind: string }) => c.kind)).toEqual(['occurrence', 'escape', 'systemic']); // occurrence, escape, systemic
    ctx.rc2 = withEscape.rootCauses[1].id;
    ctx.rc3 = more.rootCauses.find((c: { kind: string }) => c.kind === 'systemic').id;
    const refused = await api().post(`/api/v1/capas/${ctx.c2}/root-causes`).set(h).send({ kind: 'occurrence', description: 'x', sourceAnalysisId: ctx.nc1 });
    expect(refused.status).toBeGreaterThanOrEqual(400); // not an analysis of this 8D
    await api().post(`/api/v1/capas/${ctx.c2}/root-causes`).set(h).send({ kind: 'maybe', description: 'x' }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c2}/root-causes`).set(h).send({ kind: 'occurrence', description: '' }).expect(400);
    await api().post(`/api/v1/capas/${ctx.c2}/root-causes`).set(await as(ids.inspectorA)).send({ kind: 'occurrence', description: 'Not allowed' }).expect(403);
    await api().post(`/api/v1/capas/${ctx.c2}/root-causes`).set(await as(ids.ownerB, ids.orgB)).send({ kind: 'occurrence', description: 'Foreign' }).expect(404);
  });

  it('says what D4 needs, verifying needs a method, and the database stamps who and when', async () => {
    const h = await owner();
    const before = (await api().get(`/api/v1/capas/${ctx.c2}`).set(h).expect(200)).body;
    expect(before.steps[4].problems).toEqual(['Verify the 3 root causes not yet verified']);
    const noMethod = await api().patch(`/api/v1/capa-root-causes/${ctx.rc1}`).set(h).send({ verified: true });
    expect(noMethod.status).toBe(409);
    expect(noMethod.body.error).toMatchObject({ code: 'capa_rule', message: 'Say how the root cause was verified' });
    const one = (await api().patch(`/api/v1/capa-root-causes/${ctx.rc1}`).set(h).send({ verified: true, verificationMethod: 'Trial with a new tool', verificationNote: 'Burrs stopped' }).expect(200)).body;
    expect(one.rootCauses[0]).toMatchObject({ verified: true, verificationMethod: 'Trial with a new tool', verificationNote: 'Burrs stopped', verifiedBy: { name: 'Ada Owner' }, verifiedAt: expect.any(String) });
    expect(one.steps[4].problems).toEqual(['Verify the 2 root causes not yet verified']);
    await api().patch(`/api/v1/capa-root-causes/${ctx.rc2}`).set(h).send({ verified: true, verificationMethod: 'Checked the sampling plan' }).expect(200);
    const all = (await api().patch(`/api/v1/capa-root-causes/${ctx.rc3}`).set(h).send({ verified: true, verificationMethod: 'Reviewed the control plan' }).expect(200)).body;
    expect(all.steps[4].problems).toEqual([]);
    await api().patch(`/api/v1/capa-root-causes/${ctx.rc1}`).set(await as(ids.inspectorA)).send({ verified: false }).expect(403);
  });

  it('changing the words of a verified cause withdraws its verification, so D4 needs it again', async () => {
    const h = await owner();
    const note = (await api().patch(`/api/v1/capa-root-causes/${ctx.rc1}`).set(h).send({ verificationNote: 'Burrs stopped, three lots' }).expect(200)).body;
    expect(note.rootCauses[0].verified).toBe(true); // a note does not withdraw it
    const changed = (await api().patch(`/api/v1/capa-root-causes/${ctx.rc1}`).set(h).send({ description: 'No tool life limit on the boring bar or the drill' }).expect(200)).body;
    expect(changed.rootCauses[0]).toMatchObject({ verified: false, verifiedAt: null, verifiedBy: null });
    expect(changed.steps[4].problems).toEqual(['Verify the 1 root cause not yet verified']);
    const again = (await api().patch(`/api/v1/capa-root-causes/${ctx.rc1}`).set(h).send({ verified: true }).expect(200)).body; // the method is still there
    expect(again.rootCauses[0].verified).toBe(true);
    const withdrawn = (await api().patch(`/api/v1/capa-root-causes/${ctx.rc1}`).set(h).send({ verified: false }).expect(200)).body;
    expect(withdrawn.rootCauses[0].verified).toBe(false);
    await api().patch(`/api/v1/capa-root-causes/${ctx.rc1}`).set(h).send({ verified: true }).expect(200);
  });

  it('completing D4 makes the causes read-only until it is reopened; removing a cause marks it and it no longer counts', async () => {
    const h = await owner();
    const done = (await api().post(`/api/v1/capas/${ctx.c2}/complete-step`).set(h).send({ step: 'd4' }).expect(200)).body;
    expect(done.steps[4].completed).toBe(true);
    await api().patch(`/api/v1/capa-root-causes/${ctx.rc2}`).set(h).send({ description: 'Locked' }).expect(409); // D4 is complete
    await api().post(`/api/v1/capas/${ctx.c2}/root-causes`).set(h).send({ kind: 'systemic', description: 'Locked too' }).expect(409);
    await api().post(`/api/v1/capas/${ctx.c2}/reopen-step`).set(h).send({ step: 'd4', reason: 'A cause needs rewording' }).expect(200);
    const edited = (await api().patch(`/api/v1/capa-root-causes/${ctx.rc2}`).set(h).send({ description: 'Final inspection samples 1 in 50 parts' }).expect(200)).body; // D4 reopened
    expect(edited.rootCauses.find((c: { id: string }) => c.id === ctx.rc2)).toMatchObject({ description: 'Final inspection samples 1 in 50 parts', verified: false });
    const removed = (await api().delete(`/api/v1/capa-root-causes/${ctx.rc2}`).set(h).expect(200)).body;
    expect(removed.rootCauses.map((c: { id: string }) => c.id)).not.toContain(ctx.rc2);
    expect((await api().patch(`/api/v1/capa-root-causes/${ctx.rc2}`).set(h).send({ description: 'Back' })).status).toBe(404);
    const kept = await admin.query(`select deleted_at is not null as removed from public.capa_root_causes where id = $1`, [ctx.rc2]);
    expect(kept.rows[0].removed).toBe(true);
    expect((await api().post(`/api/v1/capas/${ctx.c2}/complete-step`).set(h).send({ step: 'd4' }).expect(200)).body.steps[4].completed).toBe(true); // complete again for the steps that follow
  });

  it('is private to the organisation', async () => {
    await api().patch(`/api/v1/capa-root-causes/${ctx.rc1}`).set(await as(ids.ownerB, ids.orgB)).send({ description: 'Hijacked' }).expect(404);
    await api().delete(`/api/v1/capa-root-causes/${ctx.rc1}`).set(await as(ids.ownerB, ids.orgB)).expect(404);
  });
});

describe('D5 to D7: corrective actions, verification, prevention', () => {
  const owner = () => as(ids.ownerA);

  it('adds corrective actions to a root cause; the stage follows the actions', async () => {
    const h = await owner();
    const added = (await api().post(`/api/v1/capas/${ctx.c2}/actions`).set(h).send({ phase: 'corrective', description: 'Fit a tool life counter', rootCauseId: ctx.rc1, dueDate: '2099-02-01' }).expect(201)).body;
    ctx.corr = added.actions.find((a: { phase: string }) => a.phase === 'corrective').id;
    expect(added.stage).toBe('actions_in_progress');
    expect(added.steps[5].problems.length).toBeGreaterThan(0);
    await api().post(`/api/v1/capas/${ctx.c2}/actions`).set(h).send({ phase: 'corrective', description: 'x', rootCauseId: ctx.nc1 }).expect(409);
    await api().post(`/api/v1/capas/${ctx.c2}/actions`).set(await as(ids.inspectorA)).send({ phase: 'corrective', description: 'Nope' }).expect(403);
    const done = (await api().post(`/api/v1/capa-actions/${ctx.corr}/complete`).set(h).send({ evidenceNote: 'Counter fitted' }).expect(200)).body;
    expect(done.stage).toBe('awaiting_verification');
    expect(done.verificationState).toBe('none');
  });

  it('verification needs capa.verify and a method; a failed one needs a note and reopens D5 and D6', async () => {
    const h = await owner();
    await api().post(`/api/v1/capas/${ctx.c2}/complete-step`).set(h).send({ step: 'd5' });
    await api().post(`/api/v1/capas/${ctx.c2}/verifications`).set(await as(ids.inspectorA)).send({ effective: true, method: 'x' }).expect(403);
    await api().post(`/api/v1/capas/${ctx.c2}/verifications`).set(h).send({ effective: true, method: '' }).expect(400);
    const noNote = await api().post(`/api/v1/capas/${ctx.c2}/verifications`).set(h).send({ effective: false, method: 'Audit' });
    expect(noNote.status).toBe(409);
    const failed = (await api().post(`/api/v1/capas/${ctx.c2}/verifications`).set(h).send({ effective: false, method: 'Audit of 5 lots', notes: 'Burrs again' }).expect(201)).body;
    expect(failed.verificationState).toBe('failed');
    expect(failed.stage).toBe('actions_in_progress');
    expect(failed.verifications[0]).toMatchObject({ effective: false, method: 'Audit of 5 lots', notes: 'Burrs again', verifiedBy: { name: 'Ada Owner' } });
    expect(failed.steps[5].completed).toBe(false);
    const added = (await api().post(`/api/v1/capas/${ctx.c2}/actions`).set(h).send({ phase: 'corrective', description: 'Second inspection', rootCauseId: ctx.rc3 }).expect(201)).body;
    const second = added.actions.find((a: { description: string }) => a.description === 'Second inspection').id;
    await api().post(`/api/v1/capa-actions/${second}/complete`).set(h).send({ evidenceNote: 'In place' }).expect(200);
    const ok = (await api().post(`/api/v1/capas/${ctx.c2}/verifications`).set(h).send({ effective: true, method: 'Audit of 5 more lots' }).expect(201)).body;
    expect(ok.verificationState).toBe('effective');
    expect(ok.stage).toBe('verified_effective');
    expect(ok.verifications).toHaveLength(2);
    ctx.second = second;
  });

  it('changing the corrective actions afterwards makes the verification stale', async () => {
    const h = await owner();
    const reopened = (await api().post(`/api/v1/capa-actions/${ctx.second}/reopen`).set(h).send({}).expect(200)).body;
    expect(reopened.verificationState).toBe('stale');
    expect(reopened.stage).toBe('actions_in_progress');
  });

  it('D7 keeps lessons learned and a reason for no preventive action; preventive actions do not move the stage', async () => {
    const h = await owner();
    const d = (await api().patch(`/api/v1/capas/${ctx.c2}`).set(h).send({ d7LessonsLearned: 'Tool life belongs in every plan', d7NoPreventiveReason: 'Nothing else exposed' }).expect(200)).body;
    expect(d).toMatchObject({ d7LessonsLearned: 'Tool life belongs in every plan', d7NoPreventiveReason: 'Nothing else exposed' });
    expect(d.steps[7].problems).toEqual([]);
    const cleared = (await api().patch(`/api/v1/capas/${ctx.c2}`).set(h).send({ d7NoPreventiveReason: null }).expect(200)).body;
    expect(cleared.steps[7].problems).toEqual(['Add a preventive action, or say why none is needed']);
    const stage = cleared.stage;
    const prev = (await api().post(`/api/v1/capas/${ctx.c2}/actions`).set(h).send({ phase: 'preventive', description: 'Add tool life to the template', rootCauseId: ctx.rc3 }).expect(201)).body;
    expect(prev.stage).toBe(stage);
  });

  it('is private to the organisation', async () => {
    await api().post(`/api/v1/capas/${ctx.c2}/verifications`).set(await as(ids.ownerB, ids.orgB)).send({ effective: true, method: 'Hijacked' }).expect(404);
  });
});

describe('D8: closing, evidence files', () => {
  const owner = () => as(ids.ownerA);
  const folder = () => `${ids.orgA}/capa/${ctx.c2}/`;

  it('says what is missing before the 8D can be closed', async () => {
    const h = await owner();
    const d = (await api().get(`/api/v1/capas/${ctx.c2}`).set(h).expect(200)).body;
    expect(d.steps[8].problems.length).toBeGreaterThan(0);
    const refused = await api().post(`/api/v1/capas/${ctx.c2}/close`).set(h).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code ?? refused.body.code).toBe('capa_rule');
    await api().post(`/api/v1/capas/${ctx.c2}/complete-step`).set(h).send({ step: 'd8' }).expect(409); // D8 only through closing
  });

  it('keeps evidence files: attach after upload, remove with a reason, restore', async () => {
    const h = await owner();
    const path = `${folder()}u1-evidence.pdf`;
    await api().post(`/api/v1/capas/${ctx.c2}/attachments`).set(h).send({ storagePath: path, fileName: 'evidence.pdf', sizeBytes: 10 }).expect(400); // not uploaded yet
    await admin.query(`insert into storage.objects (bucket_id, name) values ('capa-files', $1)`, [path]);
    await api().post(`/api/v1/capas/${ctx.c2}/attachments`).set(h).send({ storagePath: `${ids.orgA}/capa/${ctx.c1}/x.pdf`, fileName: 'x.pdf', sizeBytes: 1 }).expect(400); // another 8D's folder
    const att = (await api().post(`/api/v1/capas/${ctx.c2}/attachments`).set(h).send({ storagePath: path, fileName: 'evidence.pdf', contentType: 'application/pdf', sizeBytes: 10 }).expect(201)).body;
    ctx.capaFile = att.id;
    expect((await api().get(`/api/v1/capas/${ctx.c2}/attachments`).set(h).expect(200)).body.data).toHaveLength(1);
    await api().post(`/api/v1/capas/${ctx.c2}/attachments`).set(await as(ids.inspectorA)).send({ storagePath: path, fileName: 'evidence.pdf', sizeBytes: 10 }).expect(403);
    await api().post(`/api/v1/capa-attachments/${att.id}/delete`).set(h).send({ reason: 'x' }).expect(400);
    const removed = (await api().post(`/api/v1/capa-attachments/${att.id}/delete`).set(h).send({ reason: 'Wrong file' }).expect(200)).body;
    expect(removed).toMatchObject({ deleteReason: 'Wrong file', deletedAt: expect.any(String) });
    expect((await api().get(`/api/v1/capas/${ctx.c2}/attachments`).set(h).expect(200)).body.data).toHaveLength(0);
    expect((await api().get(`/api/v1/capas/${ctx.c2}/attachments?deleted=include`).set(h).expect(200)).body.data).toHaveLength(1);
    const restored = (await api().post(`/api/v1/capa-attachments/${att.id}/restore`).set(h).expect(200)).body;
    expect(restored.deletedAt).toBeNull();
    await api().get(`/api/v1/capas/${ctx.c2}/attachments`).set(await as(ids.ownerB, ids.orgB)).expect(404);
    await api().post(`/api/v1/capa-attachments/${att.id}/delete`).set(await as(ids.ownerB, ids.orgB)).send({ reason: 'Hijacked' }).expect(404);
  });

  it('closes a verified 8D with a recognition note; closed is read-only; reopening undoes it', async () => {
    const h = await owner();
    // Get the 8D ready: every earlier step done (marked directly), corrective actions done and verified.
    await api().post(`/api/v1/capa-actions/${ctx.second}/complete`).set(h).send({ evidenceNote: 'Back in place' }).expect(200);
    const verified = (await api().post(`/api/v1/capas/${ctx.c2}/verifications`).set(h).send({ effective: true, method: 'Final audit' }).expect(201)).body;
    expect(verified.stage).toBe('verified_effective');
    await admin.query(`update public.capa_steps set completed_at = now() where capa_id = $1 and step <> 'd8' and completed_at is null`, [ctx.c2]);
    expect((await api().get(`/api/v1/capas/${ctx.c2}`).set(h).expect(200)).body.steps[8].problems).toEqual([]);
    await api().post(`/api/v1/capas/${ctx.c2}/close`).set(await as(ids.inspectorA)).send({}).expect(403);
    const closed = (await api().post(`/api/v1/capas/${ctx.c2}/close`).set(h).send({ recognition: 'Thank you to the team' }).expect(200)).body;
    expect(closed).toMatchObject({ stage: 'closed', d8Recognition: 'Thank you to the team', closedBy: { name: 'Ada Owner' }, closedAt: expect.any(String) });
    expect(closed.steps[8].completed).toBe(true);
    await api().post(`/api/v1/capas/${ctx.c2}/close`).set(h).send({}).expect(409);
    await api().patch(`/api/v1/capas/${ctx.c2}`).set(h).send({ title: 'Changed after closure' }).expect(409);
    await admin.query(`insert into storage.objects (bucket_id, name) values ('capa-files', $1)`, [`${folder()}u2-late.pdf`]);
    await api().post(`/api/v1/capas/${ctx.c2}/attachments`).set(h).send({ storagePath: `${folder()}u2-late.pdf`, fileName: 'late.pdf', sizeBytes: 1 }).expect(409);
    expect((await api().get(`/api/v1/capas/${ctx.c2}/attachments`).set(h).expect(200)).body.data).toHaveLength(1); // still listed
    const reopened = (await api().post(`/api/v1/capas/${ctx.c2}/reopen`).set(h).send({ reason: 'Customer wants more evidence' }).expect(200)).body;
    expect(reopened.stage).toBe('verified_effective');
    expect(reopened.closedAt).toBeNull();
    expect(reopened.steps[8].completed).toBe(false);
  });

  it('is private to the organisation', async () => {
    await api().post(`/api/v1/capas/${ctx.c2}/close`).set(await as(ids.ownerB, ids.orgB)).send({}).expect(404);
  });
});

describe('actions are worked by the person they are assigned to', () => {
  const owner = () => as(ids.ownerA);

  it('the owner writes and assigns an action; the actionee sees it in My actions, updates the findings and closes it', async () => {
    const h = await owner();
    const inspector = await as(ids.inspectorA);
    ctx.c6 = (await api().post('/api/v1/capas').set(h).send({ title: 'Actionee flow', problemStatement: 'Test' }).expect(201)).body.id;
    const team = (await api().post(`/api/v1/capas/${ctx.c6}/team`).set(h).send({ membershipId: ctx.mInspector, role: 'member' }).expect(201)).body.team;
    const t = team.find((m: { membershipId: string }) => m.membershipId === ctx.mInspector).id;
    const detail = (await api().post(`/api/v1/capas/${ctx.c6}/actions`).set(h).send({ phase: 'interim', description: 'Quarantine lot 90', ownerTeamMemberId: t, dueDate: '2099-03-01' }).expect(201)).body;
    const action = detail.actions[0];
    expect(action).toMatchObject({ owner: { teamMemberId: t }, isAssignee: false });

    const mine = (await api().get('/api/v1/capa-actions/mine').set(inspector).expect(200)).body;
    expect(mine.data).toContainEqual(expect.objectContaining({ id: action.id, capaId: ctx.c6, description: 'Quarantine lot 90', status: 'open', locked: false, capaReference: expect.stringMatching(/^CAPA-/) }));
    expect(mine.openCount).toBeGreaterThanOrEqual(1);
    expect((await api().get('/api/v1/capa-actions/mine').set(h).expect(200)).body.data.some((a: { id: string }) => a.id === action.id)).toBe(false); // not the owner's

    const asActionee = (await api().get(`/api/v1/capas/${ctx.c6}`).set(inspector).expect(200)).body.actions[0];
    expect(asActionee.isAssignee).toBe(true);
    await api().post(`/api/v1/capa-actions/${action.id}/complete`).set(inspector).send({}).expect(409); // findings first
    const noted = (await api().patch(`/api/v1/capa-actions/${action.id}`).set(inspector).send({ evidenceNote: '60 of 120 parts quarantined' }).expect(200)).body.actions[0];
    expect(noted).toMatchObject({ evidenceNote: '60 of 120 parts quarantined', status: 'open' });
    const closed = (await api().post(`/api/v1/capa-actions/${action.id}/complete`).set(inspector).send({ evidenceNote: 'All 120 parts quarantined and tagged' }).expect(200)).body.actions[0];
    expect(closed).toMatchObject({ status: 'done', evidenceNote: 'All 120 parts quarantined and tagged', doneBy: expect.objectContaining({ id: ids.inspectorA }) });
    expect((await api().get('/api/v1/capa-actions/mine').set(inspector).expect(200)).body.data.some((a: { id: string }) => a.id === action.id)).toBe(false);
    expect((await api().get('/api/v1/capa-actions/mine?status=done').set(inspector).expect(200)).body.data.some((a: { id: string }) => a.id === action.id)).toBe(true);
    ctx.act6 = action.id;
  });

  it('once the step is complete the action is read-only and says so; reopening the step lets the actionee work again', async () => {
    const h = await owner();
    const inspector = await as(ids.inspectorA);
    await admin.query(`update public.capa_steps set completed_at = now() where capa_id = $1 and step = 'd3'`, [ctx.c6]);
    const locked = await api().post(`/api/v1/capa-actions/${ctx.act6}/reopen`).set(inspector).send();
    expect(locked.status).toBe(409);
    expect(locked.body.error.message).toBe('D3 is complete; reopen it to change the actions');
    expect((await api().get('/api/v1/capa-actions/mine?status=done').set(inspector).expect(200)).body.data.find((a: { id: string }) => a.id === ctx.act6).locked).toBe(true);
    await api().post(`/api/v1/capas/${ctx.c6}/actions`).set(h).send({ phase: 'interim', description: 'Added while D3 is complete' }).expect(409);
    await api().post(`/api/v1/capas/${ctx.c6}/reopen-step`).set(h).send({ step: 'd3', reason: 'More to contain' }).expect(200);
    await api().post(`/api/v1/capa-actions/${ctx.act6}/reopen`).set(inspector).send().expect(200);
  });

  it('is private to the organisation', async () => {
    const mine = (await api().get('/api/v1/capa-actions/mine?status=all').set(await as(ids.ownerB, ids.orgB)).expect(200)).body;
    expect(mine.data).toEqual([]);
    await api().patch(`/api/v1/capa-actions/${ctx.act6}`).set(await as(ids.ownerB, ids.orgB)).send({ evidenceNote: 'Hijacked' }).expect(404);
  });
});
