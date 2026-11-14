/**
 * Units as a report writes them, turned into the codes of Fortress's units table. Converting a value to the check's unit is done by the database
 * (`app.measurement_unit_factor`, C7), so a feature matched by hand later converts the same way.
 */
const ALIASES: Record<string, string> = {
  mm: 'mm', millimeter: 'mm', millimetre: 'mm', millimeters: 'mm', millimetres: 'mm',
  um: 'µm', 'µm': 'µm', 'μm': 'µm', micron: 'µm', microns: 'µm', micrometre: 'µm', micrometer: 'µm',
  m: 'm', metre: 'm', meter: 'm',
  in: 'in', inch: 'in', inches: 'in', '"': 'in',
  thou: 'thou', mil: 'thou', mils: 'thou',
  deg: 'deg', '°': 'deg', degree: 'deg', degrees: 'deg', dd: 'deg',
  arcmin: 'arcmin', arcminute: 'arcmin', arcminutes: 'arcmin',
};

/** A unit as written in a file, as a units-table code (unknown units are kept as written, trimmed). Empty → null. */
export function normaliseUnit(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (Object.hasOwn(ALIASES, lower)) return ALIASES[lower];
  if (Object.hasOwn(ALIASES, t)) return ALIASES[t];
  return t.slice(0, 20);
}
