import { SAMPLE_QIF } from '../../test/qif-sample';
import { isQifFile, parseQif, parseXml } from './parse-qif';

const enc = (s: string) => new TextEncoder().encode(s);

describe('parseQif', () => {
  it('reads characteristics, limits, balloons, units and values', () => {
    const r = parseQif(enc(SAMPLE_QIF));
    expect(r.header.partNumber).toBe('BRK-100');
    expect(r.units).toHaveLength(1);
    expect(r.units[0].reference).toBe('SN-7');
    const [bore, face] = r.units[0].features;
    expect(bore).toMatchObject({ featureName: 'Bore & seat', balloon: '12', actual: 25.012, nominal: 25, lower: 24.95, upper: 25.05, unit: 'mm' });
    expect(face).toMatchObject({ featureName: 'Face flatness', balloon: '13', actual: 0.031, nominal: 0, lower: null, upper: 0.02 });
    expect(r.featureCount).toBe(2);
  });

  it('makes a part per result set', () => {
    const two = SAMPLE_QIF.replace(/<MeasurementResults id="35">([\s\S]*?)<\/MeasurementResults>/, (m) => m + m.replace('SN-7', 'SN-8').replace(/id="3[5-7]"/g, ''));
    const r = parseQif(enc(two));
    expect(r.units.map((u) => u.reference)).toEqual(['SN-7', 'SN-8']);
    expect(r.units[1].features[0].actual).toBe(25.012);
  });

  it('accepts namespace prefixes and a byte-order mark', () => {
    const prefixed = SAMPLE_QIF.replace(/<(\/?)([A-Za-z])/g, '<$1q:$2').replace('xmlns=', 'xmlns:q=');
    expect(parseQif(enc('﻿' + prefixed)).units[0].features).toHaveLength(2);
  });

  it('refuses a DOCTYPE, so no entities or external references', () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><QIFDocument>&e;</QIFDocument>`;
    expect(() => parseQif(enc(evil))).toThrow(/DOCTYPE/);
  });

  it('refuses broken XML, too deep nesting, and files that are not QIF', () => {
    expect(() => parseQif(enc('<QIFDocument><a></b></QIFDocument>'))).toThrow(/not valid XML/);
    expect(() => parseXml('<a>'.repeat(100) + '</a>'.repeat(100))).toThrow(/nested too deeply/);
    expect(() => parseQif(enc('<Other/>'))).toThrow(/not a QIF file/);
    expect(() => parseQif(enc('<QIFDocument/>'))).toThrow(/no measurement results/);
  });

  it('does not let attributes reach the object prototype', () => {
    const n = parseXml('<a __proto__="x" constructor="y"/>').children[0];
    expect(Object.getPrototypeOf(n.attrs)).toBe(Object.prototype);
    expect(n.attrs.constructor).toBe('y');
  });

  it('knows a QIF file by its name or its first element', () => {
    expect(isQifFile('run.qif', enc('x'))).toBe(true);
    expect(isQifFile('run.txt', enc('<?xml version="1.0"?>\n<QIFDocument>'))).toBe(true);
    expect(isQifFile('run.csv', enc('a,b'))).toBe(false);
  });
});
