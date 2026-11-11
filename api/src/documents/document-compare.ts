/**
 * Comparing two revisions of a document (DC2), as pure functions.
 * Text documents: the TipTap JSON is read block by block (a paragraph, a heading, a list item, a table row) into lines, and the lines are compared
 * with a longest-common-subsequence diff, so a reader sees which blocks were added, removed or kept. File documents: which files were added,
 * removed or kept (a file copied forward points at the same stored file).
 */

type Node = { type?: string; text?: string; content?: Node[]; attrs?: Record<string, unknown> };

export type LineChange = { kind: 'same' | 'added' | 'removed'; text: string; block: string };
export type FileLike = { storagePath: string; fileName: string; role: string };
export type FileChange = { kind: 'same' | 'added' | 'removed'; fileName: string; role: string };

const inlineText = (node: Node): string =>
  node.type === 'text' ? (node.text ?? '') : node.type === 'hardBreak' ? ' ' : (node.content ?? []).map(inlineText).join('');

const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'tableRow', 'horizontalRule']);

/** The document as lines, one per block, each labelled with the kind of block ("Heading 2", "List item", "Table row"). */
export function blocksOf(doc: unknown): { text: string; block: string }[] {
  const out: { text: string; block: string }[] = [];
  const walk = (node: Node, listItem: boolean) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'tableRow') {
      const cells = (node.content ?? []).map((c) => inlineText(c).trim());
      out.push({ text: cells.join(' | '), block: 'Table row' });
      return;
    }
    if (node.type === 'horizontalRule') {
      out.push({ text: '———', block: 'Line' });
      return;
    }
    if (node.type && BLOCKS.has(node.type)) {
      const text = inlineText(node).replace(/\s+/g, ' ').trim();
      if (text) {
        const block = node.type === 'heading' ? `Heading ${Number(node.attrs?.level ?? 1)}` : listItem ? 'List item' : node.type === 'codeBlock' ? 'Code' : 'Paragraph';
        out.push({ text, block });
      }
      return;
    }
    const inList = listItem || node.type === 'listItem';
    (node.content ?? []).forEach((child) => walk(child, inList));
  };
  walk((doc ?? {}) as Node, false);
  return out;
}

/** Longest-common-subsequence diff of two line lists; caps the table at 2,000 × 2,000 lines and falls back to "all removed, all added" beyond it. */
export function diffLines(before: { text: string; block: string }[], after: { text: string; block: string }[]): LineChange[] {
  const a = before;
  const b = after;
  if (a.length * b.length > 4_000_000) {
    return [...a.map((l) => ({ kind: 'removed' as const, ...l })), ...b.map((l) => ({ kind: 'added' as const, ...l }))];
  }
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i].text === b[j].text ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      out.push({ kind: 'same', ...b[j] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'removed', ...a[i++] });
    } else {
      out.push({ kind: 'added', ...b[j++] });
    }
  }
  while (i < n) out.push({ kind: 'removed', ...a[i++] });
  while (j < m) out.push({ kind: 'added', ...b[j++] });
  return out;
}

/** Files kept, added and removed between two revisions (matched by the stored file, then by name and role). */
export function diffFiles(before: FileLike[], after: FileLike[]): FileChange[] {
  const key = (f: FileLike) => f.storagePath;
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return [
    ...after.map((f) => ({ kind: beforeKeys.has(key(f)) ? ('same' as const) : ('added' as const), fileName: f.fileName, role: f.role })),
    ...before.filter((f) => !afterKeys.has(key(f))).map((f) => ({ kind: 'removed' as const, fileName: f.fileName, role: f.role })),
  ];
}

export function summarise(changes: { kind: string }[]) {
  return {
    added: changes.filter((c) => c.kind === 'added').length,
    removed: changes.filter((c) => c.kind === 'removed').length,
    same: changes.filter((c) => c.kind === 'same').length,
  };
}
