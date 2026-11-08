import { diffVersions, VContent, VQuestion } from './audit-versions';

const q = (sequence: number, question: string, over: Partial<VQuestion> = {}): VQuestion => ({
  sequence, question, guidance: null, answerType: 'pass_fail', passAnswer: null, unit: null, lowerLimit: null, upperLimit: null, nominal: null, options: null, ratingMax: null, passRating: null, critical: false, ...over,
});
const content = (over: Partial<VContent> = {}): VContent => ({
  title: 'Layered process audit', auditType: 'layered_process', purpose: null, procedure: 'Walk the cell.', passMark: 90,
  questions: [q(1, 'Is the cell clean?', { critical: true }), q(2, 'Coolant concentration', { answerType: 'numeric', unit: '%', lowerLimit: 6, upperLimit: 9 })],
  targets: [{ kind: 'machine', ref: 'm1', label: 'CNC-1 · Lathe' }],
  ...over,
});

describe('diffVersions', () => {
  it('says nothing changed between identical versions', () => {
    const d = diffVersions(content(), content());
    expect(d.summary).toEqual([]);
    expect(d.header).toEqual([]);
    expect(d.questions).toEqual({ added: [], removed: [], changed: [], moved: [] });
    expect(d.targets).toEqual({ added: [], removed: [] });
  });

  it('reports each header field that changed, with the values', () => {
    const d = diffVersions(content(), content({ title: 'Layered process audit, CNC', passMark: 95, purpose: 'Keep to the written process', procedure: null, auditType: 'process' }));
    expect(d.header).toEqual([
      { field: 'title', before: 'Layered process audit', after: 'Layered process audit, CNC' },
      { field: 'auditType', before: 'layered_process', after: 'process' },
      { field: 'purpose', before: null, after: 'Keep to the written process' },
      { field: 'procedure', before: 'Walk the cell.', after: null },
      { field: 'passMark', before: 90, after: 95 },
    ]);
    expect(d.summary).toEqual(['Title changed', 'Type changed', 'Purpose changed', 'Procedure changed', 'Pass mark 90 → 95']);
  });

  it('finds added and removed questions', () => {
    const d = diffVersions(content(), content({ questions: [q(1, 'Is the cell clean?', { critical: true }), q(2, 'Is the floor clear?'), q(3, 'Are the guards fitted?')] }));
    // "Coolant concentration" went; two new ones came, one of them in the place it held, so it reads as a reworded question.
    expect(d.questions.added.map((x) => x.question)).toEqual(['Are the guards fitted?']);
    expect(d.questions.removed).toEqual([]);
    expect(d.questions.changed.map((c) => [c.before.question, c.after.question])).toEqual([['Coolant concentration', 'Is the floor clear?']]);
    expect(d.summary).toEqual(['1 question added', '1 question changed']);
  });

  it('reads a removal as a removal when nothing sits in its place', () => {
    const d = diffVersions(content(), content({ questions: [q(1, 'Is the cell clean?', { critical: true })] }));
    expect(d.questions.removed.map((x) => x.question)).toEqual(['Coolant concentration']);
    expect(d.questions.changed).toEqual([]);
    expect(d.summary).toEqual(['1 question removed']);
  });

  it('names the fields of a question that changed, matched by its wording', () => {
    const d = diffVersions(content(), content({
      questions: [q(1, 'Is the cell clean?', { critical: false }), q(2, 'Coolant concentration', { answerType: 'numeric', unit: '%', lowerLimit: 6, upperLimit: 9.5 })],
    }));
    expect(d.questions.changed.map((c) => [c.after.question, c.fields])).toEqual([['Is the cell clean?', ['critical']], ['Coolant concentration', ['upperLimit']]]);
    expect(d.summary).toEqual(['2 questions changed']);
  });

  it('treats a reworded question in the same place as changed, not as removed and added', () => {
    const d = diffVersions(content(), content({ questions: [q(1, 'Is the cell clean and tidy?', { critical: true }), q(2, 'Coolant concentration', { answerType: 'numeric', unit: '%', lowerLimit: 6, upperLimit: 9 })] }));
    expect(d.questions.changed).toHaveLength(1);
    expect(d.questions.changed[0].fields).toEqual(['question']);
    expect(d.questions.added).toEqual([]);
    expect(d.questions.removed).toEqual([]);
  });

  it('reports a question that only moved', () => {
    const d = diffVersions(content(), content({ questions: [q(1, 'Coolant concentration', { answerType: 'numeric', unit: '%', lowerLimit: 6, upperLimit: 9 }), q(2, 'Is the cell clean?', { critical: true })] }));
    expect(d.questions.moved).toEqual([{ question: 'Coolant concentration', from: 2, to: 1 }, { question: 'Is the cell clean?', from: 1, to: 2 }]);
    expect(d.questions.changed).toEqual([]);
    expect(d.summary).toEqual(['2 questions moved']);
  });

  it('compares options as values, so equal lists are not a change', () => {
    const a = content({ questions: [q(1, 'Floor', { answerType: 'multiple_choice', options: [{ label: 'Clean', passes: true }, { label: 'Dirty', passes: false }] })] });
    const same = content({ questions: [q(1, 'Floor', { answerType: 'multiple_choice', options: [{ label: 'Clean', passes: true }, { label: 'Dirty', passes: false }] })] });
    const other = content({ questions: [q(1, 'Floor', { answerType: 'multiple_choice', options: [{ label: 'Clean', passes: true }, { label: 'Dirty', passes: true }] })] });
    expect(diffVersions(a, same).questions.changed).toEqual([]);
    expect(diffVersions(a, other).questions.changed[0].fields).toEqual(['options']);
  });

  it('reports what the audit became relevant to, and stopped being relevant to, ignoring the case of an operation', () => {
    const before = content({ targets: [{ kind: 'machine', ref: 'm1', label: 'CNC-1 · Lathe' }, { kind: 'operation', ref: 'OP-10', label: 'OP-10' }] });
    const after = content({ targets: [{ kind: 'operation', ref: 'op-10', label: 'op-10' }, { kind: 'department', ref: 'd1', label: 'MACH · Machining' }] });
    const d = diffVersions(before, after);
    expect(d.targets.added.map((t) => t.label)).toEqual(['MACH · Machining']);
    expect(d.targets.removed.map((t) => t.label)).toEqual(['CNC-1 · Lathe']);
    expect(d.summary).toEqual(['Now relevant to MACH · Machining', 'No longer relevant to CNC-1 · Lathe']);
  });

  it('pairs a repeated wording one for one', () => {
    const twice = content({ questions: [q(1, 'Is it there?'), q(2, 'Is it there?')] });
    const once = content({ questions: [q(1, 'Is it there?')] });
    const d = diffVersions(twice, once);
    expect(d.questions.removed).toHaveLength(1);
    expect(d.questions.added).toEqual([]);
  });
});
