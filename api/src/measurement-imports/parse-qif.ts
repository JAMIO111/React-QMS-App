import { FileParseError } from '../integrations/core/file-parsers';
import { MAX_FEATURES, MAX_UNITS, ParsedFeature, ParsedReport, ParsedUnit } from './parse-report';
import { normaliseUnit } from './units';

/**
 * QIF Results (ISO 23952) read without a profile (docs/cmm-ingestion-plan.md C1, slice CM5). The file names its own characteristics, nominals,
 * tolerances, balloon numbers (designators), units and measured values, so nothing has to be set up. The element names follow the QIF 3 schema
 * and must be checked against real files (plan CM0); the reader is tolerant of the order of elements and of namespace prefixes.
 */

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
  parent: XmlNode | null;
}

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 500_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : m;
  });
const localName = (n: string) => n.slice(n.indexOf(':') + 1);

/** A small XML reader: elements, attributes and text only. A DOCTYPE (and so any entity or external reference) is refused. */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '', parent: null };
  let current = root;
  let depth = 0;
  let count = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      current.text += decode(text.slice(i));
      break;
    }
    if (lt > i) current.text += decode(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new FileParseError('The file is not valid XML: a comment is not closed');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new FileParseError('The file is not valid XML: a CDATA section is not closed');
      current.text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) throw new FileParseError('The file declares a DOCTYPE, which is not accepted');
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new FileParseError('The file is not valid XML');
      i = end + 2;
      continue;
    }
    const gt = text.indexOf('>', lt);
    if (gt < 0) throw new FileParseError('The file is not valid XML: a tag is not closed');
    const raw = text.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      const name = localName(raw.slice(1).trim());
      if (current === root || current.name !== name) throw new FileParseError(`The file is not valid XML: </${name}> does not close <${current.name}>`);
      current = current.parent!;
      depth -= 1;
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = body.match(/^\s*([^\s/>]+)/);
    if (!m) throw new FileParseError('The file is not valid XML');
    const node: XmlNode = { name: localName(m[1]), attrs: {}, children: [], text: '', parent: current };
    for (const a of body.slice(m[0].length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const key = localName(a[1]);
      if (key !== '__proto__') node.attrs[key] = decode(a[3] ?? a[4] ?? '');
    }
    if (++count > MAX_ELEMENTS) throw new FileParseError('The file has too many XML elements');
    current.children.push(node);
    if (!selfClosing) {
      if (++depth > MAX_DEPTH) throw new FileParseError('The XML in the file is nested too deeply');
      current = node;
    }
  }
  if (current !== root) throw new FileParseError(`The file is not valid XML: <${current.name}> is not closed`);
  return root;
}

const child = (node: XmlNode | undefined, name: string) => node?.children.find((c) => c.name === name);
const path = (node: XmlNode | undefined, ...names: string[]) => names.reduce<XmlNode | undefined>((n, name) => child(n, name), node);
const textOf = (node: XmlNode | undefined) => (node ? node.text.trim() : '');
const num = (node: XmlNode | undefined): number | null => {
  const t = textOf(node);
  if (!t || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
function* walk(node: XmlNode): Generator<XmlNode> {
  for (const c of node.children) {
    yield c;
    yield* walk(c);
  }
}
const first = (node: XmlNode, name: string) => {
  for (const n of walk(node)) if (n.name === name) return n;
  return undefined;
};
const round = (v: number | null) => (v === null ? null : Number(v.toPrecision(12)));

/** Whether a file looks like QIF (by its name, or by its first element). */
export const isQifFile = (fileName: string, buf: Uint8Array) =>
  /\.(qif|xml)$/i.test(fileName) || /^\s*(<\?xml[^>]*>\s*)?<([A-Za-z0-9_]+:)?QIFDocument[\s>]/.test(new TextDecoder().decode(buf.slice(0, 512)).replace(/^﻿/, ''));

/** Read a QIF Results file: one part per MeasurementResults element (its serial number when given), one feature per characteristic measurement. */
export function parseQif(buf: Uint8Array): ParsedReport {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^﻿/, '');
  const root = parseXml(text);
  const doc = root.children.find((c) => c.name === 'QIFDocument');
  if (!doc) throw new FileParseError('This is not a QIF file: it has no QIFDocument');

  const byId = new Map<string, XmlNode>();
  for (const n of walk(doc)) {
    const id = n.attrs.id;
    if (id && !byId.has(id)) byId.set(id, n);
  }
  const units = path(doc, 'FileUnits', 'PrimaryUnits');
  const linear = normaliseUnit(textOf(path(units, 'LinearUnit', 'UnitName'))) ?? 'mm';
  const angular = normaliseUnit(textOf(path(units, 'AngularUnit', 'UnitName'))) ?? 'deg';

  const header: ParsedReport['header'] = {};
  const partName = textOf(path(first(doc, 'Part'), 'Name')) || textOf(path(first(doc, 'Part'), 'Model'));
  if (partName) header.partNumber = partName.slice(0, 100);
  const program = textOf(path(first(doc, 'MeasurementPlan'), 'Name'));
  if (program) header.program = program.slice(0, 100);

  const results = [...walk(doc)].filter((n) => n.name === 'MeasurementResults');
  if (results.length === 0) throw new FileParseError('The QIF file holds no measurement results');
  if (results.length > MAX_UNITS) throw new FileParseError(`The file holds more than ${MAX_UNITS} parts`);

  const designator = (n: XmlNode | undefined) => textOf(path(n, 'CharacteristicDesignator', 'Designator')) || null;
  const out: ParsedUnit[] = [];
  const warnings: string[] = [];
  let position = 0;
  for (const [index, res] of results.entries()) {
    const serial = textOf(first(res, 'SerialNumber')) || null;
    const features: ParsedFeature[] = [];
    for (const m of walk(res)) {
      if (!m.name.endsWith('CharacteristicMeasurement')) continue;
      const item = byId.get(textOf(child(m, 'CharacteristicItemId')));
      const nominal = byId.get(textOf(child(item, 'CharacteristicNominalId')));
      const definition = byId.get(textOf(child(nominal, 'CharacteristicDefinitionId')));
      position += 1;
      if (position > MAX_FEATURES) throw new FileParseError(`The file has more than ${MAX_FEATURES.toLocaleString('en-GB')} features`);
      const kind = m.name.replace(/CharacteristicMeasurement$/, '');
      const isAngle = /Angl/i.test(kind);
      const target = num(child(nominal, 'TargetValue')) ?? num(child(nominal, 'Angle'));
      const tolerance = child(definition, 'Tolerance') ?? child(definition, 'AngularTolerance');
      const maxDev = num(child(tolerance, 'MaxValue'));
      const minDev = num(child(tolerance, 'MinValue'));
      const zone = num(child(definition, 'ToleranceValue')) ?? num(child(tolerance, 'ToleranceValue'));
      const actual = num(child(m, 'Value'));
      const status = textOf(path(m, 'Status', 'CharacteristicStatusEnum')).toUpperCase();
      // Form and location tolerances (flatness, position …) have a zone from 0, not deviations around a nominal.
      const lower = target !== null && minDev !== null ? target + minDev : null;
      const upper = target !== null && maxDev !== null ? target + maxDev : zone !== null ? zone : null;
      const name = textOf(child(item, 'Name')) || textOf(child(nominal, 'Name')) || kind || `Characteristic ${position}`;
      features.push({
        position,
        line: position,
        featureName: name.slice(0, 200),
        balloon: designator(item) ?? designator(nominal) ?? designator(definition),
        raw: Object.fromEntries(
          [['Type', kind], ['Item', textOf(child(item, 'Name'))], ['Status', status]].filter(([, v]) => v).map(([k, v]) => [k, String(v).slice(0, 100)]),
        ),
        actualText: textOf(child(m, 'Value')).slice(0, 100) || status || null,
        actual,
        pass: actual === null && (status === 'PASS' || status === 'FAIL') ? status === 'PASS' : null,
        unit: isAngle ? angular : linear,
        nominal: round(target ?? (zone !== null ? 0 : null)),
        lower: round(lower),
        upper: round(upper),
      });
    }
    if (features.length === 0) continue;
    out.push({ position: out.length + 1, reference: (serial ?? (results.length === 1 ? null : `Result ${index + 1}`))?.slice(0, 60) ?? null, features });
  }
  if (position === 0) throw new FileParseError('The QIF file holds no characteristic measurements');
  if (out.length === 1 && !out[0].reference) {
    const serial = textOf(first(doc, 'SerialNumber'));
    if (serial) {
      header.serial = serial.slice(0, 100);
      out[0].reference = serial.slice(0, 60);
    }
  }
  return { header, headings: [], headingRow: 0, units: out, featureCount: position, warnings };
}
