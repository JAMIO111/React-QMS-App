/**
 * The employees register through the API: create, validate, list (search, filters, sort, pages), edit, deactivate, the site/department rule,
 * the unique employee number, the lookup for pickers, and permissions / tenancy.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('ee');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const ctx: Record<string, string> = {};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-employees');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  const h = await as(ids.ownerA);
  ctx.siteB = (await api().post('/api/v1/sites').set(h).send({ code: 'PLB', name: 'Plant B' }).expect(201)).body.id;
  ctx.deptA = (await api().post('/api/v1/departments').set(h).send({ siteId: ids.siteA, code: 'QA', name: 'Quality' }).expect(201)).body.id;
  ctx.deptB = (await api().post('/api/v1/departments').set(h).send({ siteId: ctx.siteB, code: 'MFG', name: 'Manufacturing' }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('creating and reading', () => {
  it('adds an employee with a site and department, and reads it back', async () => {
    const h = await as(ids.ownerA);
    const res = await api().post('/api/v1/employees').set(h).send({ firstName: 'Ada', surname: 'Lovelace', jobTitle: 'Inspector', employeeNumber: 'E-001', email: 'ada@example.test', departmentId: ctx.deptA }).expect(201);
    ctx.ada = res.body.id;
    expect(res.body).toMatchObject({
      name: 'Ada Lovelace', firstName: 'Ada', surname: 'Lovelace', jobTitle: 'Inspector', employeeNumber: 'E-001', email: 'ada@example.test', active: true, hasLogin: false,
      site: { id: ids.siteA, code: expect.any(String) }, department: { id: ctx.deptA, code: 'QA', name: 'Quality' },
    });
    expect((await api().get(`/api/v1/employees/${ctx.ada}`).set(h).expect(200)).body.name).toBe('Ada Lovelace');
  });

  it('needs a first name and surname and refuses unknown fields, a bad email and an employee number already used (any case)', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/employees').set(h).send({ firstName: 'No', surname: '' }).expect(400);
    await api().post('/api/v1/employees').set(h).send({ firstName: 'No' }).expect(400);
    await api().post('/api/v1/employees').set(h).send({ firstName: 'X', surname: 'Y', email: 'nope' }).expect(400);
    await api().post('/api/v1/employees').set(h).send({ firstName: 'X', surname: 'Y', hacked: true }).expect(400);
    const dup = await api().post('/api/v1/employees').set(h).send({ firstName: 'Dup', surname: 'Number', employeeNumber: 'e-001' }).expect(409);
    expect(dup.body.error.code).toBe('conflict');
  });

  it('refuses a department at another site than the one named, and fills the site from a department', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/employees').set(h).send({ firstName: 'Wrong', surname: 'Place', siteId: ids.siteA, departmentId: ctx.deptB }).expect(400);
    const ok = (await api().post('/api/v1/employees').set(h).send({ firstName: 'Grace', surname: 'Hopper', jobTitle: 'Machinist', departmentId: ctx.deptB }).expect(201)).body;
    ctx.grace = ok.id;
    expect(ok.site.id).toBe(ctx.siteB);
  });
});

describe('the register list', () => {
  beforeAll(async () => {
    const h = await as(ids.ownerA);
    for (const [first, surname] of [['Alan', 'Turing'], ['Katherine', 'Johnson'], ['Margaret', 'Hamilton']]) {
      await api().post('/api/v1/employees').set(h).send({ firstName: first, surname, jobTitle: 'Engineer' }).expect(201);
    }
  });

  it('pages, counts and sorts on the server', async () => {
    const h = await as(ids.ownerA);
    const page = (await api().get('/api/v1/employees?pageSize=2&page=1').set(h).expect(200)).body;
    expect(page).toMatchObject({ page: 1, pageSize: 2, total: 5 });
    expect(page.data.map((e: { name: string }) => e.name)).toEqual(['Margaret Hamilton', 'Grace Hopper']); // by surname
    const desc = (await api().get('/api/v1/employees?sort=name&order=desc&pageSize=1').set(h).expect(200)).body.data[0].name;
    expect(desc).toBe('Alan Turing');
    for (const sort of ['name', 'jobTitle', 'employeeNumber', 'email', 'site', 'department', 'status', 'createdAt']) {
      await api().get(`/api/v1/employees?sort=${sort}`).set(h).expect(200);
    }
    await api().get('/api/v1/employees?sort=nonsense').set(h).expect(400);
    expect((await api().get('/api/v1/employees?pageSize=2&page=3').set(h).expect(200)).body.data).toHaveLength(1);
  });

  it('searches name, job title, number and email, and filters by site and department', async () => {
    const h = await as(ids.ownerA);
    const names = async (qs: string) => (await api().get(`/api/v1/employees?${qs}`).set(h).expect(200)).body.data.map((e: { name: string }) => e.name).sort();
    expect(await names('q=lovelace')).toEqual(['Ada Lovelace']);
    expect(await names('q=ada%20love')).toEqual(['Ada Lovelace']);
    expect(await names('q=machinist')).toEqual(['Grace Hopper']);
    expect(await names('q=E-001')).toEqual(['Ada Lovelace']);
    expect(await names('q=ada@example')).toEqual(['Ada Lovelace']);
    expect(await names(`siteId=${ctx.siteB}`)).toEqual(['Grace Hopper']);
    expect(await names(`departmentId=${ctx.deptA}`)).toEqual(['Ada Lovelace']);
    expect(await names('q=%25')).toEqual([]); // a percent sign is searched for, not a wildcard
  });
});

describe('editing and deactivating', () => {
  it('edits details; moving to another site drops a department that is not there; deactivating hides them from the active filter', async () => {
    const h = await as(ids.ownerA);
    const edited = (await api().patch(`/api/v1/employees/${ctx.ada}`).set(h).send({ jobTitle: 'Lead inspector', email: null, employeeNumber: null }).expect(200)).body;
    expect(edited).toMatchObject({ jobTitle: 'Lead inspector', email: null, employeeNumber: null, department: { id: ctx.deptA } });
    const moved = (await api().patch(`/api/v1/employees/${ctx.ada}`).set(h).send({ siteId: ctx.siteB }).expect(200)).body;
    expect(moved.site.id).toBe(ctx.siteB);
    expect(moved.department).toBeNull();
    await api().patch(`/api/v1/employees/${ctx.ada}`).set(h).send({ siteId: ids.siteA, departmentId: ctx.deptB }).expect(400);

    await api().patch(`/api/v1/employees/${ctx.grace}`).set(h).send({ active: false }).expect(200);
    const active = (await api().get('/api/v1/employees?status=active').set(h).expect(200)).body;
    const inactive = (await api().get('/api/v1/employees?status=inactive').set(h).expect(200)).body;
    expect(active.data.map((e: { name: string }) => e.name)).not.toContain('Grace Hopper');
    expect(inactive.data.map((e: { name: string }) => e.name)).toEqual(['Grace Hopper']);
    expect((await api().get('/api/v1/employees?status=active,inactive').set(h).expect(200)).body.total).toBe(5);
    await api().patch(`/api/v1/employees/${ctx.grace}`).set(h).send({ active: true }).expect(200);
    await api().patch(`/api/v1/employees/${ctx.grace}`).set(h).send({}).expect(400);
  });

  it('has no delete', async () => {
    await api().delete(`/api/v1/employees/${ctx.grace}`).set(await as(ids.ownerA)).expect(404);
  });
});

describe('who may', () => {
  it('lets members read and the lookup serve pickers (inactive included), but only master data managers write', async () => {
    const lookup = (await api().get('/api/v1/employees/lookup').set(await as(ids.inspectorA)).expect(200)).body.data;
    expect(lookup.map((e: { name: string }) => e.name)).toContain('Ada Lovelace');
    await api().get('/api/v1/employees').set(await as(ids.inspectorA)).expect(200);
    await api().post('/api/v1/employees').set(await as(ids.inspectorA)).send({ firstName: 'No', surname: 'Rights' }).expect(403);
    await api().patch(`/api/v1/employees/${ctx.ada}`).set(await as(ids.inspectorA)).send({ jobTitle: 'x' }).expect(403);
  });

  it('keeps organisations apart', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    expect((await api().get('/api/v1/employees').set(other).expect(200)).body.total).toBe(0);
    await api().get(`/api/v1/employees/${ctx.ada}`).set(other).expect(404);
    await api().patch(`/api/v1/employees/${ctx.ada}`).set(other).send({ jobTitle: 'x' }).expect(404);
    await api().post('/api/v1/employees').set(other).send({ firstName: 'Cross', surname: 'Site', siteId: ids.siteA }).expect(400);
    await api().get('/api/v1/employees/not-a-uuid').set(await as(ids.ownerA)).expect(400);
  });
});
