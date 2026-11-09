/**
 * Risk-based incoming inspection recommendation (SQ6c). INFORMATION ONLY: it never changes an inspection requirement, a lot or a supplier's status. A person reads it and, if they
 * agree, writes a requirement that is approved by someone else like any other (and a requirement that reduces inspection is still never applied to a part with a critical characteristic).
 *
 * Rules (the single definition, in one place):
 *  - INCREASE when any of: supplier risk is high or critical; approval status is conditional or suspended; the performance band is poor; a critical non-conformance in the period;
 *    a corrective action request overdue for a response; 10% or more of delivered lines rejected.
 *  - REDUCE only when ALL of: approved; risk assessed and low; performance band good on at least the minimum number of delivered lines; no critical or major non-conformance;
 *    no overdue corrective action request; no expired certification. The reasons for any condition that is not met are listed.
 *  - otherwise NORMAL.
 */
export type Level = 'increased' | 'normal' | 'reduced';

export type RecommendationInput = {
  approvalStatus: string;
  riskRating: 'low' | 'medium' | 'high' | 'critical' | null;
  band: 'good' | 'watch' | 'poor' | 'insufficient';
  deliveredLines: number;
  minLines: number;
  rejectedLines: number;
  criticalNcs: number;
  majorNcs: number;
  overdueScars: number;
  expiredCerts: number;
};

export type Reason = { code: string; message: string; kind: 'raises' | 'blocks_reduction' | 'supports' };
export type Recommendation = { level: Level; reasons: Reason[]; canReduce: boolean };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function recommendInspection(i: RecommendationInput): Recommendation {
  const raises: Reason[] = [];
  const raise = (code: string, message: string) => raises.push({ code, message, kind: 'raises' });
  if (i.riskRating === 'high' || i.riskRating === 'critical') raise('risk', `The supplier's risk rating is ${i.riskRating}`);
  if (i.approvalStatus === 'conditional' || i.approvalStatus === 'suspended') raise('approval', `The supplier is ${i.approvalStatus}`);
  if (i.band === 'poor') raise('band', 'The supplier\'s performance is poor');
  if (i.criticalNcs > 0) raise('critical_nc', plural(i.criticalNcs, 'critical non-conformance', 'critical non-conformances') + ' in the period');
  if (i.overdueScars > 0) raise('scar_overdue', plural(i.overdueScars, 'corrective action request is', 'corrective action requests are') + ' overdue for a response');
  if (i.deliveredLines > 0 && i.rejectedLines / i.deliveredLines >= 0.1) raise('rejections', `${plural(i.rejectedLines, 'delivered line was', 'delivered lines were')} rejected of ${i.deliveredLines}`);
  if (raises.length > 0) return { level: 'increased', reasons: raises, canReduce: false };

  const blocks: Reason[] = [];
  const block = (code: string, message: string) => blocks.push({ code, message, kind: 'blocks_reduction' });
  if (i.approvalStatus !== 'approved') block('not_approved', `The supplier is ${i.approvalStatus.replace(/_/g, ' ')}, not approved`);
  if (i.riskRating === null) block('unassessed', 'The supplier has no risk assessment');
  else if (i.riskRating !== 'low') block('risk_not_low', `The supplier's risk rating is ${i.riskRating}, not low`);
  if (i.band === 'insufficient') block('insufficient', 'There is not enough delivery data to score the supplier');
  else if (i.band !== 'good') block('band_not_good', `Performance is ${i.band}, not good`);
  if (i.deliveredLines < i.minLines) block('few_deliveries', `Only ${plural(i.deliveredLines, 'delivered line', 'delivered lines')}; ${i.minLines} needed`);
  if (i.majorNcs > 0) block('major_nc', plural(i.majorNcs, 'major non-conformance', 'major non-conformances') + ' in the period');
  if (i.expiredCerts > 0) block('cert_expired', plural(i.expiredCerts, 'certification is', 'certifications are') + ' past its expiry date');
  if (blocks.length === 0) {
    return { level: 'reduced', canReduce: true, reasons: [{ code: 'earned', kind: 'supports', message: 'Approved, low risk, good performance on enough deliveries, and no major or critical non-conformance, overdue request or expired certification' }] };
  }
  return { level: 'normal', canReduce: false, reasons: blocks };
}
