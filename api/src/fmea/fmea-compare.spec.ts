import { compareRevisions, CompareRow } from './fmea-compare';

const row = (id: string, kind: CompareRow['kind'], revisionId: string, parentId: string | null, prevRowId: string | null, fields: CompareRow['fields']): CompareRow => ({
  id, kind, revisionId, parentId, prevRowId, fields,
});

// Revision A: item "Bracket" > function "Hold the bore" > mode "Bore oversize" > cause "Tool wear" (O 8, D 8) and cause "Wrong offset".
const A = 'rev-a';
const B = 'rev-b';
const C = 'rev-c';
const a = [
  row('a-item', 'item', A, null, null, { name: 'Bracket' }),
  row('a-fn', 'function', A, 'a-item', null, { text: 'Hold the bore' }),
  row('a-mode', 'failure_mode', A, 'a-fn', null, { text: 'Bore oversize' }),
  row('a-c1', 'cause', A, 'a-mode', null, { text: 'Tool wear', occurrence: 8, detection: 8, rpn: 512 }),
  row('a-c2', 'cause', A, 'a-mode', null, { text: 'Wrong offset', occurrence: 3, detection: 3, rpn: 72 }),
];
// Revision B continues all of A, changes the first cause's occurrence, drops "Wrong offset" and adds a cause.
const b = [
  row('b-item', 'item', B, null, 'a-item', { name: 'Bracket' }),
  row('b-fn', 'function', B, 'b-item', 'a-fn', { text: 'Hold the bore' }),
  row('b-mode', 'failure_mode', B, 'b-fn', 'a-mode', { text: 'Bore oversize' }),
  row('b-c1', 'cause', B, 'b-mode', 'a-c1', { text: 'Tool wear', occurrence: 3, detection: 8, rpn: 192 }),
  row('b-c3', 'cause', B, 'b-mode', null, { text: 'Coolant dirty', occurrence: 4, detection: 4, rpn: 128 }),
];
// Revision C continues B without any change.
const c = [
  row('c-item', 'item', C, null, 'b-item', { name: 'Bracket' }),
  row('c-fn', 'function', C, 'c-item', 'b-fn', { text: 'Hold the bore' }),
  row('c-mode', 'failure_mode', C, 'c-fn', 'b-mode', { text: 'Bore oversize' }),
  row('c-c1', 'cause', C, 'c-mode', 'b-c1', { text: 'Tool wear', occurrence: 3, detection: 8, rpn: 192 }),
  row('c-c3', 'cause', C, 'c-mode', 'b-c3', { text: 'Coolant dirty', occurrence: 4, detection: 4, rpn: 128 }),
];

describe('compareRevisions', () => {
  it('names what was added, removed and changed, with each changed field', () => {
    const r = compareRevisions([...a, ...b], A, B);
    expect(r.counts).toEqual({ added: 1, removed: 1, changed: 1, same: 3 });
    const changed = r.changes.find((x) => x.change === 'changed')!;
    expect(changed.label).toBe('Tool wear');
    expect(changed.path).toEqual(['Bracket', 'Hold the bore', 'Bore oversize']);
    expect(changed.fields).toEqual([
      { field: 'occurrence', from: 8, to: 3 },
      { field: 'rpn', from: 512, to: 192 },
    ]);
    expect(r.changes.find((x) => x.change === 'added')!.label).toBe('Coolant dirty');
    expect(r.changes.find((x) => x.change === 'removed')!.label).toBe('Wrong offset');
  });

  it('follows a row back through the revisions in between', () => {
    const r = compareRevisions([...a, ...b, ...c], A, C);
    expect(r.counts).toEqual({ added: 1, removed: 1, changed: 1, same: 3 });
    expect(r.changes.find((x) => x.change === 'changed')!.rowId).toBe('c-c1');
  });

  it('says nothing changed for two copies of the same revision', () => {
    const r = compareRevisions([...b, ...c], B, C);
    expect(r.changes).toEqual([]);
    expect(r.counts.same).toBe(5);
  });

  it('never matches a row by its wording: a row with no lineage is added, and the old one removed', () => {
    const lonely = [row('x-c', 'cause', B, 'b-mode', null, { text: 'Tool wear', occurrence: 8, detection: 8, rpn: 512 })];
    const r = compareRevisions([...a, ...lonely], A, B);
    expect(r.changes.filter((x) => x.label === 'Tool wear').map((x) => x.change).sort()).toEqual(['added', 'removed']);
  });

  it('does not let two new rows claim the same old one', () => {
    const twins = [
      row('t1', 'cause', B, 'b-mode', 'a-c1', { text: 'Tool wear', occurrence: 8, detection: 8, rpn: 512 }),
      row('t2', 'cause', B, 'b-mode', 'a-c1', { text: 'Tool wear (copy)', occurrence: 8, detection: 8, rpn: 512 }),
    ];
    const r = compareRevisions([...a, ...twins], A, B);
    expect(r.changes.filter((x) => x.change === 'added')).toHaveLength(1);
  });

  it('survives a loop in the lineage', () => {
    const loop = [row('l1', 'cause', B, null, 'l2', { text: 'x' }), row('l2', 'cause', B, null, 'l1', { text: 'y' })];
    expect(compareRevisions(loop, A, B).counts.added).toBe(2);
  });
});
