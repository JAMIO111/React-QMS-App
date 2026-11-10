import { arityText, asText, evaluate, FormulaError, FUNCTIONS, Value } from './evaluate';
import { formulaUses, FormulaSyntaxError, MAX_FORMULA_LENGTH, Node, parseFormula } from './parser';

export { asText, evaluate, FormulaError, FormulaSyntaxError, FUNCTIONS, MAX_FORMULA_LENGTH, parseFormula };
export type { Node, Value };

/** The edit distance between two words (for "did you mean"). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The closest of `options` to `word` (case ignored), when close enough to suggest. */
export function closest(word: string, options: Iterable<string>): string | null {
  const w = word.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = distance(w, o.toLowerCase());
    if (d < bestD) { best = o; bestD = d; }
  }
  return best !== null && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

export interface FormulaCheck {
  ok: boolean;
  /** The first problem found, with its 1-based position when it is a syntax problem. */
  error: { message: string; position: number | null } | null;
  columns: string[];
  functions: string[];
}

/** Read a formula and check its functions and (when given) its columns. Nothing is evaluated. */
export function checkFormula(src: string, columns?: Iterable<string> | null): FormulaCheck & { tree: Node | null } {
  let tree: Node;
  try {
    tree = parseFormula(src);
  } catch (e) {
    if (e instanceof FormulaSyntaxError) return { ok: false, error: { message: `Position ${e.position}: ${e.message}`, position: e.position }, columns: [], functions: [], tree: null };
    throw e;
  }
  const uses = formulaUses(tree);
  const fail = (message: string, position: number | null = null) => ({ ok: false, error: { message, position }, ...uses, tree });
  const calls: Array<{ name: string; args: number; pos: number }> = [];
  const walk = (n: Node) => {
    if (n.type === 'call') { calls.push({ name: n.name, args: n.args.length, pos: n.pos }); n.args.forEach(walk); }
    else if (n.type === 'unary') walk(n.arg);
    else if (n.type === 'binary') { walk(n.left); walk(n.right); }
  };
  walk(tree);
  for (const c of calls) {
    const f = FUNCTIONS[c.name];
    if (!f) {
      const hint = closest(c.name, Object.keys(FUNCTIONS));
      return fail(`Position ${c.pos + 1}: there is no function ${c.name}${hint ? ` — did you mean ${hint}?` : ''}`, c.pos + 1);
    }
    if (c.args < f.min || c.args > f.max) return fail(`Position ${c.pos + 1}: ${c.name} needs ${arityText(c.name)}, got ${c.args} (${f.usage})`, c.pos + 1);
    if (c.name === 'IFS' && c.args % 2) return fail(`Position ${c.pos + 1}: IFS needs pairs of a test and a value, got ${c.args} values`, c.pos + 1);
  }
  if (columns) {
    const set = new Set(columns);
    for (const col of uses.columns) {
      if (!set.has(col)) {
        const hint = closest(col, set);
        return fail(`Column [${col}] is not in the file${hint ? ` — did you mean [${hint}]?` : ''}`);
      }
    }
  }
  return { ok: true, error: null, ...uses, tree };
}

const cache = new Map<string, Node | FormulaSyntaxError>();

/** Evaluate a formula against one row and give the text it fills the field with (a parse is cached per formula text). */
export function runFormula(src: string, get: (column: string) => string): { value: string } | { error: string } {
  let tree = cache.get(src);
  if (!tree) {
    try {
      tree = parseFormula(src);
    } catch (e) {
      if (!(e instanceof FormulaSyntaxError)) throw e;
      tree = e;
    }
    if (cache.size > 500) cache.clear();
    cache.set(src, tree);
  }
  if (tree instanceof FormulaSyntaxError) return { error: `Position ${tree.position}: ${tree.message}` };
  try {
    return { value: asText(evaluate(tree, get)) };
  } catch (e) {
    if (e instanceof FormulaError) return { error: e.message };
    if (e instanceof RangeError) return { error: 'The formula is too complex to work out' };
    throw e;
  }
}

/** The function list for suggestions in the formula editor. */
export const FUNCTION_LIST = Object.entries(FUNCTIONS).map(([name, f]) => ({ name, usage: f.usage, description: f.description, minArgs: f.min, maxArgs: f.max }));
