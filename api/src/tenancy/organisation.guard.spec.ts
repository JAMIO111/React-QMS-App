import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { DatabaseService } from '../database/database.service';
import type { ApiRequest } from '../common/request-context';
import { OrganisationGuard, OrganisationScoped } from './organisation.guard';

const ORG = 'AAAAAAAA-0000-0000-0000-00000000000A';

class Scoped {
  @OrganisationScoped('members.manage')
  withPermission() {}
  @OrganisationScoped()
  memberOnly() {}
  open() {}
}

function setup(result: { member: boolean; allowed: boolean }, handler: keyof Scoped, headers: Record<string, string> = { 'x-organisation-id': ORG }) {
  const req = { headers, user: { id: 'u', claims: {} } } as unknown as ApiRequest;
  const queries: unknown[] = [];
  const db = {
    asUser: async (_ctx: unknown, work: (tx: unknown) => unknown) =>
      work({ execute: async (q: unknown) => (queries.push(q), { rows: [result] }) }),
  } as unknown as DatabaseService;
  const context = {
    getHandler: () => Scoped.prototype[handler],
    getClass: () => Scoped,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { guard: new OrganisationGuard(new Reflector(), db), context, req, queries };
}

describe('OrganisationGuard', () => {
  it('ignores routes without an organisation scope', async () => {
    const { guard, context, queries } = setup({ member: false, allowed: false }, 'open', {});
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(queries).toHaveLength(0);
  });

  it('requires a well-formed X-Organisation-Id', async () => {
    await expect(setup({ member: true, allowed: true }, 'memberOnly', {}).guard.canActivate(setup({ member: true, allowed: true }, 'memberOnly', {}).context))
      .rejects.toMatchObject({ code: 'organisation_required' });
    const bad = setup({ member: true, allowed: true }, 'memberOnly', { 'x-organisation-id': 'nope' });
    await expect(bad.guard.canActivate(bad.context)).rejects.toMatchObject({ code: 'invalid_organisation_id' });
  });

  it('answers 404 for non-members, even when the permission check would pass', async () => {
    const { guard, context } = setup({ member: false, allowed: true }, 'memberOnly');
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'organisation_not_found', status: 404 });
  });

  it('answers 403 when the member lacks the permission', async () => {
    const { guard, context } = setup({ member: true, allowed: false }, 'withPermission');
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'forbidden', status: 403, details: { permission: 'members.manage' } });
  });

  it('records the (normalised) organisation on the request when allowed', async () => {
    const { guard, context, req } = setup({ member: true, allowed: true }, 'withPermission');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.organisationId).toBe(ORG.toLowerCase());
  });
});
