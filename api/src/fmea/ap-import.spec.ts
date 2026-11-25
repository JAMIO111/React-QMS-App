import { detectDelimiter, parseApCsv, parseRange, splitLine } from './ap-import';

describe('action priority grid import', () => {
  it('reads one column per factor holding levels or ranges', () => {
    const r = parseApCsv('S,O,D,Priority\n9-10,1-10,1-10,H\n1-8,6-10,1-10,medium\n1-8,1-5,1-10,L\n');
    expect(r.errors).toEqual([]);
    expect(r.rules).toEqual([
      { sFrom: 9, sTo: 10, oFrom: 1, oTo: 10, dFrom: 1, dTo: 10, priority: 'high' },
      { sFrom: 1, sTo: 8, oFrom: 6, oTo: 10, dFrom: 1, dTo: 10, priority: 'medium' },
      { sFrom: 1, sTo: 8, oFrom: 1, oTo: 5, dFrom: 1, dTo: 10, priority: 'low' },
    ]);
  });

  it('reads a from and a to column per factor, with long names and semicolons', () => {
    const r = parseApCsv('Severity From;Severity To;Occurrence min;Occurrence max;D from;D to;Action Priority\n7;10;1;3;4;10;High\n');
    expect(r.errors).toEqual([]);
    expect(r.rules).toEqual([{ sFrom: 7, sTo: 10, oFrom: 1, oTo: 3, dFrom: 4, dTo: 10, priority: 'high' }]);
  });

  it('reads a tab-separated file with a byte-order mark, blank lines and quoted cells', () => {
    const r = parseApCsv('﻿S\tO\tD\tAP\n\n"1 to 3"\t2\t"4–6"\tl\n');
    expect(r.errors).toEqual([]);
    expect(r.rules).toEqual([{ sFrom: 1, sTo: 3, oFrom: 2, oTo: 2, dFrom: 4, dTo: 6, priority: 'low' }]);
  });

  it('says which line it cannot read, and keeps the others', () => {
    const r = parseApCsv('S,O,D,Priority\n1-3,1-3,1-3,H\nx,1,1,H\n1,1,1,urgent\n4-2,1,1,M\n11,1,1,M\n');
    expect(r.rules).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
    expect(r.errors[0].message).toMatch(/S is a level or a range/);
    expect(r.errors[1].message).toMatch(/priority is H, M or L/);
    expect(r.errors[2].message).toMatch(/lower to the higher/);
  });

  it('names a missing column', () => {
    expect(parseApCsv('S,O,Priority\n1,1,H').errors[0].message).toMatch(/detection \(D\)/);
    expect(parseApCsv('S,O,D\n1,1,1').errors[0].message).toMatch(/no priority column/);
    expect(parseApCsv('S,O,D,AP,Colour\n1,1,1,H,red').errors).toEqual([]);
  });

  it('refuses an empty file, a heading with no rows and too many ranges', () => {
    expect(parseApCsv('  \n').errors[0].message).toMatch(/empty/);
    expect(parseApCsv('S,O,D,AP').errors[0].message).toMatch(/no rows/);
    const many = 'S,O,D,AP\n' + Array.from({ length: 301 }, () => '1,1,1,L').join('\n');
    expect(parseApCsv(many).errors.at(-1)?.message).toMatch(/up to 300/);
  });

  it('has helpers that behave', () => {
    expect(splitLine('a,"b,c","d""e"', ',')).toEqual(['a', 'b,c', 'd"e']);
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('single')).toBe(',');
    expect(parseRange(' 9 .. 10 ')).toEqual([9, 10]);
    expect(parseRange('abc')).toBeNull();
  });
});
