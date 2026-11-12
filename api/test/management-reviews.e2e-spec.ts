/**
 * Management reviews (MR2) through the API: plan, start (inputs gathered from the dashboards as the caller), commentary, attendees, minutes, decisions, actions,
 * complete (frozen), the action's owner closing it without the permission, previous actions as the next review's input, cancelling, tenancy.
 * The rules are in supabase/tests/management_reviews.test.sql.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds('a1e');
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());
const as = async (user: string, org = ids.orgA) => ({ Authorization: `Bearer ${await token(user)}`, 'X-Organisation-Id': org });

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-mr');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });
});
afterAll(async () => {
  await app?.close();
  await admin?.end();
});

type Input = { id: string; section: string; commentaryOnly: boolean; available: boolean | null; snapshot: { figures: { label: string; value: unknown }[]; lists: { title: string; items: { label: string }[] }[] } | null; reviewed: boolean };

describe('management reviews (MR2)', () => {
  let review = '';
  let action = '';

  it('plans a review with its twelve sections; only managers plan, readers read', async () => {
    const h = await as(ids.ownerA);
    await api().post('/api/v1/management-reviews').set(await as(ids.inspectorA)).send({ title: 'x', periodFrom: '2026-01-01', periodTo: '2026-06-30' }).expect(403);
    await api().get('/api/v1/management-reviews').set(await as(ids.inspectorA)).expect(403);
    await api().post('/api/v1/management-reviews').set(h).send({ title: 'x', periodFrom: '2026-06-30', periodTo: '2026-01-01' }).expect(409);
    const made = (await api().post('/api/v1/management-reviews').set(h).send({ title: 'H1 review', periodFrom: '2026-01-01', periodTo: '2026-06-30', plannedOn: '2026-07-15' }).expect(201)).body;
    review = made.id;
    expect(made).toMatchObject({ status: 'planned', chair: { id: ids.ownerA }, sections: 12, sectionsReviewed: 0, problems: ['Start the review'], canEdit: true, canHold: false });
    expect(made.reference).toMatch(/^MR-\d{2}-01$/);
    expect(made.inputs.map((i: Input) => i.section)[0]).toBe('previous_actions');
    expect(made.inputs.filter((i: Input) => i.commentaryOnly).map((i: Input) => i.section)).toEqual(['context', 'improvement']);
    const listed = (await api().get('/api/v1/management-reviews').set(h).expect(200)).body;
    expect(listed.data.map((r: { id: string }) => r.id)).toContain(review);
  });

  it('starts it and gathers every data section from the dashboards as the caller', async () => {
    const h = await as(ids.ownerA);
    const started = (await api().post(`/api/v1/management-reviews/${review}/start`).set(h).expect(200)).body;
    expect(started.status).toBe('in_progress');
    expect(started.heldOn).toBeTruthy();
    const data = started.inputs.filter((i: Input) => !i.commentaryOnly);
    expect(data).toHaveLength(10);
    expect(data.every((i: Input) => i.available === true && i.snapshot && Array.isArray(i.snapshot.figures))).toBe(true);
    const audits = data.find((i: Input) => i.section === 'audit_results');
    expect(audits.snapshot.figures.map((f: { label: string }) => f.label)).toContain('Pass rate');
    expect(started.inputs.find((i: Input) => i.section === 'context')).toMatchObject({ available: null, snapshot: null });
    await api().patch(`/api/v1/management-reviews/${review}`).set(h).send({ periodTo: '2026-07-31' }).expect(409);
    const again = (await api().post(`/api/v1/management-reviews/${review}/gather`).set(h).send({ sections: ['risks'] }).expect(200)).body;
    expect(again.inputs.find((i: Input) => i.section === 'risks').available).toBe(true);
    await api().post(`/api/v1/management-reviews/${review}/gather`).set(h).send({ sections: ['context'] }).expect(400);
  });

  it('records commentary, attendance, minutes, decisions and actions, then completes and freezes it', async () => {
    const h = await as(ids.ownerA);
    let r = (await api().get(`/api/v1/management-reviews/${review}`).set(h).expect(200)).body;
    const context = r.inputs.find((i: Input) => i.section === 'context');
    const bare = await api().patch(`/api/v1/management-review-inputs/${context.id}`).set(h).send({ reviewed: true }).expect(409);
    expect(bare.body.error.message).toMatch(/Write the commentary/);
    for (const i of r.inputs as Input[]) await api().patch(`/api/v1/management-review-inputs/${i.id}`).set(h).send({ commentary: 'Discussed', reviewed: true }).expect(200);
    await api().put(`/api/v1/management-reviews/${review}/attendees`).set(h).send({ attendees: [{ userId: ids.ownerA, role: 'Chair', attendance: 'present' }, { name: 'Dr Jones', attendance: 'present' }, { userId: ids.inspectorA, attendance: 'apologies' }] }).expect(200);
    await api().put(`/api/v1/management-reviews/${review}/attendees`).set(h).send({ attendees: [{ userId: ids.ownerA, name: 'Both' }] }).expect(400);
    r = (await api().put(`/api/v1/management-reviews/${review}/minutes`).set(h).send({ minutes: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Opened' }] }] } }).expect(200)).body;
    expect(r.minutes.type).toBe('doc');
    expect(r.problems).toEqual(['Record a decision, or say why none was needed']);
    r = (await api().post(`/api/v1/management-reviews/${review}/decisions`).set(h).send({ description: 'Buy a second CMM', category: 'resources' }).expect(201)).body;
    const decision = r.decisions[0].id;
    r = (await api().post(`/api/v1/management-reviews/${review}/actions`).set(h).send({ description: 'Get three quotes', ownerId: ids.inspectorA, dueDate: '2030-01-31', decisionId: decision }).expect(201)).body;
    action = r.actions[0].id;
    expect(r.actions[0]).toMatchObject({ owner: { id: ids.inspectorA }, decisionId: decision, status: 'open' });
    await api().delete(`/api/v1/management-review-decisions/${decision}`).set(h).expect(409);
    expect(r.problems).toEqual([]);
    const done = (await api().post(`/api/v1/management-reviews/${review}/complete`).set(h).send({}).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', canEdit: false, canHold: false });
    await api().patch(`/api/v1/management-reviews/${review}`).set(h).send({ title: 'Later' }).expect(409);
    await api().post(`/api/v1/management-reviews/${review}/decisions`).set(h).send({ description: 'Late', category: 'other' }).expect(409);
  });

  it('lets the action\'s owner close it without the management review permission', async () => {
    const inspector = await as(ids.inspectorA);
    await api().get(`/api/v1/management-reviews/${review}`).set(inspector).expect(403);
    const closed = (await api().post(`/api/v1/management-review-actions/${action}/complete`).set(inspector).send({ note: 'Quotes in the shared folder' }).expect(200)).body;
    expect(closed).toEqual({ id: action, status: 'done' });
    const mine = (await api().get('/api/v1/management-review-actions/mine?status=all').set(inspector).expect(200)).body;
    expect(mine.data).toMatchObject([{ id: action, status: 'done', review: { id: review, title: 'H1 review', status: 'completed' } }]);
    expect(mine.openCount).toBe(0);
    const told = (await api().get('/api/v1/notifications').set(inspector).expect(200)).body.data;
    expect(told.map((n: { entityType: string }) => n.entityType)).toContain('management_review_actions');
    const seen = (await api().get(`/api/v1/management-reviews/${review}`).set(await as(ids.ownerA)).expect(200)).body;
    expect(seen.actions[0]).toMatchObject({ status: 'done', doneNote: 'Quotes in the shared folder' });
  });

  it('lists earlier reviews\' actions in the next review, and cancels with a reason', async () => {
    const h = await as(ids.ownerA);
    const next = (await api().post('/api/v1/management-reviews').set(h).send({ title: 'H2 review', periodFrom: '2026-01-01', periodTo: '2030-12-31' }).expect(409)).body;
    expect(next.error.message).toMatch(/three years/);
    const second = (await api().post('/api/v1/management-reviews').set(h).send({ title: 'H2 review', periodFrom: '2026-07-01', periodTo: '2028-12-31' }).expect(201)).body;
    const started = (await api().post(`/api/v1/management-reviews/${second.id}/start`).set(h).expect(200)).body;
    const previous = started.inputs.find((i: Input) => i.section === 'previous_actions');
    expect(previous.snapshot.lists[0].items.map((i: { label: string }) => i.label)).toContain('Get three quotes');
    await api().post(`/api/v1/management-reviews/${second.id}/cancel`).set(h).send({ reason: 'x' }).expect(400);
    expect((await api().post(`/api/v1/management-reviews/${second.id}/cancel`).set(h).send({ reason: 'Merged with the H1 review' }).expect(200)).body).toMatchObject({ status: 'cancelled', cancelReason: 'Merged with the H1 review' });
  });

  it('sums it up for the home page', async () => {
    const o = (await api().get('/api/v1/management-review-overview').set(await as(ids.ownerA)).expect(200)).body;
    expect(o.lastCompleted).toMatchObject({ id: review, title: 'H1 review', daysAgo: 0 });
    expect(o.next).toBeNull();
    expect(o.actions).toEqual({ open: 0, overdue: 0 });
    expect(o.objectives).toMatchObject({ total: 0 });
    await api().get('/api/v1/management-review-overview').set(await as(ids.inspectorA)).expect(403);
  });

  it('keeps another organisation out', async () => {
    const other = await as(ids.ownerB, ids.orgB);
    await api().get(`/api/v1/management-reviews/${review}`).set(other).expect(404);
    await api().post(`/api/v1/management-review-actions/${action}/reopen`).set(other).expect(404);
    expect((await api().get('/api/v1/management-reviews').set(other).expect(200)).body.data).toEqual([]);
    expect((await api().get('/api/v1/management-review-actions/mine').set(other).expect(200)).body.data).toEqual([]);
  });
});
