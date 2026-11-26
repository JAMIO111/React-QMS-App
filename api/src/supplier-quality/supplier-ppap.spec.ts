import { latestPerPart, ppapForRecommendation, ppapState, ReceivedPackage } from './supplier-ppap';

const pkg = (over: Partial<ReceivedPackage>): ReceivedPackage => ({
  id: 'x', reference: 'PPAP-26-0001', partId: 'p1', partNumber: 'PN-1', partName: 'One', revision: 'A', status: 'approved', createdAt: '2026-01-01 10:00:00', nextReviewOn: null, interimExpiresOn: null, ...over,
});

describe('ppapState', () => {
  it.each([
    ['approved', null, 'approved'],
    ['rejected', null, 'rejected'],
    ['submitted', null, 'submitted'],
    ['draft', null, 'in_preparation'],
    ['in_preparation', null, 'in_preparation'],
    ['ready', null, 'in_preparation'],
  ])('%s is %s', (status, expires, state) => expect(ppapState(status, expires as string | null, '2026-06-10')).toBe(state));

  it('treats an interim approval as valid through the day it runs to, then lapsed', () => {
    expect(ppapState('interim_approved', '2026-06-10', '2026-06-10')).toBe('interim');
    expect(ppapState('interim_approved', '2026-06-10', '2026-06-11')).toBe('interim_lapsed');
    expect(ppapState('interim_approved', '2026-07-01', '2026-06-10')).toBe('interim');
  });

  it('treats an interim approval with no date as valid rather than lapsed', () => {
    expect(ppapState('interim_approved', null, '2026-06-10')).toBe('interim');
  });
});

describe('latestPerPart', () => {
  it('lets the newest package of a part decide, and sorts by part number', () => {
    const rows = [
      pkg({ id: 'old', partId: 'b', partNumber: 'PN-B', status: 'approved', createdAt: '2026-01-01 10:00:00' }),
      pkg({ id: 'new', partId: 'b', partNumber: 'PN-B', status: 'in_preparation', createdAt: '2026-02-01 10:00:00' }),
      pkg({ id: 'a1', partId: 'a', partNumber: 'PN-A' }),
    ];
    expect(latestPerPart(rows).map((r) => r.id)).toEqual(['a1', 'new']);
  });
});

describe('ppapForRecommendation', () => {
  it('separates parts that are not approved from those on a valid interim approval, and ignores approved ones', () => {
    const r = ppapForRecommendation(
      [
        pkg({ partId: '1', partNumber: 'PN-1', status: 'approved' }),
        pkg({ partId: '2', partNumber: 'PN-2', status: 'interim_approved', interimExpiresOn: '2026-07-01' }),
        pkg({ partId: '3', partNumber: 'PN-3', status: 'interim_approved', interimExpiresOn: '2026-05-01' }),
        pkg({ partId: '4', partNumber: 'PN-4', status: 'rejected' }),
        pkg({ partId: '5', partNumber: 'PN-5', status: 'submitted' }),
        pkg({ partId: '6', partNumber: 'PN-6', status: 'draft' }),
      ],
      '2026-06-10',
    );
    expect(r.interim).toEqual(['PN-2']);
    expect(r.notApproved).toEqual(['PN-3', 'PN-4', 'PN-5', 'PN-6']);
  });

  it('is empty when there are no packages', () => {
    expect(ppapForRecommendation([], '2026-06-10')).toEqual({ notApproved: [], interim: [] });
  });
});
