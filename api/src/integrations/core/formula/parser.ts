/**
 * The import formula language (UI2b, plan §4): a hand-written lexer and recursive-descent parser that turn a formula into a tree. There are no variables,
 * loops, user functions or any access to the network, the database or files: a formula can only read the columns of the row it is evaluated against.
 *
 * Grammar (lowest precedence first):
 *   or      := and ( OR and )*
 *   and     := not ( AND not )*
 *   not     := NOT not | compare
 *   compare := concat ( ( = | <> | < | <= | > | >= ) concat )?
 *   concat  := add ( & add )*
 *   add     := mul ( ( + | - ) mul )*
 *   mul     := unary ( ( * | / ) unary )*
 *   unary   := - unary | + unary | primary
 *   primary := number | "text" | [Column] | TRUE | FALSE | NAME ( args ) | ( or )
 */

export const MAX_FORMULA_LENGTH = 2000;
export const MAX_DEPTH = 32;

export type Node =
  | { type: 'number'; value: number; pos: number }
  | { type: 'text'; value: string; pos: number }
  | { type: 'boolean'; value: boolean; pos: number }
  | { type: 'column'; name: string; pos: number }
  | { type: 'call'; name: string; args: Node[]; pos: number }
  | { type: 'unary'; op: '-' | '+' | 'NOT'; arg: Node; pos: number }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node; pos: number };

export type BinaryOp = '+' | '-' | '*' | '/' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=' | 'AND' | 'OR';

/** A formula that cannot be read: the message says what was expected, `position` is 1-based in the formula. */
export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

type Token =
  | { kind: 'number'; value: number; pos: number; text: string }
  | { kind: 'text'; value: string; pos: number; text: string }
  | { kind: 'column'; value: string; pos: number; text: string }
  | { kind: 'name'; value: string; pos: number; text: string }
  | { kind: 'op'; value: string; pos: number; text: string }
  | { kind: 'end'; value: ''; pos: number; text: string };

const OPS = ['<=', '>=', '<>', '+', '-', '*', '/', '&', '=', '<', '>', '(', ')', ','];

function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    const start = i;
    if (c === '"') {
      let s = '';
      i += 1;
      for (;;) {
        if (i >= src.length) throw new FormulaSyntaxError('This text has no closing "', start + 1);
        if (src[i] === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        s += src[i];
        i += 1;
      }
      out.push({ kind: 'text', value: s, pos: start, text: src.slice(start, i) });
      continue;
    }
    if (c === '[') {
      let s = '';
      i += 1;
      for (;;) {
        if (i >= src.length) throw new FormulaSyntaxError('This column name has no closing ]', start + 1);
        if (src[i] === ']') {
          if (src[i + 1] === ']') { s += ']'; i += 2; continue; }
          i += 1;
          break;
        }
        s += src[i];
        i += 1;
      }
      if (!s.trim()) throw new FormulaSyntaxError('Write the column name between [ and ]', start + 1);
      out.push({ kind: 'column', value: s, pos: start, text: src.slice(start, i) });
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
      if (!m) throw new FormulaSyntaxError(`"${c}" is not a number`, start + 1);
      i += m[0].length;
      out.push({ kind: 'number', value: Number(m[0]), pos: start, text: m[0] });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      i += m[0].length;
      out.push({ kind: 'name', value: m[0].toUpperCase(), pos: start, text: m[0] });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaSyntaxError(`"${c}" cannot be used here (columns go in [ ], text in " ")`, start + 1);
    i += op.length;
    out.push({ kind: 'op', value: op, pos: start, text: op });
  }
  out.push({ kind: 'end', value: '', pos: src.length, text: '' });
  return out;
}

const describe = (t: Token) => (t.kind === 'end' ? 'the end of the formula' : `"${t.text}"`);

/** Parse a formula into a tree; throws FormulaSyntaxError with the position and what was expected. */
export function parseFormula(src: string): Node {
  if (src.length > MAX_FORMULA_LENGTH) throw new FormulaSyntaxError(`A formula can be at most ${MAX_FORMULA_LENGTH} characters long`, MAX_FORMULA_LENGTH + 1);
  if (!src.trim()) throw new FormulaSyntaxError('The formula is empty', 1);
  const tokens = lex(src);
  let p = 0;
  let depth = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const isOp = (v: string) => peek().kind === 'op' && peek().value === v;
  const isWord = (v: string) => peek().kind === 'name' && peek().value === v;
  const enter = (pos: number) => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new FormulaSyntaxError(`The formula is nested too deeply (at most ${MAX_DEPTH} levels)`, pos + 1);
  };
  const expect = (v: string, what: string) => {
    const t = peek();
    if (t.kind !== 'op' || t.value !== v) throw new FormulaSyntaxError(`Expected ${what} but found ${describe(t)}`, t.pos + 1);
    p += 1;
  };

  const or = (): Node => {
    let left = and();
    while (isWord('OR')) {
      const t = next();
      left = { type: 'binary', op: 'OR', left, right: and(), pos: t.pos };
    }
    return left;
  };
  const and = (): Node => {
    let left = not();
    while (isWord('AND')) {
      const t = next();
      left = { type: 'binary', op: 'AND', left, right: not(), pos: t.pos };
    }
    return left;
  };
  const not = (): Node => {
    if (isWord('NOT') && !(tokens[p + 1].kind === 'op' && tokens[p + 1].value === '(')) {
      const t = next();
      enter(t.pos);
      const arg = not();
      depth -= 1;
      return { type: 'unary', op: 'NOT', arg, pos: t.pos };
    }
    return compare();
  };
  const compare = (): Node => {
    const left = concat();
    const t = peek();
    if (t.kind === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(t.value)) {
      next();
      return { type: 'binary', op: t.value as BinaryOp, left, right: concat(), pos: t.pos };
    }
    return left;
  };
  const concat = (): Node => {
    let left = add();
    while (isOp('&')) {
      const t = next();
      left = { type: 'binary', op: '&', left, right: add(), pos: t.pos };
    }
    return left;
  };
  const add = (): Node => {
    let left = mul();
    while (isOp('+') || isOp('-')) {
      const t = next();
      left = { type: 'binary', op: t.value as BinaryOp, left, right: mul(), pos: t.pos };
    }
    return left;
  };
  const mul = (): Node => {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const t = next();
      left = { type: 'binary', op: t.value as BinaryOp, left, right: unary(), pos: t.pos };
    }
    return left;
  };
  const unary = (): Node => {
    if (isOp('-') || isOp('+')) {
      const t = next();
      enter(t.pos);
      const arg = unary();
      depth -= 1;
      return { type: 'unary', op: t.value as '-' | '+', arg, pos: t.pos };
    }
    return primary();
  };
  const primary = (): Node => {
    const t = next();
    switch (t.kind) {
      case 'number':
        return { type: 'number', value: t.value, pos: t.pos };
      case 'text':
        return { type: 'text', value: t.value, pos: t.pos };
      case 'column':
        return { type: 'column', name: t.value, pos: t.pos };
      case 'name': {
        if (t.value === 'TRUE' || t.value === 'FALSE') return { type: 'boolean', value: t.value === 'TRUE', pos: t.pos };
        if (!isOp('(')) {
          throw new FormulaSyntaxError(
            ['AND', 'OR', 'NOT'].includes(t.value) ? `${t.text} needs a value before and after it` : `"${t.text}" is not something a formula knows: write a column as [${t.text}], text as "${t.text}", or a function as ${t.value}(…)`,
            t.pos + 1,
          );
        }
        next();
        enter(t.pos);
        const args: Node[] = [];
        if (!isOp(')')) {
          for (;;) {
            args.push(or());
            if (isOp(',')) { next(); continue; }
            break;
          }
        }
        expect(')', `"," or ")" to close ${t.value}(`);
        depth -= 1;
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      case 'op':
        if (t.value === '(') {
          enter(t.pos);
          const inner = or();
          expect(')', 'a closing ")"');
          depth -= 1;
          return inner;
        }
        throw new FormulaSyntaxError(`Expected a value but found ${describe(t)}`, t.pos + 1);
      default:
        throw new FormulaSyntaxError('The formula ends too soon: a value is missing', t.pos + 1);
    }
  };

  const tree = or();
  if (peek().kind !== 'end') throw new FormulaSyntaxError(`Expected an operator such as & or + but found ${describe(peek())}`, peek().pos + 1);
  return tree;
}

/** Every column and function a tree uses (each once, in the order first met). */
export function formulaUses(node: Node): { columns: string[]; functions: string[] } {
  const columns = new Set<string>();
  const functions = new Set<string>();
  const walk = (n: Node) => {
    if (n.type === 'column') columns.add(n.name);
    else if (n.type === 'call') { functions.add(n.name); n.args.forEach(walk); }
    else if (n.type === 'unary') walk(n.arg);
    else if (n.type === 'binary') { walk(n.left); walk(n.right); }
  };
  walk(node);
  return { columns: [...columns], functions: [...functions] };
}
