import { blocksOf, diffFiles, diffLines, summarise } from './document-compare';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });

describe('blocksOf', () => {
  it('reads headings, paragraphs, list items and table rows as lines', () => {
    const lines = blocksOf(
      doc(
        h(1, 'Purpose'),
        { type: 'paragraph', content: [{ type: 'text', text: 'Segregate ' }, { type: 'text', marks: [{ type: 'bold' }], text: 'suspect' }, { type: 'text', text: '  parts.' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('Tag it')] }, { type: 'listItem', content: [p('Move it')] }] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p('Who')] }, { type: 'tableCell', content: [p('What')] }] }] },
        p(''),
      ),
    );
    expect(lines).toEqual([
      { text: 'Purpose', block: 'Heading 1' },
      { text: 'Segregate suspect parts.', block: 'Paragraph' },
      { text: 'Tag it', block: 'List item' },
      { text: 'Move it', block: 'List item' },
      { text: 'Who | What', block: 'Table row' },
    ]);
  });

  it('copes with nothing', () => {
    expect(blocksOf(null)).toEqual([]);
    expect(blocksOf({ type: 'doc' })).toEqual([]);
  });
});

describe('diffLines', () => {
  it('marks kept, removed and added blocks in order', () => {
    const before = blocksOf(doc(h(1, 'Purpose'), p('Old step'), p('Keep this')));
    const after = blocksOf(doc(h(1, 'Purpose'), p('Keep this'), p('New step')));
    const changes = diffLines(before, after);
    expect(changes.map((c) => `${c.kind}:${c.text}`)).toEqual(['same:Purpose', 'removed:Old step', 'same:Keep this', 'added:New step']);
    expect(summarise(changes)).toEqual({ added: 1, removed: 1, same: 2 });
  });

  it('treats a first revision as all added', () => {
    expect(diffLines([], blocksOf(doc(p('A')))).map((c) => c.kind)).toEqual(['added']);
  });
});

describe('diffFiles', () => {
  it('matches copied files by the stored file', () => {
    const before = [{ storagePath: 'o/document/r1/a.pdf', fileName: 'a.pdf', role: 'main' }, { storagePath: 'o/document/r1/src.docx', fileName: 'src.docx', role: 'attachment' }];
    const after = [{ storagePath: 'o/document/r2/b.pdf', fileName: 'a.pdf', role: 'main' }, { storagePath: 'o/document/r1/src.docx', fileName: 'src.docx', role: 'attachment' }];
    expect(diffFiles(before, after)).toEqual([
      { kind: 'added', fileName: 'a.pdf', role: 'main' },
      { kind: 'same', fileName: 'src.docx', role: 'attachment' },
      { kind: 'removed', fileName: 'a.pdf', role: 'main' },
    ]);
  });
});
