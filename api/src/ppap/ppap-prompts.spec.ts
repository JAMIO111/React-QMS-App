import { attentionFor, customerState, PackageRow, PartCustomer, sourceApplies, sourcePrompts } from './ppap-prompts';

const pkg = (over: Partial<PackageRow>): PackageRow => ({ id: 'k1', reference: 'PPAP-26-0001', customerId: 'c1', partRevisionId: 'rA', status: 'approved', createdAt: '2026-01-01 10:00:00', interimExpiresOn: null, nextReviewOn: '2027-01-01', ...over });
const TODAY = '2026-06-10';

describe('customerState', () => {
  it('is none with no package for the revision, and notes an earlier approval without counting it', () => {
    expect(customerState([], 'rA', TODAY).state).toBe('none');
    const s = customerState([pkg({ partRevisionId: 'rOld' })], 'rA', TODAY);
    expect(s.state).toBe('none');
    expect(s.earlier).toMatchObject({ state: 'approved', partRevisionId: 'rOld' });
  });

  it('lets the newest package for the revision decide', () => {
    const s = customerState([pkg({ id: 'old', status: 'approved' }), pkg({ id: 'new', status: 'in_preparation', createdAt: '2026-03-01 10:00:00', reference: 'PPAP-26-0002' })], 'rA', TODAY);
    expect(s).toMatchObject({ state: 'in_preparation', submissionId: 'new', reference: 'PPAP-26-0002', nextReviewOn: null });
  });

  it('keeps the interim end date only while interim, and the review date only while approved', () => {
    expect(customerState([pkg({ status: 'interim_approved', interimExpiresOn: '2026-07-01' })], 'rA', TODAY)).toMatchObject({ state: 'interim', interimExpiresOn: '2026-07-01', nextReviewOn: null });
    expect(customerState([pkg({ status: 'interim_approved', interimExpiresOn: '2026-06-09' })], 'rA', TODAY).state).toBe('interim_lapsed');
    expect(customerState([pkg({})], 'rA', TODAY)).toMatchObject({ state: 'approved', nextReviewOn: '2027-01-01', interimExpiresOn: null });
  });
});

const cust = (over: Partial<PartCustomer>): PartCustomer => ({ id: 'c1', name: 'Wayne Ltd', requires: true, state: 'approved', submissionId: 'k1', reference: 'PPAP-26-0001', interimExpiresOn: null, nextReviewOn: null, earlier: null, ...over });
const att = (customers: PartCustomer[], over: Partial<{ lastProducedOn: string | null }> = {}) => attentionFor({ partNumber: 'PN-1', revisionLabel: 'B', today: TODAY, lastProducedOn: null, customers, ...over });

describe('attentionFor', () => {
  it('says nothing for an approved revision, and nothing at all for a customer that does not require PPAP', () => {
    expect(att([cust({})])).toEqual([]);
    expect(att([cust({ state: 'none', requires: false, submissionId: null })])).toEqual([]);
  });

  it('warns when the revision has no PPAP, and mentions an earlier approval', () => {
    const r = att([cust({ state: 'none', submissionId: null, reference: null, earlier: { state: 'approved', partRevisionId: 'rA', reference: 'PPAP-25-0009' } })]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: 'none', tone: 'warning', customerName: 'Wayne Ltd' });
    expect(r[0].message).toBe('PN-1 rev B has no PPAP for Wayne Ltd (an earlier revision was approved)');
  });

  it('tells, without warning, that one is being prepared or waiting for the customer', () => {
    expect(att([cust({ state: 'in_preparation' })])[0]).toMatchObject({ code: 'in_preparation', tone: 'info' });
    expect(att([cust({ state: 'submitted' })])[0]).toMatchObject({ code: 'submitted', tone: 'info' });
  });

  it('is critical for a rejection and a lapsed interim approval, with the dates in day/month/year', () => {
    expect(att([cust({ state: 'rejected' })])[0]).toMatchObject({ code: 'rejected', tone: 'critical' });
    const l = att([cust({ state: 'interim_lapsed', interimExpiresOn: '2026-06-01' })])[0];
    expect(l).toMatchObject({ code: 'interim_lapsed', tone: 'critical' });
    expect(l.message).toContain('01/06/2026');
  });

  it('warns of an interim approval only inside the last 30 days, and counts them in words', () => {
    expect(att([cust({ state: 'interim', interimExpiresOn: '2026-09-01' })])).toEqual([]);
    const near = att([cust({ state: 'interim', interimExpiresOn: '2026-06-20' })])[0];
    expect(near).toMatchObject({ code: 'interim_ending', tone: 'warning' });
    expect(near.message).toContain('10 days left');
    expect(att([cust({ state: 'interim', interimExpiresOn: '2026-06-11' })])[0].message).toContain('1 day left');
    expect(att([cust({ state: 'interim', interimExpiresOn: TODAY })])[0].message).toContain('today is the last day');
  });

  it('warns when an approved part has not been produced for over a year, but not when it has never been produced', () => {
    expect(att([cust({})], { lastProducedOn: '2025-06-09' })[0]).toMatchObject({ code: 'idle', tone: 'warning' });
    expect(att([cust({})], { lastProducedOn: '2025-06-10' })).toEqual([]);
    expect(att([cust({})], { lastProducedOn: null })).toEqual([]);
  });

  it('puts the worst first', () => {
    const r = att([cust({ id: 'a', name: 'A Ltd', state: 'submitted' }), cust({ id: 'b', name: 'B Ltd', state: 'rejected' }), cust({ id: 'c', name: 'C Ltd', state: 'none', submissionId: null })]);
    expect(r.map((x) => x.tone)).toEqual(['critical', 'warning', 'info']);
  });
});

describe('sourcePrompts and sourceApplies', () => {
  const parts = [
    { id: 'p1', partNumber: 'PN-1', name: 'One', customers: [{ id: 'c1', name: 'Wayne', requires: true, raised: null }, { id: 'c2', name: 'Stark', requires: false, raised: null }] },
    { id: 'p2', partNumber: 'PN-2', name: 'Two', customers: [{ id: 'c1', name: 'Wayne', requires: true, raised: { id: 'k', reference: 'PPAP-26-0001', status: 'draft' } }] },
  ];
  it('suggests a PPAP only for a customer that requires one and has none raised from this record', () => {
    const r = sourcePrompts('change', 'CHG-26-0001', parts);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: 'change_may_need_ppap', partNumber: 'PN-1', customerName: 'Wayne' });
    expect(r[0].message).toBe('Change CHG-26-0001 may need a new PPAP for PN-1 to Wayne');
    expect(sourcePrompts('control_plan_revision', 'CP-1 rev B', parts)[0].code).toBe('plan_may_need_ppap');
  });

  it('applies to an approved change of the right type and to an approved or effective plan revision', () => {
    expect(sourceApplies('change', { stage: 'approved', typeKey: 'material' })).toBe(true);
    expect(sourceApplies('change', { stage: 'implementing', typeKey: 'tooling' })).toBe(true);
    expect(sourceApplies('change', { stage: 'draft', typeKey: 'material' })).toBe(false);
    expect(sourceApplies('change', { stage: 'approved', typeKey: 'documentation' })).toBe(false);
    expect(sourceApplies('change', { stage: 'closed', typeKey: 'process' })).toBe(false);
    expect(sourceApplies('control_plan_revision', { status: 'effective' })).toBe(true);
    expect(sourceApplies('control_plan_revision', { status: 'draft' })).toBe(false);
  });
});
