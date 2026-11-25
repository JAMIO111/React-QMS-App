/**
 * Every request body the harness sends, as pure functions of their inputs. Keeping them in one place lets check-bodies.cjs validate each one against
 * the API's own schemas without a server or a database, so a change to the API that breaks the harness shows up before a run.
 */
const day = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);

const pad = (n, w) => String(n).padStart(w, '0');

const gaugeType = () => ({ code: 'LT-MIC', name: 'Load test micrometer' });
const gauge = (i, gaugeTypeId, siteId) => ({ assetNumber: `LT-MIC-${pad(i, 3)}`, description: `Load test micrometer ${i}`, gaugeTypeId, siteId, nextDueOn: day(-365) });
const family = (i) => ({ code: `LTF${pad(i, 3)}`, name: `Load test family ${i}` });
const part = (i, familyId) => ({ partNumber: `LT-${pad(i, 6)}`, name: `Load test part ${i}`, partFamilyId: familyId, initialRevision: { revision: 'A' } });
const plan = (i, familyId) => ({ planCode: `LTCP-${pad(i, 3)}`, title: `Load test plan ${i}`, partFamilyId: familyId });
const operation = () => ({ operationCode: 'OP-020', name: 'Turning' });

const SAMPLING = [
  { triggerType: 'first_off', sampleSize: 1 },
  { triggerType: 'every_n_parts', intervalValue: 60, sampleSize: 1 },
];
/** Check `k` (0-based) of a plan: the first `measured` are measured to limits and charted, the rest are pass/fail. */
const characteristic = (k, operationId, gaugeTypeId, measured = 6) =>
  k < measured
    ? {
        operationId,
        characteristicKey: `D${k + 1}`,
        name: `Dimension ${k + 1}`,
        nominal: 10 * (k + 1),
        lowerLimit: 10 * (k + 1) - 0.1,
        upperLimit: 10 * (k + 1) + 0.1,
        unitCode: 'mm',
        ...(k < 3 ? { gaugeTypeId } : {}),
        spcEligible: true,
        chartType: 'imr',
        sampling: SAMPLING,
      }
    : { operationId, characteristicKey: `A${k - measured + 1}`, name: `Visual check ${k - measured + 1}`, dataType: 'attribute', sampling: SAMPLING };

const supplier = (i) => ({ code: `LTS${pad(i, 4)}`, name: `Load test supplier ${i}`, supplierType: null, country: 'GB' });

/** A purchase order with `lines` lines; about half name one of our parts, the rest a material. */
const purchaseOrder = (i, supplierId, partIds, rng, lines = 3) => ({
  supplierId,
  poNumber: `LTPO-${pad(i, 7)}`,
  orderedOn: day(rng.int(10, 400)),
  lines: Array.from({ length: lines }, (_, l) => {
    const requestedOn = day(rng.int(-30, 380));
    const base = { quantity: rng.int(10, 5000), unit: 'pcs', requestedOn };
    return rng.chance(0.5) && partIds.length ? { ...base, partId: rng.pick(partIds) } : { ...base, material: `Bar stock ${rng.int(1, 40)} mm` };
  }),
});

/** A delivery against an order whose lines have the given ids and quantities. */
const receipt = (i, supplierId, purchaseOrderId, lines, rng) => ({
  supplierId,
  purchaseOrderId,
  receivedOn: day(rng.int(0, 300)),
  deliveryNote: `DN-${pad(i, 7)}`,
  clientKey: `loadtest-gr-${pad(i, 7)}`,
  lines: lines.map((l) => ({ poLineId: l.id, quantity: Math.max(1, Math.round(l.quantity * (rng.chance(0.85) ? 1 : 0.6))) })),
});

const nc = (i, { siteId, partId, categoryId }, rng) => ({
  source: 'internal',
  title: `Load test non-conformance ${i}`,
  severity: rng.pick(['minor', 'minor', 'minor', 'major', 'critical']),
  description: 'Seeded by the load test harness. Out of tolerance on the second operation.',
  siteId,
  partId,
  categoryId,
  quantityAffected: rng.int(1, 40),
  quantityInspected: rng.int(40, 300),
  detectedAt: day(rng.int(0, 360)),
  open: true,
});

const startInspection = (i, siteId, partId, lotSize = 300) => ({ siteId, partId, workOrder: `LTWO-${pad(i, 7)}`, lot: `LTL-${pad(i, 7)}`, lotSize, triggerType: 'first_off' });

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The readings for one planned sample. `requirements` are the started inspection's requirements, `entry` one item of its schedule.
 * `shift` moves the mean (in units of the standard deviation) to make an inspection drift out of tolerance now and then.
 */
function sampleBody(entry, requirements, gaugeIds, rng, shift = 0) {
  const byId = new Map(requirements.map((q) => [q.id, q]));
  const readings = entry.requirementIds.map((id) => {
    const q = byId.get(id);
    const lower = num(q.lowerLimit);
    const upper = num(q.upperLimit);
    if (q.nominal !== null && q.nominal !== undefined && lower !== null && upper !== null) {
      const half = (upper - lower) / 2;
      const sd = half / 3.2;
      const value = num(q.nominal) + (rng.normal() + shift) * sd;
      return { requirementId: id, valueNumeric: value.toFixed(4), ...(q.gaugeType ? { gaugeId: rng.pick(gaugeIds) } : {}) };
    }
    return { requirementId: id, valuePass: !rng.chance(shift ? 0.1 : 0.005) };
  });
  return { unitReference: `U-${entry.position}`, triggerType: entry.trigger, readings };
}

/** The reads a person's day is made of; check-bodies.cjs validates the ones that have a query schema. */
const DAY_FROM = () => `${day(90)}`;
const DAY_TO = () => `${day(0)}`;

module.exports = { day, gaugeType, gauge, family, part, plan, operation, characteristic, supplier, purchaseOrder, receipt, nc, startInspection, sampleBody, DAY_FROM, DAY_TO, SAMPLING };
