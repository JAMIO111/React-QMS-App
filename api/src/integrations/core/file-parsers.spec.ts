import { strToU8, zipSync } from 'fflate';
import { columnIndex, excelSerialToIso, FileParseError, normaliseHeaders, parseCsv, parseCsvText, parseFile, parseXlsx } from './file-parsers';

const u8 = (s: string) => new TextEncoder().encode(s);

/** A small but real .xlsx: one sheet with a shared string, an inline string, a number, a date-styled number, a boolean and a gap. */
function workbook(rowsXml: string, opts: { sheetName?: string } = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns:r="r"><sheets><sheet name="${opts.sheetName ?? 'Suppliers'}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8('<sst><si><t>Code</t></si><si><t>Name</t></si><si><r><t>Alpha </t></r><r><t>&amp; Sons</t></r></si><si><t>Since</t></si></sst>'),
    'xl/styles.xml': strToU8('<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`),
  });
}

describe('CSV', () => {
  it('reads quoted values with separators, line breaks and doubled quotes, and any line ending', () => {
    expect(parseCsvText('a,"b,c","say ""hi""\nthere"\r\nd,e,f\rg,h,', ',')).toEqual([
      ['a', 'b,c', 'say "hi"\nthere'],
      ['d', 'e', 'f'],
      ['g', 'h', ''],
    ]);
    expect(() => parseCsvText('a,"open', ',')).toThrow(FileParseError);
  });

  it('turns lines into rows by heading, keeping file row numbers and skipping empty lines', () => {
    const f = parseCsv(u8('﻿Code;Name;;Name\nS-1; Alpha ;x;A\n\n;;;\nS-2;Bravo\n'), { delimiter: ';' });
    expect(f.headers).toEqual(['Code', 'Name', 'Column 3', 'Name (2)']);
    expect(f.rows).toEqual([
      { row: 2, values: { Code: 'S-1', Name: 'Alpha', 'Column 3': 'x', 'Name (2)': 'A' } },
      { row: 5, values: { Code: 'S-2', Name: 'Bravo', 'Column 3': '', 'Name (2)': '' } },
    ]);
  });

  it('reads files without a heading row, tabs, and Windows-1252 text', () => {
    const f = parseCsv(new Uint8Array([0x53, 0x09, 0x43, 0x61, 0x66, 0xe9]), { delimiter: 'tab', encoding: 'windows-1252', hasHeader: false });
    expect(f.headers).toEqual(['Column 1', 'Column 2']);
    expect(f.rows[0].values).toEqual({ 'Column 1': 'S', 'Column 2': 'Café' });
  });

  it('refuses empty files, heading-only files and too many rows', () => {
    expect(() => parseCsv(u8('\n\n'))).toThrow('The file is empty');
    expect(() => parseCsv(u8('Code,Name\n'))).toThrow('headings but no rows');
    expect(() => parseCsv(u8('Code\n1\n2\n3\n'), { maxRows: 2 })).toThrow('up to 2');
  });
});

describe('XLSX', () => {
  it('reads the first worksheet: shared and inline strings, numbers, dates by their style, booleans and gaps', () => {
    const f = parseXlsx(
      workbook(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="inlineStr"><is><t>Active</t></is></c></row>' +
          '<row r="3"><c r="A3"><v>1001</v></c><c r="B3" t="s"><v>2</v></c><c r="D3" s="1"><v>45292</v></c><c r="E3" t="b"><v>1</v></c></row>' +
          '<row r="4"><c r="A4" t="str"><v>S-2</v></c><c r="B4" t="inlineStr"><is><t>Bravo</t></is></c><c r="D4" s="2"><v>45293.5</v></c></row>',
      ),
    );
    expect(f.sheet).toBe('Suppliers');
    expect(f.headers).toEqual(['Code', 'Name', 'Column 3', 'Since', 'Active']);
    expect(f.rows).toEqual([
      { row: 3, values: { Code: '1001', Name: 'Alpha & Sons', 'Column 3': '', Since: '2024-01-01', Active: 'TRUE' } },
      { row: 4, values: { Code: 'S-2', Name: 'Bravo', 'Column 3': '', Since: '2024-01-02T12:00:00', Active: '' } },
    ]);
  });

  it('refuses something that is not a workbook, and old .xls files by name', () => {
    expect(() => parseXlsx(u8('not a zip'))).toThrow('not a valid Excel workbook');
    expect(() => parseFile('old.xls', u8('x'))).toThrow('.xls');
    expect(parseFile('a.CSV', u8('A\n1')).rows).toHaveLength(1);
  });

  it('helpers', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('AA')).toBe(26);
    expect(excelSerialToIso(45292)).toBe('2024-01-01');
    expect(normaliseHeaders(['', ' Name ', 'name'])).toEqual(['Column 1', 'Name', 'name (2)']);
  });
});
