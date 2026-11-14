import { normaliseBalloon, ParsedFeature, ParsedReport } from './parse-report';

/** A frozen check of the inspection, as matching needs it. */
export interface MatchRequirement {
  id: string;
  characteristicKey: string;
  charNumber: string | null;
  name: string;
  dataType: 'variable' | 'attribute' | 'count';
  applicable: boolean;
}

/** A saved feature map of the part: profile-specific maps win over general ones (profileId null). */
export interface MatchFeatureMap {
  featureName: string;
  characteristicKey: string;
  profileId: string | null;
}

/** A row as `app.create_inspection_import` takes it (values as the file wrote them; the database converts units). */
export interface ImportRow {
  position: number;
  featureName: string;
  charNumber: string | null;
  raw: Record<string, string>;
  valueText: string | null;
  unitRead: string | null;
  valueNumeric?: number;
  valuePass?: boolean;
  valueCount?: number;
  fileNominal: number | null;
  fileLower: number | null;
  fileUpper: number | null;
  requirementId: string | null;
  matchKind: 'balloon' | 'map' | 'none';
}

export interface ImportUnit {
  position: number;
  unitReference: string | null;
  rows: ImportRow[];
}

/** The value a feature gives a check of this data type (only one is kept; the database judges whether it fits). */
export function valueFor(f: ParsedFeature, dataType: MatchRequirement['dataType'] | null): Pick<ImportRow, 'valueNumeric' | 'valuePass' | 'valueCount'> {
  if (dataType === 'attribute') return f.pass !== null ? { valuePass: f.pass } : {};
  if (dataType === 'count') return f.actual !== null && Number.isInteger(f.actual) && f.actual >= 0 ? { valueCount: f.actual } : {};
  if (f.actual !== null) return { valueNumeric: f.actual };
  if (dataType === null && f.pass !== null) return { valuePass: f.pass };
  return {};
}

/**
 * Match each feature of each part to a check (C4): a saved feature map first (a person's choice wins), then the balloon number. A check is matched
 * to at most one feature of a part; a second feature that points at it is left unmatched with a warning. Never by name alone.
 */
export function matchReport(
  report: ParsedReport,
  requirements: MatchRequirement[],
  maps: MatchFeatureMap[],
  profileId: string | null,
): { units: ImportUnit[]; warnings: string[] } {
  const warnings: string[] = [];
  const byKey = new Map(requirements.map((q) => [q.characteristicKey, q]));
  const byBalloon = new Map<string, MatchRequirement | null>();
  for (const q of requirements) {
    const b = normaliseBalloon(q.charNumber);
    if (!b) continue;
    // Two checks with one balloon number: neither is matched by balloon.
    byBalloon.set(b, byBalloon.has(b) ? null : q);
  }
  const mapIndex = new Map<string, string>();
  for (const m of maps.filter((m) => m.profileId === null)) mapIndex.set(m.featureName.toLowerCase(), m.characteristicKey);
  for (const m of maps.filter((m) => m.profileId !== null && m.profileId === profileId)) mapIndex.set(m.featureName.toLowerCase(), m.characteristicKey);

  const units = report.units.map((u) => {
    const used = new Map<string, string>();
    const rows = u.features.map((f): ImportRow => {
      let q: MatchRequirement | undefined;
      let kind: ImportRow['matchKind'] = 'none';
      const mapped = mapIndex.get(f.featureName.toLowerCase());
      if (mapped && byKey.has(mapped)) {
        q = byKey.get(mapped);
        kind = 'map';
      } else {
        const b = normaliseBalloon(f.balloon);
        const hit = b ? byBalloon.get(b) : undefined;
        if (hit) {
          q = hit;
          kind = 'balloon';
        }
      }
      if (q && used.has(q.id)) {
        warnings.push(`${u.reference ? `${u.reference}: ` : ''}"${used.get(q.id)}" and "${f.featureName}" both look like ${q.name}; "${f.featureName}" was left unmatched`);
        q = undefined;
        kind = 'none';
      }
      if (q) used.set(q.id, f.featureName);
      return {
        position: f.position,
        featureName: f.featureName,
        charNumber: f.balloon,
        raw: f.raw,
        valueText: f.actualText,
        unitRead: f.unit,
        ...valueFor(f, q?.dataType ?? null),
        fileNominal: f.nominal,
        fileLower: f.lower,
        fileUpper: f.upper,
        requirementId: q?.id ?? null,
        matchKind: kind,
      };
    });
    return { position: u.position, unitReference: u.reference, rows };
  });
  for (const b of [...byBalloon.entries()].filter(([, q]) => q === null).map(([b]) => b)) {
    warnings.push(`Two checks of the control plan share balloon ${b}; features with that balloon need matching by hand`);
  }
  return { units, warnings };
}
