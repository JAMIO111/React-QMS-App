/**
 * Phase 1 exit check, API layer. Driven by the OpenAPI document, so new routes are covered
 * automatically:
 *  - every route is organisation-scoped (X-Organisation-Id) unless it is on the reviewed allowlist;
 *  - every scoped route answers 404 when the caller names an organisation they don't belong to;
 *  - every scoped route with an {id} answers 404 for another organisation's record ids, even when
 *    the caller is Owner of their own organisation (new {id} routes must add a sample body below);
 *  - no list response contains any identifier of the other organisation.
 */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { makeIds, requireDb, seed, startApp, token } from './helpers';

const ids = makeIds(4);
let app: INestApplication;
let admin: Pool;
const api = () => request(app.getHttpServer());

/** Routes that are deliberately not organisation-scoped (reviewed). */
const UNSCOPED = new Set([
  'GET /api/v1/health',
  'GET /api/v1/me',
  'PATCH /api/v1/me',
  'POST /api/v1/organisations',
  'GET /api/v1/invitations',
  'POST /api/v1/invitations/{id}/accept',
  'GET /api/v1/units', // global catalogue of measurement units
  'GET /api/v1/platform/me', // the operator area spans organisations; admin-only in the database (allow-list + MFA)
  'GET /api/v1/platform/overview',
  'GET /api/v1/platform/organisations', // operator monitor: admin-only in the database (allow-list + MFA); counts and billing, never business data
  'GET /api/v1/platform/revenue',
  'GET /api/v1/platform/payments',
  'GET /api/v1/platform/webhooks',
  'GET /api/v1/platform/activity',
  // /internal/cron/* (scheduled jobs: CRON_SECRET, only database functions made for them) is left out of the OpenAPI document, so it is not seen here; platform-monitor.e2e-spec covers it.
  'POST /api/v1/stripe/webhook', // authenticated by Stripe's signature over the raw body; applies state only through app.stripe_* functions
]);

interface Op {
  method: string;
  path: string;
  scoped: boolean;
}

let ops: Op[];
const a: Record<string, string> = {};
const b: Record<string, string> = {};

/** Valid bodies for routes that take an {id}, so validation passes and the tenant check is what answers. */
const sampleBody = (op: Op): object | undefined =>
  (<Record<string, object | undefined>>{
    'PATCH /api/v1/sites/{id}': { name: 'Hijacked' },
    'PATCH /api/v1/departments/{id}': { name: 'Hijacked' },
    'PATCH /api/v1/members/{id}': { status: 'suspended' },
    'POST /api/v1/members/{id}/role-assignments': { roleId: b.viewerRole },
    'POST /api/v1/members/{id}/departments': { departmentId: a.department },
    'POST /api/v1/members/{id}/invitation/resend': undefined,
    'POST /api/v1/members/{id}/invitation/revoke': undefined,
    'PATCH /api/v1/department-memberships/{id}': { primary: true },
    'DELETE /api/v1/department-memberships/{id}': undefined,
    'DELETE /api/v1/role-assignments/{id}': undefined,
    'PATCH /api/v1/saved-filters/{id}': { name: 'Hijacked' },
    'DELETE /api/v1/saved-filters/{id}': undefined,
    'PATCH /api/v1/customers/{id}': { name: 'Hijacked' },
    'PATCH /api/v1/suppliers/{id}': { name: 'Hijacked' },
    'GET /api/v1/supplier-quality/suppliers/{id}': undefined,
    'PATCH /api/v1/supplier-quality/suppliers/{id}': { city: 'Hijacked' },
    'POST /api/v1/supplier-quality/suppliers/{id}/status': { status: 'approved', reason: 'Hijacked' },
    'GET /api/v1/supplier-quality/suppliers/{id}/history': undefined,
    'PUT /api/v1/supplier-quality/suppliers/{id}/classifications': { classificationIds: [] },
    'POST /api/v1/supplier-quality/suppliers/{id}/contacts': { name: 'Hijacker' },
    'PATCH /api/v1/supplier-quality/supplier-contacts/{id}': { name: 'Hijacked' },
    'POST /api/v1/supplier-quality/suppliers/{id}/products': { kind: 'service', description: 'Hijacked' },
    'PATCH /api/v1/supplier-quality/supplier-products/{id}': { active: false },
    'PATCH /api/v1/supplier-quality/classifications/{id}': { label: 'Hijacked' },
    'GET /api/v1/supplier-quality/suppliers/{id}/documents': undefined,
    'POST /api/v1/supplier-quality/suppliers/{id}/documents': { docType: 'other', title: 'Hijacked', storagePath: 'x/supplier/y/z.pdf', fileName: 'z.pdf', sizeBytes: 1 },
    'PATCH /api/v1/supplier-quality/supplier-documents/{id}': { title: 'Hijacked' },
    'POST /api/v1/supplier-quality/supplier-documents/{id}/verify': {},
    'POST /api/v1/supplier-quality/supplier-documents/{id}/remove': { reason: 'Hijacked' },
    'GET /api/v1/supplier-quality/suppliers/{id}/certifications': undefined,
    'POST /api/v1/supplier-quality/suppliers/{id}/certifications': { certType: 'iso_9001', certificateNumber: 'X-1', issuingBody: 'Hijacker' },
    'PATCH /api/v1/supplier-quality/supplier-certifications/{id}': { title: 'Hijacked' },
    'POST /api/v1/supplier-quality/supplier-certifications/{id}/renew': { certificateNumber: 'X-2', issuingBody: 'Hijacker' },
    'POST /api/v1/supplier-quality/supplier-certifications/{id}/verify': {},
    'POST /api/v1/supplier-quality/supplier-certifications/{id}/withdraw': { reason: 'Hijacked' },
    'GET /api/v1/supplier-quality/suppliers/{id}/risk-assessments': undefined,
    'GET /api/v1/supplier-quality/suppliers/{id}/performance': undefined,
    'GET /api/v1/supplier-quality/suppliers/{id}/performance/settings': undefined,
    'POST /api/v1/ncrs/{id}/receipt-link': { receiptLineId: '11111111-1111-4111-8111-111111111111' },
    'POST /api/v1/receipt-line-ncrs/{id}/unlink': { reason: 'Hijacked link' },
    'PUT /api/v1/supplier-quality/suppliers/{id}/performance/settings': { graceDaysAfter: 3 },
    'GET /api/v1/supplier-quality/suppliers/{id}/inspection-recommendation': undefined,
    'GET /api/v1/supplier-quality/suppliers/{id}/scorecards': undefined,
    'POST /api/v1/supplier-quality/suppliers/{id}/scorecards': { from: '2026-01-01', to: '2026-01-31' },
    'GET /api/v1/supplier-quality/scorecards/{id}': undefined,
    'POST /api/v1/supplier-quality/suppliers/{id}/risk-assessments': { scores: [{ key: 'quality_system', score: 2 }], rationale: 'Hijacked' },
    'POST /api/v1/supplier-quality/suppliers/{id}/risk-assessments/preview': { scores: [{ key: 'quality_system', score: 2 }] },
    'PATCH /api/v1/supplier-quality/assessment-templates/{id}': { name: 'Hijacked' },
    'POST /api/v1/supplier-quality/assessment-templates/{id}/versions': { questions: [{ key: 'aa', section: '', text: 'x', answerType: 'yes_no', weight: 1, critical: false, evidenceRequired: false }], passMark: 70, reason: 'Hijacked' },
    'GET /api/v1/supplier-quality/suppliers/{id}/assessments': undefined,
    'POST /api/v1/supplier-quality/suppliers/{id}/assessments': { templateVersionId: '00000000-0000-0000-0000-000000000001' },
    'GET /api/v1/supplier-quality/supplier-assessments/{id}': undefined,
    'PUT /api/v1/supplier-quality/supplier-assessments/{id}/responses': { questionKey: 'qms_certified', answer: 'yes' },
    'POST /api/v1/supplier-quality/supplier-assessments/{id}/complete': {},
    'POST /api/v1/supplier-quality/supplier-assessments/{id}/abandon': { reason: 'Hijacked' },
    'GET /api/v1/supplier-quality/suppliers/{id}/approval-decisions': undefined,
    'POST /api/v1/supplier-quality/suppliers/{id}/approval-decisions': { target: 'approved', rationale: 'Hijacked' },
    'POST /api/v1/supplier-quality/supplier-approval-decisions/{id}/decide': { approve: true, note: 'Hijacked' },
    'POST /api/v1/supplier-quality/supplier-approval-decisions/{id}/withdraw': { reason: 'Hijacked' },
    'GET /api/v1/supplier-quality/scars/{id}': undefined,
    'PATCH /api/v1/supplier-quality/scars/{id}': { title: 'Hijacked' },
    'POST /api/v1/supplier-quality/scars/{id}/issue': {},
    'POST /api/v1/supplier-quality/scars/{id}/acknowledge': {},
    'POST /api/v1/supplier-quality/scars/{id}/responses': { rootCause: 'Hijacked', correctiveAction: 'Hijacked', respondedOn: '2026-11-01' },
    'POST /api/v1/supplier-quality/scars/{id}/start-review': {},
    'POST /api/v1/supplier-quality/scars/{id}/review': { decision: 'accepted', note: 'Hijacked' },
    'POST /api/v1/supplier-quality/scars/{id}/implementations': { description: 'Hijacked', implementedOn: '2026-11-01' },
    'POST /api/v1/supplier-quality/scars/{id}/verifications': { result: 'effective', method: 'Hijacked', note: 'Hijacked' },
    'POST /api/v1/supplier-quality/scars/{id}/extensions': { newDueOn: '2027-01-01', reason: 'Hijacked' },
    'POST /api/v1/supplier-quality/scars/{id}/cancel': { reason: 'Hijacked' },
    'POST /api/v1/supplier-quality/scars/{id}/ncrs': { ncrId: '00000000-0000-0000-0000-000000000001' },
    'POST /api/v1/supplier-quality/scar-ncrs/{id}/unlink': { reason: 'Hijacked' },
    'POST /api/v1/supplier-quality/scars/{id}/items': { material: 'Hijacked' },
    'POST /api/v1/supplier-quality/scar-items/{id}/remove': { reason: 'Hijacked' },
    'POST /api/v1/supplier-quality/scar-extensions/{id}/decide': { approve: true, note: 'Hijacked' },
    'POST /api/v1/supplier-quality/scar-extensions/{id}/withdraw': { reason: 'Hijacked' },
    'GET /api/v1/purchase-orders/{id}': undefined,
    'POST /api/v1/purchase-orders/{id}/close': {},
    'POST /api/v1/purchase-orders/{id}/cancel': { reason: 'Hijacked' },
    'PATCH /api/v1/purchase-order-lines/{id}': { agreedOn: '2027-01-01' },
    'GET /api/v1/goods-receipts/{id}': undefined,
    'POST /api/v1/goods-receipts/{id}/cancel': { reason: 'Hijacked' },
    'GET /api/v1/inspection-requirements/{id}': undefined,
    'PATCH /api/v1/inspection-requirements/{id}': { name: 'Hijacked' },
    'POST /api/v1/inspection-requirements/{id}/approve': {},
    'POST /api/v1/inspection-requirements/{id}/retire': { reason: 'Hijacked' },
    'POST /api/v1/goods-receipt-lines/{id}/start-inspection': {},
    'POST /api/v1/goods-receipt-lines/{id}/disposition': { decision: 'held', reason: 'Hijacked' },
    'POST /api/v1/goods-receipt-lines/{id}/raise-ncr': {},
    'GET /api/v1/ncrs/{id}/receipt-source': undefined,
    'GET /api/v1/material-certificates/{id}': undefined,
    'PATCH /api/v1/material-certificates/{id}': { notes: 'Hijacked' },
    'POST /api/v1/material-certificates/{id}/review': { accept: true },
    'POST /api/v1/material-certificates/{id}/withdraw': { reason: 'Hijacked' },
    'GET /api/v1/parts/{id}': undefined,
    'PATCH /api/v1/parts/{id}': { name: 'Hijacked' },
    'POST /api/v1/parts/{id}/revisions': { revision: 'Z' },
    'PATCH /api/v1/part-revisions/{id}': { drawingRef: 'Hijacked' },
    'POST /api/v1/part-revisions/{id}/release': undefined,
    'POST /api/v1/part-revisions/{id}/obsolete': undefined,
    'POST /api/v1/part-revisions/{id}/correction': { reason: 'Hijacked' },
    'GET /api/v1/part-revisions/{id}/correction-impact': undefined,
    'GET /api/v1/ncrs/{id}': undefined,
    'PATCH /api/v1/ncrs/{id}': { title: 'Hijacked' },
    'POST /api/v1/ncrs/{id}/transitions': { to: 'cancelled', reason: 'Hijacked' },
    'POST /api/v1/ncrs/{id}/source': { source: 'calibration', reason: 'Hijacked' },
    'POST /api/v1/ncrs/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/ncrs/{id}/restore': undefined,
    'GET /api/v1/ncrs/{id}/history': undefined,
    'PATCH /api/v1/ncr-classifications/{id}': { name: 'Hijacked' },
    'GET /api/v1/ncrs/{id}/costs': undefined,
    'POST /api/v1/ncrs/{id}/costs': { costType: 'scrap', currency: 'GBP', amount: 1 },
    'GET /api/v1/ncrs/{id}/attachments': undefined,
    'POST /api/v1/ncrs/{id}/attachments': { storagePath: `${b.org}/ncr/${a.ncr}/x.txt`, fileName: 'x.txt', sizeBytes: 1 },
    'PATCH /api/v1/ncr-costs/{id}': { amount: 999 },
    'POST /api/v1/ncr-costs/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/ncr-costs/{id}/restore': undefined,
    'POST /api/v1/ncr-attachments/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/ncr-attachments/{id}/restore': undefined,
    'GET /api/v1/gauges/{id}': undefined,
    'PATCH /api/v1/gauges/{id}': { description: 'Hijacked' },
    'POST /api/v1/gauges/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/gauges/{id}/restore': undefined,
    'GET /api/v1/gauges/{id}/history': undefined,
    'GET /api/v1/gauges/{id}/characteristics': undefined,
    'POST /api/v1/gauges/{id}/characteristics': { name: 'Hijacked', nominal: 1, toleranceMinus: 0, tolerancePlus: 0, unitCode: 'mm' },
    'GET /api/v1/gauges/{id}/calibrations': undefined,
    'POST /api/v1/gauges/{id}/calibrations': { outcome: 'fail' },
    'PATCH /api/v1/gauge-characteristics/{id}': { name: 'Hijacked' },
    'PATCH /api/v1/gauge-types/{id}': { name: 'Hijacked' },
    'GET /api/v1/gauge-types/{id}/characteristics': undefined,
    'POST /api/v1/gauge-types/{id}/characteristics': { name: 'Hijacked', nominal: 1, toleranceMinus: 0, tolerancePlus: 0, unitCode: 'mm' },
    'PATCH /api/v1/gauge-type-characteristics/{id}': { name: 'Hijacked' },
    'GET /api/v1/calibrations/{id}': undefined,
    'PATCH /api/v1/calibrations/{id}': { notes: 'Hijacked' },
    'POST /api/v1/calibrations/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/calibrations/{id}/restore': undefined,
    'POST /api/v1/calibrations/{id}/raise-ncr': undefined,
    'GET /api/v1/calibrations/{id}/attachments': undefined,
    'POST /api/v1/calibrations/{id}/attachments': { storagePath: `${b.org}/calibration/${a.calibration}/x.pdf`, fileName: 'x.pdf', sizeBytes: 1 },
    'POST /api/v1/calibration-attachments/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/calibration-attachments/{id}/restore': undefined,
    'PATCH /api/v1/machines/{id}': { name: 'Hijacked' },
    'PATCH /api/v1/employees/{id}': { jobTitle: 'Hijacked' },
    'PUT /api/v1/employees/{id}/login': { userId: null },
    'GET /api/v1/part-families/{id}': undefined,
    'PATCH /api/v1/part-families/{id}': { name: 'Hijacked' },
    'GET /api/v1/part-revisions/{id}/characteristics': undefined,
    'POST /api/v1/part-revisions/{id}/characteristics': { characteristicKey: 'HIJACK', nominal: 1, unitCode: 'mm' },
    'PATCH /api/v1/part-revision-characteristics/{id}': { nominal: 999 },
    'DELETE /api/v1/part-revision-characteristics/{id}': undefined,
    'GET /api/v1/control-plans/{id}': undefined,
    'PATCH /api/v1/control-plans/{id}': { title: 'Hijacked' },
    'GET /api/v1/control-plans/{id}/history': undefined,
    'POST /api/v1/control-plans/{id}/applicability': { partFamilyId: a.family },
    'POST /api/v1/control-plans/{id}/revisions': { revisionCode: 'Z' },
    'DELETE /api/v1/control-plan-applicability/{id}': undefined,
    'PATCH /api/v1/control-plan-revisions/{id}': { changeReason: 'Hijacked' },
    'POST /api/v1/control-plan-revisions/{id}/transitions': { action: 'obsolete', reason: 'Hijacked' },
    'POST /api/v1/parts/{id}/customers': { customerId: a.customer },
    'PATCH /api/v1/part-customers/{id}': { customerPartNumber: 'HIJACK' },
    'DELETE /api/v1/part-customers/{id}': undefined,
    'POST /api/v1/part-families/{id}/parts': { remove: [a.part] },
    'GET /api/v1/inspections/{id}/ncr-draft': undefined,
    'POST /api/v1/inspections/{id}/raise-ncr': { title: 'Hijacked' },
    'POST /api/v1/inspections/{id}/add-to-ncr': { ncrId: a.ncr, measurementIds: [a.measurement] },
    'POST /api/v1/inspection-measurements/{id}/acknowledge': { note: 'Hijacked' },
    'PATCH /api/v1/jobs/{id}': { workOrder: 'HIJACK' },
    'PUT /api/v1/jobs/{id}/production-links': { productionOrderId: null },
    'GET /api/v1/jobs/{id}/recent-ncrs': undefined,
    'GET /api/v1/jobs/{id}/revisions': undefined,
    'GET /api/v1/ncrs/{id}/containment': undefined,
    'POST /api/v1/ncrs/{id}/containment-actions': { kind: 'sort', description: 'Hijacked' },
    'PUT /api/v1/ncrs/{id}/containment-reason': { reason: 'Hijacked' },
    'GET /api/v1/ncrs/{id}/dispositions': undefined,
    'POST /api/v1/ncrs/{id}/dispositions': { decision: 'scrap', quantity: 1, instructions: 'Hijacked' },
    'GET /api/v1/ncrs/{id}/gates': undefined,
    'GET /api/v1/ncrs/{id}/affected-lots': undefined,
    'GET /api/v1/audits/{id}': undefined,
    'GET /api/v1/audits/{id}/versions': undefined,
    'GET /api/v1/audits/{id}/versions/{version}': undefined,
    'PATCH /api/v1/audits/{id}': { title: 'Hijacked', changeReason: 'Hijacked' },
    'POST /api/v1/audits/{id}/retire': { reason: 'Hijacked' },
    'POST /api/v1/audits/{id}/reactivate': undefined,
    'POST /api/v1/audit-occurrences/{id}/skip': { reason: 'Hijacked' },
    'GET /api/v1/audit-records/{id}': undefined,
    'PATCH /api/v1/audit-records/{id}': { notes: 'Hijacked' },
    'PUT /api/v1/audit-records/{id}/targets': { targets: [] },
    'PUT /api/v1/audit-records/{id}/responses': { questionId: a.auditQuestion, answer: 'pass' },
    'POST /api/v1/audit-records/{id}/complete': undefined,
    'POST /api/v1/audit-records/{id}/abandon': { reason: 'Hijacked' },
    'GET /api/v1/audit-records/{id}/findings': undefined,
    'POST /api/v1/audit-records/{id}/findings': { classificationId: a.findingClassification, title: 'Hijacked', description: 'Hijacked' },
    'GET /api/v1/audit-findings/{id}': undefined,
    'PATCH /api/v1/audit-findings/{id}': { title: 'Hijacked' },
    'POST /api/v1/audit-findings/{id}/withdraw': { reason: 'Hijacked' },
    'POST /api/v1/audit-findings/{id}/close': { note: 'Hijacked' },
    'POST /api/v1/audit-findings/{id}/reopen': { reason: 'Hijacked' },
    'POST /api/v1/audit-findings/{id}/create-ncr': {},
    'GET /api/v1/audit-findings/{id}/attachments': undefined,
    'POST /api/v1/audit-findings/{id}/attachments': { storagePath: 'x/audit/y/findings/z/a.jpg', fileName: 'a.jpg', sizeBytes: 1 },
    'POST /api/v1/audit-finding-attachments/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/audit-finding-attachments/{id}/restore': undefined,
    'PATCH /api/v1/audit-finding-classifications/{id}': { label: 'Hijacked' },
    'GET /api/v1/ncrs/{id}/audit-source': undefined,
    'GET /api/v1/audit-records/{id}/attachments': undefined,
    'POST /api/v1/audit-records/{id}/attachments': { questionId: a.auditQuestion, storagePath: 'x/audit/y/z.jpg', fileName: 'z.jpg', sizeBytes: 1 },
    'POST /api/v1/audit-attachments/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/audit-attachments/{id}/restore': undefined,
    'POST /api/v1/audit-occurrences/{id}/unskip': undefined,
    'POST /api/v1/ncrs/{id}/affected-lots': { lotId: '00000000-0000-4000-8000-000000000001', quantity: 1 },
    'PATCH /api/v1/ncr-affected-lots/{id}': { quantity: 1 },
    'POST /api/v1/ncr-affected-lots/{id}/remove': { reason: 'Hijacked' },
    'POST /api/v1/ncr-affected-lots/{id}/restore': undefined,
    'PATCH /api/v1/ncr-containment-actions/{id}': { description: 'Hijacked' },
    'POST /api/v1/ncr-containment-actions/{id}/complete': { note: 'Hijacked' },
    'POST /api/v1/ncr-containment-actions/{id}/reopen': undefined,
    'POST /api/v1/ncr-containment-actions/{id}/cancel': { reason: 'Hijacked' },
    'PATCH /api/v1/ncr-dispositions/{id}': { quantity: 1 },
    'POST /api/v1/ncr-dispositions/{id}/approve': {},
    'POST /api/v1/ncr-dispositions/{id}/cancel': { reason: 'Hijacked' },
    'POST /api/v1/spc/alerts/{id}/acknowledge': { note: 'Hijacked' },
    'GET /api/v1/quality-alerts/{id}': undefined,
    'PATCH /api/v1/quality-alerts/{id}': { title: 'Hijacked' },
    'DELETE /api/v1/quality-alerts/{id}': undefined,
    'POST /api/v1/quality-alerts/{id}/issue': undefined,
    'POST /api/v1/quality-alerts/{id}/withdraw': { reason: 'Hijacked' },
    'POST /api/v1/quality-alerts/{id}/revisions': { reason: 'Hijacked' },
    'POST /api/v1/quality-alerts/{id}/reopen': { expiryDate: '2099-01-01', reason: 'Hijacked' },
    'GET /api/v1/quality-alerts/{id}/recipients': undefined,
    'GET /api/v1/quality-alerts/{id}/recipients-preview': undefined,
    'POST /api/v1/quality-alerts/{id}/recipients': { membershipId: a.ownerMembership },
    'POST /api/v1/quality-alerts/{id}/acknowledge': { note: 'Hijacked' },
    'GET /api/v1/quality-alerts/{id}/attachments': undefined,
    'POST /api/v1/quality-alerts/{id}/attachments': { storagePath: 'x', fileName: 'x.pdf', sizeBytes: 1 },
    'POST /api/v1/quality-alert-attachments/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/quality-alert-attachments/{id}/restore': undefined,
    'GET /api/v1/capas/{id}': undefined,
    'PATCH /api/v1/capas/{id}': { title: 'Hijacked' },
    'POST /api/v1/capas/{id}/complete-step': { step: 'd0' },
    'POST /api/v1/capas/{id}/reopen-step': { step: 'd0', reason: 'Hijacked' },
    'POST /api/v1/capas/{id}/cancel': { reason: 'Hijacked' },
    'POST /api/v1/capas/{id}/reopen': { reason: 'Hijacked' },
    'POST /api/v1/capas/{id}/team': { externalName: 'Hijacker' },
    'POST /api/v1/capas/{id}/ncrs': { ncrId: a.ncr },
    'PATCH /api/v1/capa-team/{id}': { role: 'member' },
    'POST /api/v1/capa-ncr-links/{id}/unlink': { reason: 'Hijacked' },
    'POST /api/v1/capas/{id}/analyses': { kind: 'is_is_not', title: 'Hijacked', data: {} },
    'POST /api/v1/capas/{id}/actions': { phase: 'interim', description: 'Hijacked' },
    'PATCH /api/v1/capa-analyses/{id}': { title: 'Hijacked' },
    'DELETE /api/v1/capa-analyses/{id}': undefined,
    'PATCH /api/v1/capa-actions/{id}': { description: 'Hijacked' },
    'POST /api/v1/capa-actions/{id}/complete': { evidenceNote: 'Hijacked' },
    'POST /api/v1/capa-actions/{id}/cancel': { reason: 'Hijacked' },
    'POST /api/v1/capa-actions/{id}/reopen': undefined,
    'POST /api/v1/capas/{id}/root-causes': { kind: 'occurrence', description: 'Hijacked' },
    'POST /api/v1/capas/{id}/verifications': { effective: true, method: 'Hijacked' },
    'POST /api/v1/capas/{id}/close': { recognition: 'Hijacked' },
    'GET /api/v1/capas/{id}/attachments': undefined,
    'POST /api/v1/capas/{id}/attachments': { storagePath: 'x/capa/y/z.pdf', fileName: 'z.pdf', sizeBytes: 1 },
    'POST /api/v1/capa-attachments/{id}/delete': { reason: 'Hijacked' },
    'POST /api/v1/capa-attachments/{id}/restore': undefined,
    'PATCH /api/v1/capa-root-causes/{id}': { description: 'Hijacked' },
    'DELETE /api/v1/capa-root-causes/{id}': undefined,
    'GET /api/v1/ncrs/{id}/capas': undefined,
    'GET /api/v1/ncrs/{id}/inspection-source': undefined,
    'GET /api/v1/calibrations/{id}/gauge-usage': undefined,
    'GET /api/v1/inspections/{id}': undefined,
    'POST /api/v1/inspections/{id}/samples': { readings: [{ requirementId: a.requirement, valueNumeric: '1' }] },
    'POST /api/v1/inspections/{id}/complete': undefined,
    'POST /api/v1/inspections/{id}/abandon': { reason: 'Hijacked' },
    'POST /api/v1/inspection-measurements/{id}/correction': { valueNumeric: '1', reason: 'Hijacked' },
    'GET /api/v1/control-plan-revisions/{id}': undefined,
    'GET /api/v1/control-plan-revisions/{id}/comparison': undefined,
    'POST /api/v1/control-plan-revisions/{id}/operations': { operationCode: 'OP-99', name: 'Hijacked' },
    'POST /api/v1/control-plan-revisions/{id}/characteristics': { operationId: a.operation, characteristicKey: 'HIJACK', name: 'Hijacked', upperLimit: 1, unitCode: 'mm' },
    'PUT /api/v1/control-plan-revisions/{id}/reactions': { reactions: [] },
    'PATCH /api/v1/control-plan-operations/{id}': { name: 'Hijacked' },
    'DELETE /api/v1/control-plan-operations/{id}': undefined,
    'PATCH /api/v1/control-plan-characteristics/{id}': { name: 'Hijacked' },
    'PATCH /api/v1/characteristic-templates/{id}': { name: 'Hijacked' },
    'PUT /api/v1/subscription/assignments/{id}': { planSlug: 'controller' },
    'DELETE /api/v1/subscription/assignments/{id}': undefined,
    'DELETE /api/v1/control-plan-characteristics/{id}': undefined,
    'GET /api/v1/production-orders/{id}': undefined,
    'PATCH /api/v1/production-orders/{id}': { notes: 'Hijacked' },
    'POST /api/v1/production-orders/{id}/operations': { operationCode: 'OP-99' },
    'PATCH /api/v1/production-operations/{id}': { description: 'Hijacked' },
    'GET /api/v1/lots/{id}': undefined,
    'PATCH /api/v1/lots/{id}': { notes: 'Hijacked' },
    'GET /api/v1/serial-numbers/{id}': undefined,
    'PATCH /api/v1/serial-numbers/{id}': { notes: 'Hijacked' },
  })[`${op.method} ${op.path}`];

const hasSample = (op: Op) =>
  [
    'PATCH /api/v1/sites/{id}',
    'PATCH /api/v1/departments/{id}',
    'PATCH /api/v1/members/{id}',
    'POST /api/v1/members/{id}/role-assignments',
    'POST /api/v1/members/{id}/departments',
    'POST /api/v1/members/{id}/invitation/resend',
    'POST /api/v1/members/{id}/invitation/revoke',
    'PATCH /api/v1/department-memberships/{id}',
    'DELETE /api/v1/department-memberships/{id}',
    'DELETE /api/v1/role-assignments/{id}',
    'PATCH /api/v1/saved-filters/{id}',
    'DELETE /api/v1/saved-filters/{id}',
    'PATCH /api/v1/customers/{id}',
    'PATCH /api/v1/suppliers/{id}',
    'GET /api/v1/supplier-quality/suppliers/{id}',
    'PATCH /api/v1/supplier-quality/suppliers/{id}',
    'POST /api/v1/supplier-quality/suppliers/{id}/status',
    'GET /api/v1/supplier-quality/suppliers/{id}/history',
    'PUT /api/v1/supplier-quality/suppliers/{id}/classifications',
    'POST /api/v1/supplier-quality/suppliers/{id}/contacts',
    'PATCH /api/v1/supplier-quality/supplier-contacts/{id}',
    'POST /api/v1/supplier-quality/suppliers/{id}/products',
    'PATCH /api/v1/supplier-quality/supplier-products/{id}',
    'PATCH /api/v1/supplier-quality/classifications/{id}',
    'GET /api/v1/supplier-quality/suppliers/{id}/documents',
    'POST /api/v1/supplier-quality/suppliers/{id}/documents',
    'PATCH /api/v1/supplier-quality/supplier-documents/{id}',
    'POST /api/v1/supplier-quality/supplier-documents/{id}/verify',
    'POST /api/v1/supplier-quality/supplier-documents/{id}/remove',
    'GET /api/v1/supplier-quality/suppliers/{id}/certifications',
    'POST /api/v1/supplier-quality/suppliers/{id}/certifications',
    'PATCH /api/v1/supplier-quality/supplier-certifications/{id}',
    'POST /api/v1/supplier-quality/supplier-certifications/{id}/renew',
    'POST /api/v1/supplier-quality/supplier-certifications/{id}/verify',
    'POST /api/v1/supplier-quality/supplier-certifications/{id}/withdraw',
    'GET /api/v1/supplier-quality/suppliers/{id}/risk-assessments',
    'GET /api/v1/supplier-quality/suppliers/{id}/performance',
    'GET /api/v1/supplier-quality/suppliers/{id}/performance/settings',
    'POST /api/v1/ncrs/{id}/receipt-link',
    'POST /api/v1/receipt-line-ncrs/{id}/unlink',
    'PUT /api/v1/supplier-quality/suppliers/{id}/performance/settings',
    'GET /api/v1/supplier-quality/suppliers/{id}/inspection-recommendation',
    'GET /api/v1/supplier-quality/suppliers/{id}/scorecards',
    'POST /api/v1/supplier-quality/suppliers/{id}/scorecards',
    'GET /api/v1/supplier-quality/scorecards/{id}',
    'POST /api/v1/supplier-quality/suppliers/{id}/risk-assessments',
    'POST /api/v1/supplier-quality/suppliers/{id}/risk-assessments/preview',
    'PATCH /api/v1/supplier-quality/assessment-templates/{id}',
    'POST /api/v1/supplier-quality/assessment-templates/{id}/versions',
    'GET /api/v1/supplier-quality/suppliers/{id}/assessments',
    'POST /api/v1/supplier-quality/suppliers/{id}/assessments',
    'GET /api/v1/supplier-quality/supplier-assessments/{id}',
    'PUT /api/v1/supplier-quality/supplier-assessments/{id}/responses',
    'POST /api/v1/supplier-quality/supplier-assessments/{id}/complete',
    'POST /api/v1/supplier-quality/supplier-assessments/{id}/abandon',
    'GET /api/v1/supplier-quality/suppliers/{id}/approval-decisions',
    'POST /api/v1/supplier-quality/suppliers/{id}/approval-decisions',
    'POST /api/v1/supplier-quality/supplier-approval-decisions/{id}/decide',
    'POST /api/v1/supplier-quality/supplier-approval-decisions/{id}/withdraw',
    'GET /api/v1/supplier-quality/scars/{id}',
    'PATCH /api/v1/supplier-quality/scars/{id}',
    'POST /api/v1/supplier-quality/scars/{id}/issue',
    'POST /api/v1/supplier-quality/scars/{id}/acknowledge',
    'POST /api/v1/supplier-quality/scars/{id}/responses',
    'POST /api/v1/supplier-quality/scars/{id}/start-review',
    'POST /api/v1/supplier-quality/scars/{id}/review',
    'POST /api/v1/supplier-quality/scars/{id}/implementations',
    'POST /api/v1/supplier-quality/scars/{id}/verifications',
    'POST /api/v1/supplier-quality/scars/{id}/extensions',
    'POST /api/v1/supplier-quality/scars/{id}/cancel',
    'POST /api/v1/supplier-quality/scars/{id}/ncrs',
    'POST /api/v1/supplier-quality/scar-ncrs/{id}/unlink',
    'POST /api/v1/supplier-quality/scars/{id}/items',
    'POST /api/v1/supplier-quality/scar-items/{id}/remove',
    'POST /api/v1/supplier-quality/scar-extensions/{id}/decide',
    'POST /api/v1/supplier-quality/scar-extensions/{id}/withdraw',
    'GET /api/v1/purchase-orders/{id}',
    'POST /api/v1/purchase-orders/{id}/close',
    'POST /api/v1/purchase-orders/{id}/cancel',
    'PATCH /api/v1/purchase-order-lines/{id}',
    'GET /api/v1/goods-receipts/{id}',
    'POST /api/v1/goods-receipts/{id}/cancel',
    'GET /api/v1/inspection-requirements/{id}',
    'PATCH /api/v1/inspection-requirements/{id}',
    'POST /api/v1/inspection-requirements/{id}/approve',
    'POST /api/v1/inspection-requirements/{id}/retire',
    'POST /api/v1/goods-receipt-lines/{id}/start-inspection',
    'POST /api/v1/goods-receipt-lines/{id}/disposition',
    'POST /api/v1/goods-receipt-lines/{id}/raise-ncr',
    'GET /api/v1/ncrs/{id}/receipt-source',
    'GET /api/v1/material-certificates/{id}',
    'PATCH /api/v1/material-certificates/{id}',
    'POST /api/v1/material-certificates/{id}/review',
    'POST /api/v1/material-certificates/{id}/withdraw',
    'GET /api/v1/parts/{id}',
    'PATCH /api/v1/parts/{id}',
    'POST /api/v1/parts/{id}/revisions',
    'PATCH /api/v1/part-revisions/{id}',
    'POST /api/v1/part-revisions/{id}/release',
    'POST /api/v1/part-revisions/{id}/obsolete',
    'POST /api/v1/part-revisions/{id}/correction',
    'GET /api/v1/part-revisions/{id}/correction-impact',
    'GET /api/v1/ncrs/{id}',
    'PATCH /api/v1/ncrs/{id}',
    'POST /api/v1/ncrs/{id}/transitions',
    'POST /api/v1/ncrs/{id}/source',
    'POST /api/v1/ncrs/{id}/delete',
    'POST /api/v1/ncrs/{id}/restore',
    'GET /api/v1/ncrs/{id}/history',
    'PATCH /api/v1/ncr-classifications/{id}',
    'GET /api/v1/ncrs/{id}/costs',
    'POST /api/v1/ncrs/{id}/costs',
    'GET /api/v1/ncrs/{id}/attachments',
    'POST /api/v1/ncrs/{id}/attachments',
    'PATCH /api/v1/ncr-costs/{id}',
    'POST /api/v1/ncr-costs/{id}/delete',
    'POST /api/v1/ncr-costs/{id}/restore',
    'POST /api/v1/ncr-attachments/{id}/delete',
    'POST /api/v1/ncr-attachments/{id}/restore',
    'GET /api/v1/gauges/{id}',
    'PATCH /api/v1/gauges/{id}',
    'POST /api/v1/gauges/{id}/delete',
    'POST /api/v1/gauges/{id}/restore',
    'GET /api/v1/gauges/{id}/history',
    'GET /api/v1/gauges/{id}/characteristics',
    'POST /api/v1/gauges/{id}/characteristics',
    'GET /api/v1/gauges/{id}/calibrations',
    'POST /api/v1/gauges/{id}/calibrations',
    'PATCH /api/v1/gauge-characteristics/{id}',
    'PATCH /api/v1/gauge-types/{id}',
    'GET /api/v1/gauge-types/{id}/characteristics',
    'POST /api/v1/gauge-types/{id}/characteristics',
    'PATCH /api/v1/gauge-type-characteristics/{id}',
    'GET /api/v1/calibrations/{id}',
    'PATCH /api/v1/calibrations/{id}',
    'POST /api/v1/calibrations/{id}/delete',
    'POST /api/v1/calibrations/{id}/restore',
    'POST /api/v1/calibrations/{id}/raise-ncr',
    'GET /api/v1/calibrations/{id}/attachments',
    'POST /api/v1/calibrations/{id}/attachments',
    'POST /api/v1/calibration-attachments/{id}/delete',
    'POST /api/v1/calibration-attachments/{id}/restore',
    'PATCH /api/v1/machines/{id}',
    'GET /api/v1/employees/{id}',
    'PATCH /api/v1/employees/{id}',
    'PUT /api/v1/employees/{id}/login',
    'GET /api/v1/part-families/{id}',
    'PATCH /api/v1/part-families/{id}',
    'GET /api/v1/part-revisions/{id}/characteristics',
    'POST /api/v1/part-revisions/{id}/characteristics',
    'PATCH /api/v1/part-revision-characteristics/{id}',
    'DELETE /api/v1/part-revision-characteristics/{id}',
    'GET /api/v1/control-plans/{id}',
    'PATCH /api/v1/control-plans/{id}',
    'GET /api/v1/control-plans/{id}/history',
    'POST /api/v1/control-plans/{id}/applicability',
    'POST /api/v1/control-plans/{id}/revisions',
    'DELETE /api/v1/control-plan-applicability/{id}',
    'PATCH /api/v1/control-plan-revisions/{id}',
    'POST /api/v1/control-plan-revisions/{id}/transitions',
    'POST /api/v1/parts/{id}/customers',
    'PATCH /api/v1/part-customers/{id}',
    'DELETE /api/v1/part-customers/{id}',
    'POST /api/v1/part-families/{id}/parts',
    'GET /api/v1/inspections/{id}/ncr-draft',
    'POST /api/v1/inspections/{id}/raise-ncr',
    'POST /api/v1/inspections/{id}/add-to-ncr',
    'POST /api/v1/inspection-measurements/{id}/acknowledge',
    'PATCH /api/v1/jobs/{id}',
    'PUT /api/v1/jobs/{id}/production-links',
    'GET /api/v1/jobs/{id}/recent-ncrs',
    'GET /api/v1/jobs/{id}/revisions',
    'GET /api/v1/ncrs/{id}/containment',
    'POST /api/v1/ncrs/{id}/containment-actions',
    'PUT /api/v1/ncrs/{id}/containment-reason',
    'GET /api/v1/ncrs/{id}/dispositions',
    'POST /api/v1/ncrs/{id}/dispositions',
    'GET /api/v1/ncrs/{id}/gates',
    'GET /api/v1/ncrs/{id}/affected-lots',
    'GET /api/v1/audits/{id}',
    'GET /api/v1/audits/{id}/versions',
    'GET /api/v1/audits/{id}/versions/{version}',
    'PATCH /api/v1/audits/{id}',
    'POST /api/v1/audits/{id}/retire',
    'POST /api/v1/audits/{id}/reactivate',
    'POST /api/v1/audit-occurrences/{id}/skip',
    'GET /api/v1/audit-records/{id}',
    'PATCH /api/v1/audit-records/{id}',
    'PUT /api/v1/audit-records/{id}/targets',
    'PUT /api/v1/audit-records/{id}/responses',
    'POST /api/v1/audit-records/{id}/complete',
    'POST /api/v1/audit-records/{id}/abandon',
    'GET /api/v1/audit-records/{id}/findings',
    'POST /api/v1/audit-records/{id}/findings',
    'GET /api/v1/audit-findings/{id}',
    'PATCH /api/v1/audit-findings/{id}',
    'POST /api/v1/audit-findings/{id}/withdraw',
    'POST /api/v1/audit-findings/{id}/close',
    'POST /api/v1/audit-findings/{id}/reopen',
    'POST /api/v1/audit-findings/{id}/create-ncr',
    'GET /api/v1/audit-findings/{id}/attachments',
    'POST /api/v1/audit-findings/{id}/attachments',
    'POST /api/v1/audit-finding-attachments/{id}/delete',
    'POST /api/v1/audit-finding-attachments/{id}/restore',
    'PATCH /api/v1/audit-finding-classifications/{id}',
    'GET /api/v1/ncrs/{id}/audit-source',
    'GET /api/v1/audit-records/{id}/attachments',
    'POST /api/v1/audit-records/{id}/attachments',
    'POST /api/v1/audit-attachments/{id}/delete',
    'POST /api/v1/audit-attachments/{id}/restore',
    'POST /api/v1/audit-occurrences/{id}/unskip',
    'POST /api/v1/ncrs/{id}/affected-lots',
    'PATCH /api/v1/ncr-affected-lots/{id}',
    'POST /api/v1/ncr-affected-lots/{id}/remove',
    'POST /api/v1/ncr-affected-lots/{id}/restore',
    'PATCH /api/v1/ncr-containment-actions/{id}',
    'POST /api/v1/ncr-containment-actions/{id}/complete',
    'POST /api/v1/ncr-containment-actions/{id}/reopen',
    'POST /api/v1/ncr-containment-actions/{id}/cancel',
    'PATCH /api/v1/ncr-dispositions/{id}',
    'POST /api/v1/ncr-dispositions/{id}/approve',
    'POST /api/v1/ncr-dispositions/{id}/cancel',
    'POST /api/v1/spc/alerts/{id}/acknowledge',
    'GET /api/v1/quality-alerts/{id}',
    'PATCH /api/v1/quality-alerts/{id}',
    'DELETE /api/v1/quality-alerts/{id}',
    'POST /api/v1/quality-alerts/{id}/issue',
    'POST /api/v1/quality-alerts/{id}/withdraw',
    'POST /api/v1/quality-alerts/{id}/revisions',
    'POST /api/v1/quality-alerts/{id}/reopen',
    'GET /api/v1/quality-alerts/{id}/recipients',
    'GET /api/v1/quality-alerts/{id}/recipients-preview',
    'POST /api/v1/quality-alerts/{id}/recipients',
    'POST /api/v1/quality-alerts/{id}/acknowledge',
    'GET /api/v1/quality-alerts/{id}/attachments',
    'POST /api/v1/quality-alerts/{id}/attachments',
    'POST /api/v1/quality-alert-attachments/{id}/delete',
    'POST /api/v1/quality-alert-attachments/{id}/restore',
    'GET /api/v1/capas/{id}',
    'PATCH /api/v1/capas/{id}',
    'POST /api/v1/capas/{id}/complete-step',
    'POST /api/v1/capas/{id}/reopen-step',
    'POST /api/v1/capas/{id}/cancel',
    'POST /api/v1/capas/{id}/reopen',
    'POST /api/v1/capas/{id}/team',
    'POST /api/v1/capas/{id}/ncrs',
    'PATCH /api/v1/capa-team/{id}',
    'POST /api/v1/capa-ncr-links/{id}/unlink',
    'POST /api/v1/capas/{id}/analyses',
    'POST /api/v1/capas/{id}/actions',
    'PATCH /api/v1/capa-analyses/{id}',
    'DELETE /api/v1/capa-analyses/{id}',
    'PATCH /api/v1/capa-actions/{id}',
    'POST /api/v1/capa-actions/{id}/complete',
    'POST /api/v1/capa-actions/{id}/cancel',
    'POST /api/v1/capa-actions/{id}/reopen',
    'POST /api/v1/capas/{id}/root-causes',
    'POST /api/v1/capas/{id}/verifications',
    'POST /api/v1/capas/{id}/close',
    'GET /api/v1/capas/{id}/attachments',
    'POST /api/v1/capas/{id}/attachments',
    'POST /api/v1/capa-attachments/{id}/delete',
    'POST /api/v1/capa-attachments/{id}/restore',
    'PATCH /api/v1/capa-root-causes/{id}',
    'DELETE /api/v1/capa-root-causes/{id}',
    'GET /api/v1/ncrs/{id}/capas',
    'GET /api/v1/ncrs/{id}/inspection-source',
    'GET /api/v1/calibrations/{id}/gauge-usage',
    'GET /api/v1/inspections/{id}',
    'POST /api/v1/inspections/{id}/samples',
    'POST /api/v1/inspections/{id}/complete',
    'POST /api/v1/inspections/{id}/abandon',
    'POST /api/v1/inspection-measurements/{id}/correction',
    'GET /api/v1/control-plan-revisions/{id}',
    'GET /api/v1/control-plan-revisions/{id}/comparison',
    'POST /api/v1/control-plan-revisions/{id}/operations',
    'POST /api/v1/control-plan-revisions/{id}/characteristics',
    'PUT /api/v1/control-plan-revisions/{id}/reactions',
    'PATCH /api/v1/control-plan-operations/{id}',
    'DELETE /api/v1/control-plan-operations/{id}',
    'PATCH /api/v1/control-plan-characteristics/{id}',
    'PATCH /api/v1/characteristic-templates/{id}',
    'PUT /api/v1/subscription/assignments/{id}',
    'DELETE /api/v1/subscription/assignments/{id}',
    'DELETE /api/v1/control-plan-characteristics/{id}',
    'GET /api/v1/production-orders/{id}',
    'PATCH /api/v1/production-orders/{id}',
    'POST /api/v1/production-orders/{id}/operations',
    'PATCH /api/v1/production-operations/{id}',
    'GET /api/v1/lots/{id}',
    'PATCH /api/v1/lots/{id}',
    'GET /api/v1/serial-numbers/{id}',
    'PATCH /api/v1/serial-numbers/{id}',
  ].includes(`${op.method} ${op.path}`);

/** Organisation A's record id for the resource a path refers to. */
const foreignIdFor = (path: string) => {
  if (path.startsWith('/api/v1/sites/')) return a.site;
  if (path.startsWith('/api/v1/departments/')) return a.department;
  if (path.startsWith('/api/v1/members/')) return a.ownerMembership;
  if (path.startsWith('/api/v1/role-assignments/')) return a.ownerAssignment;
  if (path.startsWith('/api/v1/department-memberships/')) return a.departmentMember;
  if (path.startsWith('/api/v1/customers/')) return a.customer;
  if (path.startsWith('/api/v1/suppliers/')) return a.supplier;
  if (path.startsWith('/api/v1/supplier-quality/suppliers/')) return a.supplier;
  if (path.startsWith('/api/v1/supplier-quality/supplier-contacts/')) return a.supplierContact;
  if (path.startsWith('/api/v1/supplier-quality/supplier-products/')) return a.supplierProduct;
  if (path.startsWith('/api/v1/supplier-quality/supplier-documents/')) return a.supplierDocument;
  if (path.startsWith('/api/v1/supplier-quality/assessment-templates/')) return a.supplierTemplate;
  if (path.startsWith('/api/v1/supplier-quality/supplier-assessments/')) return a.supplierAssessment;
  if (path.startsWith('/api/v1/supplier-quality/supplier-approval-decisions/')) return a.supplierDecision;
  if (path.startsWith('/api/v1/supplier-quality/scars/')) return a.supplierScar;
  if (path.startsWith('/api/v1/supplier-quality/scar-ncrs/')) return a.supplierScarLink;
  if (path.startsWith('/api/v1/purchase-orders/')) return a.purchaseOrder;
  if (path.startsWith('/api/v1/purchase-order-lines/')) return a.poLine;
  if (path.startsWith('/api/v1/goods-receipts/')) return a.goodsReceipt;
  if (path.startsWith('/api/v1/inspection-requirements/')) return a.requirement;
  if (path.startsWith('/api/v1/goods-receipt-lines/')) return a.receiptLine;
  if (path.startsWith('/api/v1/receipt-line-ncrs/')) return a.receiptLineNcr;
  if (path.startsWith('/api/v1/material-certificates/')) return a.materialCertificate;
  if (path.startsWith('/api/v1/supplier-quality/scorecards/')) return a.scorecard;
  if (path.startsWith('/api/v1/supplier-quality/scar-items/')) return a.supplierScarItem;
  if (path.startsWith('/api/v1/supplier-quality/scar-extensions/')) return a.supplierScarExtension;
  if (path.startsWith('/api/v1/supplier-quality/supplier-certifications/')) return a.supplierCertification;
  if (path.startsWith('/api/v1/supplier-quality/classifications/')) return a.supplierClassification;
  if (path.startsWith('/api/v1/parts/')) return a.part;
  if (path.startsWith('/api/v1/part-revisions/')) return a.draftRevision;
  if (path.startsWith('/api/v1/ncrs/')) return a.ncr;
  if (path.startsWith('/api/v1/ncr-classifications/')) return a.classification;
  if (path.startsWith('/api/v1/ncr-costs/')) return a.cost;
  if (path.startsWith('/api/v1/ncr-containment-actions/')) return a.containmentAction;
  if (path.startsWith('/api/v1/ncr-dispositions/')) return a.disposition;
  if (path.startsWith('/api/v1/ncr-affected-lots/')) return a.affectedLot;
  if (path.startsWith('/api/v1/audits/')) return a.audit;
  if (path.startsWith('/api/v1/audit-occurrences/')) return a.occurrence;
  if (path.startsWith('/api/v1/audit-records/')) return a.auditRecord;
  if (path.startsWith('/api/v1/audit-attachments/')) return a.auditAttachment;
  if (path.startsWith('/api/v1/audit-findings/')) return a.finding;
  if (path.startsWith('/api/v1/audit-finding-attachments/')) return a.findingAttachment;
  if (path.startsWith('/api/v1/audit-finding-classifications/')) return a.findingClassification;
  if (path.startsWith('/api/v1/ncr-attachments/')) return a.attachment;
  if (path.startsWith('/api/v1/gauges/')) return a.gauge;
  if (path.startsWith('/api/v1/gauge-characteristics/')) return a.gaugeCharacteristic;
  if (path.startsWith('/api/v1/gauge-types/')) return a.gaugeType;
  if (path.startsWith('/api/v1/gauge-type-characteristics/')) return a.typeCharacteristic;
  if (path.startsWith('/api/v1/calibrations/')) return a.calibration;
  if (path.startsWith('/api/v1/calibration-attachments/')) return a.calibrationAttachment;
  if (path.startsWith('/api/v1/part-customers/')) return a.partCustomer;
  if (path.startsWith('/api/v1/inspections/')) return a.inspection;
  if (path.startsWith('/api/v1/jobs/')) return a.inspection;
  if (path.startsWith('/api/v1/spc/alerts/')) return a.alert;
  if (path.startsWith('/api/v1/quality-alerts/')) return a.qualityAlert;
  if (path.startsWith('/api/v1/quality-alert-attachments/')) return a.qualityAlertAttachment;
  if (path.startsWith('/api/v1/saved-filters/')) return a.savedFilter;
  if (path.startsWith('/api/v1/capas/')) return a.capa;
  if (path.startsWith('/api/v1/capa-team/')) return a.capaTeam;
  if (path.startsWith('/api/v1/capa-attachments/')) return a.capaAttachment;
  if (path.startsWith('/api/v1/capa-ncr-links/')) return a.capaLink;
  if (path.startsWith('/api/v1/capa-analyses/')) return a.capaAnalysis;
  if (path.startsWith('/api/v1/capa-actions/')) return a.capaAction;
  if (path.startsWith('/api/v1/capa-root-causes/')) return a.capaRootCause;
  if (path.startsWith('/api/v1/inspection-measurements/')) return a.measurement;
  if (path.startsWith('/api/v1/production-orders/')) return a.productionOrder;
  if (path.startsWith('/api/v1/production-operations/')) return a.productionOperation;
  if (path.startsWith('/api/v1/lots/')) return a.lot;
  if (path.startsWith('/api/v1/serial-numbers/')) return a.serial;
  if (path.startsWith('/api/v1/machines/')) return a.machine;
  if (path.startsWith('/api/v1/employees/')) return a.employee;
  if (path.startsWith('/api/v1/part-families/')) return a.family;
  if (path.startsWith('/api/v1/part-revision-characteristics/')) return a.specValue;
  if (path.startsWith('/api/v1/control-plans/')) return a.plan;
  if (path.startsWith('/api/v1/control-plan-applicability/')) return a.applicability;
  if (path.startsWith('/api/v1/control-plan-revisions/')) return a.planRevision;
  if (path.startsWith('/api/v1/control-plan-operations/')) return a.operation;
  if (path.startsWith('/api/v1/control-plan-characteristics/')) return a.characteristic;
  if (path.startsWith('/api/v1/characteristic-templates/')) return a.characteristicTemplate;
  if (path.startsWith('/api/v1/subscription/assignments/')) return a.ownerMembership;
  return undefined;
};

const call = (op: Op, path: string, headers: Record<string, string>, body?: object) => {
  const m = op.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
  const req = api()[m](path).set(headers);
  return body === undefined ? req : req.send(body);
};

beforeAll(async () => {
  admin = new Pool({ connectionString: requireDb().adminUrl });
  await seed(admin, ids, '-sweep');
  app = await startApp({ RATE_LIMIT_PER_MINUTE: '10000' });

  const doc = (await api().get('/api/v1/openapi.json').expect(200)).body;
  ops = Object.entries(doc.paths as Record<string, Record<string, { parameters?: { in: string; name: string }[] }>>).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, spec]) => ({
      method: method.toUpperCase(),
      path,
      scoped: (spec.parameters ?? []).some((p) => p.in === 'header' && p.name === 'X-Organisation-Id'),
    })),
  );

  const one = async (q: string, params: unknown[]) => (await admin.query(q, params)).rows[0];
  a.org = ids.orgA;
  a.site = ids.siteA;
  a.department = (await one(`insert into public.departments (organisation_id, site_id, code, name) values ($1, $2, 'QA', 'Quality A') returning id`, [ids.orgA, ids.siteA])).id;
  a.ownerMembership = (await one('select id from public.organisation_users where organisation_id = $1 and user_id = $2', [ids.orgA, ids.ownerA])).id;
  a.ownerAssignment = (await one('select id from public.user_role_assignments where membership_id = $1', [a.ownerMembership])).id;
  a.departmentMember = (await one(`insert into public.department_members (organisation_id, department_id, membership_id) values ($1, $2, $3) returning id`, [ids.orgA, a.department, a.ownerMembership])).id;
  a.ownerRole = (await one(`select id from public.roles where organisation_id = $1 and key = 'owner'`, [ids.orgA])).id;
  a.ownerUser = ids.ownerA;
  a.customer = (await one(`insert into public.customers (organisation_id, code, name) values ($1, 'ACUST', 'Alpha customer') returning id`, [ids.orgA])).id;
  a.supplier = (await one(`insert into public.suppliers (organisation_id, code, name) values ($1, 'ASUPP', 'Alpha supplier') returning id`, [ids.orgA])).id;
  a.supplierNcr = (await one(`insert into public.nonconformances (organisation_id, reference, source, title, supplier_id) values ($1, 'A-NCR-SCAR', 'supplier', 'Alpha supplier NC', $2) returning id`, [ids.orgA, a.supplier])).id;
  a.part = (await one(`insert into public.parts (organisation_id, part_number, name) values ($1, 'A-PART', 'Alpha part') returning id`, [ids.orgA])).id;
  a.draftRevision = (await one(`insert into public.part_revisions (organisation_id, part_id, revision) values ($1, $2, 'A') returning id`, [ids.orgA, a.part])).id;
  a.classification = (await one(`insert into public.ncr_classifications (organisation_id, kind, name) values ($1, 'failure_mode', 'Alpha failure') returning id`, [ids.orgA])).id;
  a.ncr = (await one(`insert into public.nonconformances (organisation_id, reference, source, title) values ($1, 'A-NCR-1', 'internal', 'Alpha NCR') returning id`, [ids.orgA])).id;
  a.cost = (await one(`insert into public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) values ($1, $2, 'scrap', 'GBP', 10) returning id`, [ids.orgA, a.ncr])).id;
  a.containmentAction = (await one(`insert into public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description) values ($1, $2, 'quarantine', 'Alpha containment') returning id`, [ids.orgA, a.ncr])).id;
  a.disposition = (await one(`insert into public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions) values ($1, $2, 'scrap', 1, 'Alpha disposition') returning id`, [ids.orgA, a.ncr])).id;
  a.attachment = (await one(`insert into public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) values ($1::uuid, $2::uuid, $1::text || '/ncr/' || $2::text || '/a.txt', 'a.txt', 1) returning id`, [ids.orgA, a.ncr])).id;
  a.gaugeType = (await one(`insert into public.gauge_types (organisation_id, name) values ($1, 'Alpha caliper') returning id`, [ids.orgA])).id;
  a.typeCharacteristic = (await one(`insert into public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal, tolerance_minus, tolerance_plus, unit_code) values ($1, $2, 'Alpha check', 25, 0.02, 0.02, 'mm') returning id`, [ids.orgA, a.gaugeType])).id;
  a.gauge = (await one(`insert into public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) values ($1, 'A-G1', 'Alpha gauge', $2, $3) returning id`, [ids.orgA, a.gaugeType, ids.siteA])).id;
  a.gaugeCharacteristic = (await one('select id from public.gauge_characteristics where gauge_id = $1', [a.gauge])).id;
  a.calibration = (await one(`insert into public.calibrations (organisation_id, gauge_id, reference, outcome) values ($1, $2, 'A-CAL-1', 'fail') returning id`, [ids.orgA, a.gauge])).id;
  a.calibrationAttachment = (await one(`insert into public.calibration_attachments (organisation_id, calibration_id, storage_path, file_name, size_bytes) values ($1::uuid, $2::uuid, $1::text || '/calibration/' || $2::text || '/a.pdf', 'a.pdf', 1) returning id`, [ids.orgA, a.calibration])).id;
  a.partCustomer = (await one(`insert into public.part_customers (organisation_id, part_id, customer_id, customer_part_number) values ($1, $2, $3, 'A-CPN') returning id`, [ids.orgA, a.part, a.customer])).id;
  a.productionOrder = (await one(`insert into public.production_orders (organisation_id, order_number, part_id, site_id, quantity_planned) values ($1, 'A-WO-1', $2, $3, 10) returning id`, [ids.orgA, a.part, ids.siteA])).id;
  a.productionOperation = (await one(`insert into public.production_operations (organisation_id, production_order_id, sequence, operation_code) values ($1, $2, 10, 'OP-10') returning id`, [ids.orgA, a.productionOrder])).id;
  a.lot = (await one(`insert into public.lots (organisation_id, lot_number, part_id, origin, production_order_id) values ($1, 'A-LOT-1', $2, 'produced', $3) returning id`, [ids.orgA, a.part, a.productionOrder])).id;
  a.serial = (await one(`insert into public.serial_numbers (organisation_id, serial_number, part_id, lot_id) values ($1, 'A-SN-1', $2, $3) returning id`, [ids.orgA, a.part, a.lot])).id;
  a.ncrWithLot = (await one(`insert into public.nonconformances (organisation_id, reference, source, title, part_id, quantity_affected) values ($1, 'A-NCR-LOT', 'internal', 'Alpha lot NCR', $2, 5) returning id`, [ids.orgA, a.part])).id;
  a.affectedLot = (await one(`insert into public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) values ($1, $2, $3, 2) returning id`, [ids.orgA, a.ncrWithLot, a.lot])).id;
  a.audit = (await one(`insert into public.audit_definitions (organisation_id, audit_number, reference, title, audit_type, frequency_kind, first_due_on) values ($1, 1, 'AUD-001', 'Alpha audit', 'process', 'monthly', current_date) returning id`, [ids.orgA])).id;
  a.occurrence = (await one(`insert into public.audit_occurrences (organisation_id, audit_definition_id, due_on) values ($1, $2, current_date) returning id`, [ids.orgA, a.audit])).id;
  a.auditRecord = (await one(`insert into public.audit_records (organisation_id, reference, audit_definition_id, audit_reference, audit_title, audit_type, pass_mark) values ($1, 'A-AR-1', $2, 'AUD-001', 'Alpha audit', 'process', 80) returning id`, [ids.orgA, a.audit])).id;
  a.auditQuestion = (await one(`insert into public.audit_record_questions (organisation_id, audit_record_id, sequence, question, answer_type) values ($1, $2, 1, 'Alpha question', 'pass_fail') returning id`, [ids.orgA, a.auditRecord])).id;
  a.auditResponse = (await one(`insert into public.audit_responses (organisation_id, audit_record_id, record_question_id, answer, result) values ($1, $2, $3, 'fail', 'fail') returning id`, [ids.orgA, a.auditRecord, a.auditQuestion])).id;
  a.auditAttachment = (await one(`insert into public.audit_attachments (organisation_id, audit_record_id, record_question_id, storage_path, file_name, size_bytes) values ($1::uuid, $2::uuid, $3::uuid, $1::text || '/audit/' || $2::text || '/a.jpg', 'a.jpg', 1) returning id`, [ids.orgA, a.auditRecord, a.auditQuestion])).id;
  a.findingClassification = (await one(`select id from public.audit_finding_classifications where organisation_id = $1 and key = 'major_nc'`, [ids.orgA])).id;
  a.finding = (await one(`insert into public.audit_findings (organisation_id, reference, audit_record_id, response_id, classification_id, title, description) values ($1, 'A-AF-1', $2, $3, $4, 'Alpha finding', 'Found') returning id`, [ids.orgA, a.auditRecord, a.auditResponse, a.findingClassification])).id;
  a.findingAttachment = (await one(`insert into public.audit_finding_attachments (organisation_id, audit_record_id, finding_id, storage_path, file_name, size_bytes) values ($1::uuid, $2::uuid, $3::uuid, $1::text || '/audit/' || $2::text || '/findings/' || $3::text || '/a.jpg', 'a.jpg', 1) returning id`, [ids.orgA, a.auditRecord, a.finding])).id;
  a.employee = (await one(`insert into public."Employees" (organisation_id, first_name, surname, job_title) values ($1, 'Alpha', 'Employee', 'Operator') returning id`, [ids.orgA])).id;
  a.machine = (await one(`insert into public.machines (organisation_id, code, name) values ($1, 'A-M1', 'Alpha machine') returning id`, [ids.orgA])).id;
  a.family = (await one(`insert into public.part_families (organisation_id, code, name) values ($1, 'A-FAM', 'Alpha family') returning id`, [ids.orgA])).id;
  a.specValue = (await one(`insert into public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, unit_code) values ($1, $2, 'LENGTH', 10, 'mm') returning id`, [ids.orgA, a.draftRevision])).id;
  a.plan = (await one(`insert into public.control_plans (organisation_id, plan_code, title) values ($1, 'A-CP', 'Alpha plan') returning id`, [ids.orgA])).id;
  a.applicability = (await one(`insert into public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) values ($1, $2, $3) returning id`, [ids.orgA, a.plan, a.family])).id;
  a.planRevision = (await one(`insert into public.control_plan_revisions (organisation_id, control_plan_id, revision_code) values ($1, $2, 'A') returning id`, [ids.orgA, a.plan])).id;
  a.operation = (await one(`insert into public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) values ($1, $2, 'OP-10', 'Alpha op') returning id`, [ids.orgA, a.planRevision])).id;
  a.characteristic = (await one(`insert into public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, upper_limit, unit_code) values ($1, $2, $3, 'OD', 'Alpha OD', 5, 'mm') returning id`, [ids.orgA, a.planRevision, a.operation])).id;
  a.characteristicTemplate = (await one(`insert into public.characteristic_templates (organisation_id, name, characteristic_key, upper_limit, unit_code) values ($1, 'Alpha OD template', 'OD', 5, 'mm') returning id`, [ids.orgA])).id;
  // An in-process inspection of A, started the only way there is: app.start_inspection as A's owner.
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ids.ownerA, role: 'authenticated' })]);
    await client.query('set local role authenticated');
    const q1 = async (text: string, params: unknown[] = []) => (await client.query(text, params)).rows[0];
    const ipart = (await q1(`insert into public.parts (organisation_id, part_number, name, part_family_id) values ($1, 'A-INSP', 'Alpha inspected', $2) returning id`, [ids.orgA, a.family])).id;
    const irev = (await q1(`insert into public.part_revisions (organisation_id, part_id, revision) values ($1, $2, 'A') returning id`, [ids.orgA, ipart])).id;
    await client.query(`update public.part_revisions set status = 'released' where id = $1`, [irev]);
    const iplan = (await q1(`insert into public.control_plans (organisation_id, plan_code, title) values ($1, 'A-CP-INSP', 'Alpha inspection plan') returning id`, [ids.orgA])).id;
    await client.query(`insert into public.control_plan_applicability (organisation_id, control_plan_id, part_id) values ($1, $2, $3)`, [ids.orgA, iplan, ipart]);
    const iprev = (await q1(`insert into public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) values ($1, $2, 'A', 'Sweep') returning id`, [ids.orgA, iplan])).id;
    const iop = (await q1(`insert into public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) values ($1, $2, 'OP-10', 'Op') returning id`, [ids.orgA, iprev])).id;
    await client.query(`insert into public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, upper_limit, unit_code) values ($1, $2, $3, 'OD', 'OD', 5, 'mm')`, [ids.orgA, iprev, iop]);
    for (const status of ['pending_approval', 'approved', 'effective']) await client.query(`update public.control_plan_revisions set status = $1 where id = $2`, [status, iprev]);
    a.inspection = (await q1(`select app.start_inspection($1, $2) as id`, [ids.siteA, ipart])).id;
    a.requirement = (await q1(`select id from public.resolved_inspection_requirements where inspection_record_id = $1`, [a.inspection])).id;
    const isample = (await q1(`insert into public.inspection_samples (organisation_id, inspection_record_id) values ($1, $2) returning id`, [ids.orgA, a.inspection])).id;
    a.measurement = (await q1(`insert into public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) values ($1, $2, $3, $4, 1) returning id`, [ids.orgA, a.inspection, isample, a.requirement])).id;
    await client.query(`select app.raise_spc_alerts($1, $2, '[{"characteristicKey":"OD","characteristicName":"OD","operationCode":"OP-1","variant":"imr","rule":"we1","side":"above","pointAt":"2026-11-05T08:00:00Z","summary":"Rule 1","inspectionId":null,"inspectionReference":null}]'::jsonb)`, [ids.orgA, ipart]);
    a.alert = (await q1(`select id from public.spc_alerts where organisation_id = $1`, [ids.orgA])).id;
    a.qualityAlert = (await q1(`insert into public.quality_alerts (organisation_id, title, category, severity) values ($1, 'Alpha alert', 'product', 'low') returning id`, [ids.orgA])).id;
    a.qualityAlertAttachment = (await q1(`select app.add_quality_alert_attachment($1::uuid, $2::text || '/quality-alerts/' || $1::text || '/a.pdf', 'a.pdf', 'application/pdf', 1) as id`, [a.qualityAlert, ids.orgA])).id;
    a.capa = (await q1(`select app.start_capa($1::uuid, 'Alpha 8D', 'Alpha problem', null, null, null) as id`, [ids.orgA])).id;
    a.capaTeam = (await q1(`select id from public.capa_team_members where capa_id = $1 limit 1`, [a.capa])).id;
    a.capaLink = (await q1(`select app.link_capa_ncr($1::uuid, $2::uuid) as id`, [a.capa, a.ncr])).id;
    a.capaAnalysis = (await q1(`insert into public.capa_analyses (organisation_id, capa_id, kind, title, step, data) values ($1, $2, 'is_is_not', 'Alpha Is / Is-Not', 'd2', '{"rows":[]}') returning id`, [ids.orgA, a.capa])).id;
    a.capaAttachment = (await q1(`select app.add_capa_attachment($2::uuid, $1::text || '/capa/' || $2::text || '/a.pdf', 'a.pdf', 'application/pdf', 1) as id`, [ids.orgA, a.capa])).id;
    a.capaRootCause = (await q1(`insert into public.capa_root_causes (organisation_id, capa_id, kind, description) values ($1, $2, 'occurrence', 'Alpha root cause') returning id`, [ids.orgA, a.capa])).id;
    a.capaAction = (await q1(`insert into public.capa_actions (organisation_id, capa_id, phase, description) values ($1, $2, 'interim', 'Alpha containment') returning id`, [ids.orgA, a.capa])).id;
    a.savedFilter = (await q1(`insert into public.saved_filters (organisation_id, user_id, scope, name, filters) values ($1, $2, 'ncr_register', 'Alpha filter', '{"stage":"open"}') returning id`, [ids.orgA, ids.ownerA])).id;
    a.supplierClassification = (await q1(`select id from public.supplier_classifications where organisation_id = $1 and key = 'welding'`, [ids.orgA])).id;
    a.supplierContact = (await q1(`insert into public.supplier_contacts (organisation_id, supplier_id, name) values ($1, $2, 'Alpha contact') returning id`, [ids.orgA, a.supplier])).id;
    a.supplierDocument = (await q1(`select app.add_supplier_document($1::uuid, 'other', 'Alpha doc', null, null, null, null, $2, 'a.pdf', null, 1) as id`, [a.supplier, `${ids.orgA}/supplier/${a.supplier}/a.pdf`])).id;
    a.supplierCertification = (await q1(`select app.add_supplier_certification($1::uuid, $2::jsonb) as id`, [a.supplier, JSON.stringify({ certType: 'iso_9001', certificateNumber: 'A-1', issuingBody: 'Alpha body' })])).id;
    a.supplierTemplate = (await q1(`select id from public.supplier_assessment_templates where organisation_id = $1 limit 1`, [ids.orgA])).id;
    a.supplierAssessment = (await q1(`select app.start_supplier_assessment($1::uuid, (select v.id from public.supplier_assessment_template_versions v where v.organisation_id = $2 and v.version = 1 limit 1)) as id`, [a.supplier, ids.orgA])).id;
    a.supplierDecision = (await q1(`select app.propose_supplier_approval($1::uuid, 'approved', 'Sweep proposal', null, null, null, 'Sweep exception reason') as id`, [a.supplier])).id;
    a.supplierScar = (await q1(`select (app.create_supplier_scar($1::uuid, 'Alpha SCAR', null, 'minor', current_date + 30, null, array[$2]::uuid[], null, null) ->> 'id')::uuid as id`, [a.supplier, a.supplierNcr])).id;
    await client.query(`select app.issue_supplier_scar($1::uuid)`, [a.supplierScar]);
    a.supplierScarLink = (await q1(`select id from public.supplier_scar_ncrs where scar_id = $1 limit 1`, [a.supplierScar])).id;
    a.purchaseOrder = (await q1(`select app.create_purchase_order($1::uuid, 'ALPHA-PO-1', current_date, null, jsonb_build_array(jsonb_build_object('material', 'Alpha steel', 'quantity', 10, 'requestedOn', (current_date + 5)::text))) as id`, [a.supplier])).id;
    a.poLine = (await q1(`select id from public.purchase_order_lines where purchase_order_id = $1 limit 1`, [a.purchaseOrder])).id;
    a.goodsReceipt = ((await q1(`select app.record_goods_receipt($1::uuid, $2::uuid, null, current_date, 'DN-A1', null, jsonb_build_array(jsonb_build_object('poLineId', $3::text, 'quantity', 2)), null) as r`, [a.supplier, a.purchaseOrder, a.poLine])).r as { id: string }).id;
    a.requirement = (await q1(`select app.save_inspection_requirement($1::uuid, null, '{"name":"Alpha rule","strategy":"full"}'::jsonb) as id`, [ids.orgA])).id;
    a.receiptLine = (await q1(`select id from public.goods_receipt_lines where goods_receipt_id = $1 limit 1`, [a.goodsReceipt])).id;
    const lkNcr = (await q1(`insert into public.nonconformances (organisation_id, reference, source, title, supplier_id) values ($1, 'A-NCR-LK', 'supplier', 'Alpha linked NCR', $2) returning id`, [ids.orgA, a.supplier])).id;
    a.receiptLineNcr = (await q1(`select app.link_ncr_to_receipt_line($1::uuid, $2::uuid) as id`, [lkNcr, a.receiptLine])).id;
    a.materialCertificate = (await q1(`select app.record_material_certificate($1::uuid, jsonb_build_object('certificateNumber', 'ALPHA-MTR', 'kind', 'mill_test_report', 'heatNumber', 'HA-1', 'receiptLineId', $2::text)) as id`, [a.supplier, a.receiptLine])).id;
    a.scorecard = (await q1(`select app.save_supplier_scorecard($1::uuid, current_date - 30, current_date, 'Alpha scorecard') as id`, [a.supplier])).id;
    a.supplierScarItem = (await q1(`select app.add_scar_item($1::uuid, '{"material":"Alpha steel"}'::jsonb) as id`, [a.supplierScar])).id;
    a.supplierScarExtension = (await q1(`select app.request_scar_extension($1::uuid, current_date + 40, 'Alpha extension') as id`, [a.supplierScar])).id;
    a.supplierProduct = (await q1(`insert into public.supplier_product_links (organisation_id, supplier_id, kind, description) values ($1, $2, 'service', 'Alpha service') returning id`, [ids.orgA, a.supplier])).id;
    await client.query('commit');
  } finally {
    client.release();
  }
  b.org = ids.orgB;
  b.viewerRole = (await one(`select id from public.roles where organisation_id = $1 and key = 'viewer'`, [ids.orgB])).id;
  b.part = (await one(`insert into public.parts (organisation_id, part_number, name) values ($1, 'B-PART', 'Beta part') returning id`, [ids.orgB])).id;
  b.productionOrder = (await one(`insert into public.production_orders (organisation_id, order_number, part_id, quantity_planned) values ($1, 'B-WO-1', $2, 5) returning id`, [ids.orgB, b.part])).id;
  b.supplier = (await one(`insert into public.suppliers (organisation_id, code, name) values ($1, 'B-SUP', 'Beta supplier') returning id`, [ids.orgB])).id;
  b.machine = (await one(`insert into public.machines (organisation_id, code, name) values ($1, 'B-M1', 'Beta machine') returning id`, [ids.orgB])).id;
  await admin.query(`insert into public.departments (organisation_id, site_id, code, name) values ($1, $2, 'QA', 'Quality B')`, [ids.orgB, ids.siteB]);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
});

describe('tenancy sweep over every API route', () => {
  it('discovers the documented routes', () => {
    expect(ops.length).toBeGreaterThanOrEqual(15);
  });

  it('scopes every route to an organisation unless it is on the reviewed allowlist', () => {
    const unscoped = ops.filter((o) => !o.scoped).map((o) => `${o.method} ${o.path}`).sort();
    expect(unscoped).toEqual([...UNSCOPED].sort());
  });

  it('answers 404 on every scoped route for an organisation the caller does not belong to', async () => {
    const auth = { Authorization: `Bearer ${await token(ids.ownerB)}`, 'X-Organisation-Id': ids.orgA };
    const results: string[] = [];
    for (const op of ops.filter((o) => o.scoped)) {
      const path = op.path.replace('{id}', foreignIdFor(op.path) ?? '00000000-0000-0000-0000-000000000000').replace('{version}', '1');
      const res = await call(op, path, auth, op.method === 'GET' || op.method === 'DELETE' ? undefined : {});
      if (res.status !== 404 || res.body?.error?.code !== 'organisation_not_found') results.push(`${op.method} ${op.path} -> ${res.status}`);
    }
    expect(results).toEqual([]);
  });

  it('answers 404 for another organisation’s record ids, even to an Owner of their own organisation', async () => {
    const auth = { Authorization: `Bearer ${await token(ids.ownerB)}`, 'X-Organisation-Id': ids.orgB };
    const idOps = ops.filter((o) => o.scoped && o.path.includes('{id}'));
    expect(idOps.filter((o) => !hasSample(o)).map((o) => `${o.method} ${o.path} needs a sample body in this test`)).toEqual([]);

    const results: string[] = [];
    for (const op of idOps) {
      const res = await call(op, op.path.replace('{id}', foreignIdFor(op.path)!).replace('{version}', '1'), auth, sampleBody(op));
      if (res.status !== 404) results.push(`${op.method} ${op.path} -> ${res.status} ${JSON.stringify(res.body)}`);
    }
    expect(results).toEqual([]);

    // Nothing of A changed.
    const { rows } = await admin.query(
      `select (select name from public.sites where id = $1) site, (select name from public.departments where id = $2) dept,
              (select status from public.organisation_users where id = $3) member, (select count(*)::int from public.user_role_assignments where id = $4) assignment,
              (select name from public.customers where id = $5) customer, (select name from public.suppliers where id = $6) supplier,
              (select name from public.parts where id = $7) part,
              (select status || '/' || coalesce(drawing_ref, '') || '/' || (select count(*) from public.part_revisions where part_id = $7) from public.part_revisions where id = $8) revision,
              (select title || '/' || stage || '/' || (deleted_at is null) from public.nonconformances where id = $9) ncr,
              (select name from public.ncr_classifications where id = $10) classification,
              (select amount || '/' || (deleted_at is null) from public.ncr_costs where id = $11) cost,
              (select (deleted_at is null)::text from public.ncr_attachments where id = $12) attachment,
              (select count(*)::int from public.ncr_costs where nonconformance_id = $9) costs,
              (select count(*)::int from public.ncr_attachments where nonconformance_id = $9) attachments`,
      [a.site, a.department, a.ownerMembership, a.ownerAssignment, a.customer, a.supplier, a.part, a.draftRevision, a.ncr, a.classification, a.cost, a.attachment],
    );
    expect(rows[0]).toEqual({
      site: 'Alpha main', dept: 'Quality A', member: 'active', assignment: 1,
      customer: 'Alpha customer', supplier: 'Alpha supplier', part: 'Alpha part', revision: 'draft//1',
      ncr: 'Alpha NCR/draft/true', classification: 'Alpha failure',
      cost: '10/true', attachment: 'true', costs: 1, attachments: 1,
    });
    const cal = await admin.query(
      `select (select description || '/' || (deleted_at is null) from public.gauges where id = $1) gauge,
              (select count(*)::int from public.gauge_characteristics where gauge_id = $1) characteristics,
              (select coalesce(notes, '') || '/' || (deleted_at is null) || '/' || (nonconformance_id is null) from public.calibrations where id = $2) calibration,
              (select count(*)::int from public.calibrations where gauge_id = $1) calibrations,
              (select name from public.gauge_types where id = $3) type,
              (select count(*)::int from public.gauge_type_characteristics where gauge_type_id = $3) template`,
      [a.gauge, a.calibration, a.gaugeType],
    );
    expect(cal.rows[0]).toEqual({ gauge: 'Alpha gauge/true', characteristics: 1, calibration: '/true/true', calibrations: 1, type: 'Alpha caliper', template: 1 });
    const pc = await admin.query(
      `select (select name from public.machines where id = $1) machine, (select job_title from public."Employees" where id = $6) employee, (select name from public.part_families where id = $2) family,
              (select nominal::text from public.part_revision_characteristics where id = $3) spec,
              (select title from public.control_plans where id = $4) plan,
              (select count(*)::int from public.control_plan_applicability where control_plan_id = $4) scope,
              (select string_agg(status || '/' || coalesce(change_reason, ''), ',') from public.control_plan_revisions where control_plan_id = $4) revisions,
              (select string_agg(operation_code || '/' || name, ',') from public.control_plan_operations where control_plan_revision_id = $5) operations,
              (select string_agg(characteristic_key || '/' || name, ',') from public.control_plan_characteristics where control_plan_revision_id = $5) characteristics,
              (select count(*)::int from public.reaction_plans where control_plan_revision_id = $5) reactions`,
      [a.machine, a.family, a.specValue, a.plan, a.planRevision, a.employee],
    );
    expect(pc.rows[0]).toEqual({
      machine: 'Alpha machine', employee: 'Operator', family: 'Alpha family', spec: '10', plan: 'Alpha plan', scope: 1, revisions: 'draft/',
      operations: 'OP-10/Alpha op', characteristics: 'OD/Alpha OD', reactions: 0,
    });
    const md = await admin.query(
      `select (select string_agg(customer_part_number || '/' || is_primary, ',') from public.part_customers where part_id = $1) customers,
              (select part_family_id::text from public.parts where id = $1) family`,
      [a.part],
    );
    expect(md.rows[0]).toEqual({ customers: 'A-CPN/true', family: null });
    const insp = await admin.query(
      `select (select status || '/' || coalesce(abandon_reason, '') from public.inspection_records where id = $1) inspection,
              (select count(*)::int from public.inspection_samples where inspection_record_id = $1) samples,
              (select count(*)::int from public.inspection_measurements where inspection_record_id = $1) readings`,
      [a.inspection],
    );
    expect(insp.rows[0]).toEqual({ inspection: 'in_progress/', samples: 1, readings: 1 });
    const links = await admin.query(
      `select (select count(*)::int from public.inspection_ncr_links where inspection_record_id = $1) links,
              (select count(*)::int from public.inspection_failure_acknowledgements where inspection_record_id = $1) acknowledgements`,
      [a.inspection],
    );
    expect(links.rows[0]).toEqual({ links: 0, acknowledgements: 0 });
  });

  it('never includes another organisation’s identifiers in list responses', async () => {
    const auth = { Authorization: `Bearer ${await token(ids.ownerB)}`, 'X-Organisation-Id': ids.orgB };
    // The SPC chart and baseline reads need a characteristic with readings; their isolation is tested in spc.e2e-spec.ts (analysis: spc-analysis.e2e-spec.ts).
    const needsData = ['/api/v1/spc/chart', '/api/v1/spc/baselines', '/api/v1/spc/analysis', '/api/v1/incoming-inspection/preview'];
    const lists = ops.filter((o) => o.scoped && o.method === 'GET' && !o.path.includes('{id}') && !needsData.includes(o.path));
    const leaks: string[] = [];
    // Routes that need query parameters get a valid set, so the tenant check is what is tested.
    const listQuery: Record<string, string> = {
      '/api/v1/quality-alerts/active': '?operationCode=OP-1',
      '/api/v1/ncr-dashboard': '?from=2025-01-01&to=2027-12-31',
      '/api/v1/calibration-dashboard': '?from=2025-01-01&to=2027-12-31',
      '/api/v1/control-plan-resolution': `?partId=${b.part}`,
      '/api/v1/jobs/preview': `?machineId=${b.machine}&partId=${b.part}`,
      '/api/v1/subscription/check': '?module=inspections',
      '/api/v1/spc/characteristics': `?partId=${b.part}`,
      '/api/v1/process-control-dashboard': '?from=2025-01-01&to=2027-12-31',
      '/api/v1/audits-dashboard': '?from=2025-01-01&to=2027-12-31',
      '/api/v1/traceability': `?type=order&id=${b.productionOrder}`,
      '/api/v1/traceability/search': '?q=WO',
      '/api/v1/saved-filters': '?scope=ncr_register',
      '/api/v1/goods-receipt-lines/lookup': `?supplierId=${b.supplier}`,
    };
    for (const op of lists) {
      const res = await call(op, op.path + (listQuery[op.path] ?? ''), auth);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      for (const [name, id] of Object.entries(a)) if (text.includes(id)) leaks.push(`${op.path} contains A ${name}`);
    }
    // Also the unscoped reads.
    for (const path of ['/api/v1/me', '/api/v1/invitations']) {
      const text = JSON.stringify((await api().get(path).set({ Authorization: auth.Authorization }).expect(200)).body);
      for (const [name, id] of Object.entries(a)) if (text.includes(id)) leaks.push(`${path} contains A ${name}`);
    }
    expect(leaks).toEqual([]);
  });
});
