import { decodeText, FileParseError } from '../integrations/core/file-parsers';
import { balloonFromFeature, MAX_FEATURES, MAX_UNITS, parseMeasurement, ParsedFeature, ParsedReport, ParsedUnit } from './parse-report';

/**
 * PC-DMIS "File | Export | Generic" text files (Hexagon help, "Exporting to a Generic Text File"), read without a profile: the file has no heading row,
 * so a table profile cannot read it. Each dimension is one line
 *   `[Dim Label] AX:[Axis], [Nominal], [+ Tol], [- Tol], [Measured], [Deviation], [Out of Tol]`
 * and feature exports add `[Feature Label], X, Y, Z, I, J, K, D` lines followed by `[Label] HITS, X, Y, Z, I, J, K` lines, which carry no limits and
 * are skipped. The minus tolerance is written as it is entered in PC-DMIS (positive = below nominal), so the lower limit is nominal − minus tolerance and
 * a negative minus tolerance puts the lower limit above nominal. The file names no unit, part or serial number: values are taken to be in the check's own
 * unit, and the part is the inspection's.
 */

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const DIM = /^(.*?)\s*AX:\s*([A-Za-z0-9_]+)$/;
const MAX_LINES = 50_000;

interface DimLine {
  line: number;
  label: string;
  axis: string;
  numbers: string[];
}

const cells = (line: string) => line.split(',').map((c) => c.trim());
const allNumbers = (xs: string[]) => xs.length > 0 && xs.every((x) => NUM.test(x));

/** Read the lines; `null` when the text is not a PC-DMIS generic export (every non-empty line must be a dimension, feature or hits line). */
function readLines(text: string): { dims: DimLine[]; featureLines: number } | null {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > MAX_LINES) return null;
  const dims: DimLine[] = [];
  let featureLines = 0;
  for (const [i, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    const [first, ...rest] = cells(raw);
    const dim = first.match(DIM);
    if (dim && rest.length === 6 && allNumbers(rest)) {
      dims.push({ line: i + 1, label: dim[1].trim(), axis: dim[2].toUpperCase(), numbers: rest });
      continue;
    }
    if (first && !first.includes('AX:') && (rest.length === 6 || rest.length === 7) && allNumbers(rest)) {
      featureLines += 1;
      continue;
    }
    return null;
  }
  return dims.length > 0 ? { dims, featureLines } : null;
}

/** Whether a file looks like a PC-DMIS generic export (a dimension line, and nothing that is not one of its line kinds). */
export function isPcdmisGeneric(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  try {
    return readLines(decodeText(buf)) !== null;
  } catch {
    return false;
  }
}

export function parsePcdmisGeneric(buf: Uint8Array): ParsedReport {
  const read = readLines(decodeText(buf));
  if (!read) throw new FileParseError('This is not a PC-DMIS generic export: every line must be a dimension (“LABEL AX:X, …”), feature or hits line');
  const warnings: string[] = ['Read as a PC-DMIS generic export. The file names no unit, so its values are taken to be in each check’s own unit.'];
  if (read.featureLines > 0) warnings.push(`${read.featureLines} feature and hit lines carry no limits and were not read; only dimensions are.`);

  // The format has no part separator. A dimension and axis written a second time starts the next part (several runs exported into one file).
  const groups: DimLine[][] = [[]];
  for (const d of read.dims) {
    const current = groups[groups.length - 1];
    if (current.some((x) => x.label === d.label && x.axis === d.axis)) groups.push([d]);
    else current.push(d);
  }
  if (groups.length > MAX_UNITS) throw new FileParseError(`The file holds more than ${MAX_UNITS} parts`);
  if (groups.length > 1) warnings.push(`Dimensions repeat in the file, so it was read as ${groups.length} parts in the order written.`);

  let position = 0;
  const units: ParsedUnit[] = groups.map((group, index) => {
    // A label measured on one axis may be a balloon number ("12", "#12"); a label with several axes (LOC1 X, Y, D) is not used as one.
    const axes = new Map<string, number>();
    for (const d of group) axes.set(d.label, (axes.get(d.label) ?? 0) + 1);
    const features = group.map((d): ParsedFeature => {
      position += 1;
      if (position > MAX_FEATURES) throw new FileParseError(`The file has more than ${MAX_FEATURES.toLocaleString('en-GB')} features`);
      const [nominalText, plusText, minusText, measuredText, deviation, outOfTol] = d.numbers;
      const nominal = parseMeasurement(nominalText);
      const plus = parseMeasurement(plusText);
      const minus = parseMeasurement(minusText);
      const round = (v: number | null) => (v === null ? null : Number(v.toPrecision(12)));
      return {
        position,
        line: d.line,
        featureName: `${d.label} ${d.axis}`.trim().slice(0, 200),
        balloon: axes.get(d.label) === 1 ? balloonFromFeature(d.label) : null,
        raw: { Dimension: d.label.slice(0, 100), Axis: d.axis, Nominal: nominalText, '+ Tol': plusText, '- Tol': minusText, Measured: measuredText, Deviation: deviation, 'Out of tol': outOfTol },
        actualText: measuredText,
        actual: parseMeasurement(measuredText),
        pass: null,
        unit: null,
        nominal,
        lower: nominal !== null && minus !== null ? round(nominal - minus) : null,
        upper: nominal !== null && plus !== null ? round(nominal + plus) : null,
      };
    });
    return { position: index + 1, reference: groups.length > 1 ? `Part ${index + 1}` : null, features };
  });
  return { header: {}, headings: [], headingRow: 0, units, featureCount: position, warnings };
}
