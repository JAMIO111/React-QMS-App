/**
 * Every list of people the pickers use carries each member's profile picture path (`avatarPath`, null without one), so a dropdown can draw
 * their photo instead of their initials: the members directory, the 8D, SCAR, FMEA, document, change and person-field lists, and the
 * members that can be linked to an employee.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('c6e');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });
const picture = () => `users/${ids.ownerA}/avatar.webp`;

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-avatars');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
  await admin.query(`update public.profiles set avatar_path = $2 where id = $1`, [ids.ownerA, picture()]);
  await admin.query(`update public.profiles set avatar_path = null where id = $1`, [ids.inspectorA]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

type Person = Record<string, unknown> & { avatarPath?: string | null };
const find = (rows: Person[], key: string, id: string) => rows.find((r) => r[key] === id);

describe('people lists for pickers', () => {
  it.each([
    ['/api/v1/members', 'userId', (b: { data: Person[] }) => b.data],
    ['/api/v1/capas/people', 'userId', (b: { data: Person[] }) => b.data],
    ['/api/v1/supplier-quality/scar-people', 'userId', (b: { data: Person[] }) => b.data],
    ['/api/v1/fmea-people', 'id', (b: { data: Person[] }) => b.data],
    ['/api/v1/document-signers', 'id', (b: { data: Person[] }) => b.data],
    ['/api/v1/change-signers', 'id', (b: { data: Person[] }) => b.data],
    ['/api/v1/custom-fields/people', 'id', (b: { data: Person[] }) => b.data],
    ['/api/v1/employees/login-candidates', 'userId', (b: { data: Person[] }) => b.data],
  ])('%s carries the profile picture path, and null without one', async (path, key, rowsOf) => {
    const rows = rowsOf((await api().get(path).set(await as(ids.ownerA)).expect(200)).body);
    expect(find(rows, key, ids.ownerA)?.avatarPath).toBe(picture());
    const inspector = find(rows, key, ids.inspectorA);
    if (inspector) expect(inspector.avatarPath).toBeNull();
  });

  it('shows another organisation nothing of these people', async () => {
    const rows = (await api().get('/api/v1/custom-fields/people').set(await as(ids.ownerB, ids.orgB)).expect(200)).body.data as Person[];
    expect(find(rows, 'id', ids.ownerA)).toBeUndefined();
  });
});
