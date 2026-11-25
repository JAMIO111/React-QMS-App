/**
 * Checks every body the harness sends against the API's own request schemas, offline: no server, no database. Run it after `npm run api:build`
 * and whenever the API's schemas change:   node scripts/loadtest/check-bodies.cjs
 * It exits 1 and says which body no longer fits.
 */
const path = require('path');
const dist = (p) => require(path.resolve(__dirname, '../../api/dist', p));
const B = require('./bodies.cjs');
const { rng } = require('./stats.cjs');

const r = rng(42);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checks = [];
const check = (name, schema, value) => checks.push({ name, schema, value });

const master = dist('master-data/master-data.schemas.js');
const pc = dist('process-control/process-control.schemas.js');
const cal = dist('calibration/calibration.schemas.js');
const insp = dist('inspection/inspection.schemas.js');
const rec = dist('receiving/receiving.schemas.js');
const sq = dist('supplier-quality/supplier-quality.schemas.js');
const ncr = dist('ncr/ncr.schemas.js');
const spc = dist('spc/spc.schemas.js');

check('gauge type', cal.CreateGaugeTypeBody, B.gaugeType());
check('gauge', cal.CreateGaugeBody, B.gauge(1, uuid(1), uuid(2)));
check('part family', pc.CreatePartFamilyBody, B.family(1));
check('part', master.CreatePartBody, B.part(1, uuid(3)));
check('control plan', pc.CreateControlPlanBody, B.plan(1, uuid(3)));
check('operation', pc.CreateOperationBody, B.operation());
for (let k = 0; k < 8; k += 1) check(`plan check ${k + 1}`, pc.CreateCharacteristicBody, B.characteristic(k, uuid(4), uuid(5)));
check('supplier', sq.CreateSupplierBody, B.supplier(1));
check('purchase order', rec.CreatePurchaseOrderBody, B.purchaseOrder(1, uuid(6), [uuid(7)], r));
check('goods receipt', rec.RecordReceiptBody, B.receipt(1, uuid(6), uuid(8), [{ id: uuid(9), quantity: 100 }], r));
check('non-conformance', ncr.CreateNcrBody, B.nc(1, { siteId: uuid(2), partId: uuid(7), categoryId: uuid(10) }, r));
check('start inspection', insp.StartInspectionBody, B.startInspection(1, uuid(2), uuid(7)));
check('acknowledge', insp.AcknowledgeBody, { note: 'Load test: noted' });
const reqs = [
  { id: uuid(11), nominal: 10, lowerLimit: 9.9, upperLimit: 10.1, gaugeType: { id: uuid(5) } },
  { id: uuid(12), nominal: null, lowerLimit: null, upperLimit: null, gaugeType: null },
];
check('sample', insp.AddSampleBody, B.sampleBody({ position: 1, trigger: 'first_off', requirementIds: [uuid(11), uuid(12)] }, reqs, [uuid(13)], r));
check('chart query', spc.ChartQuery, { partId: uuid(7), characteristicKey: 'D1' });
check('NC list query', ncr.NcrListQuery, { page: '1', pageSize: '25' });
check('PO list query', rec.PurchaseOrderListQuery, { status: 'all', page: '1', pageSize: '25', q: 'LTPO-1' });

let bad = 0;
for (const c of checks) {
  const res = c.schema.safeParse(c.value);
  if (!res.success) {
    bad += 1;
    console.error(`FAIL  ${c.name}: ${res.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
  } else console.log(`ok    ${c.name}`);
}
if (bad) {
  console.error(`\n${bad} of ${checks.length} bodies no longer fit the API's schemas.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} bodies fit the API's schemas.`);
