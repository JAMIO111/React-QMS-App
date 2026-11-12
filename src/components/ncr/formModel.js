import { format } from "date-fns";
import { detectionApplies } from "../../lib/ncr";

/** NCR form values ↔ API bodies. */
export const EMPTY = {
  title: "", severity: null, description: "", requirement: "", actualResult: "", siteId: null, detectedAt: format(new Date(), "yyyy-MM-dd"),
  detectionProcessId: null, partId: null, partRevisionId: null, lotNumber: "", serialNumber: "", quantityAffected: "", quantityInspected: "",
  customerId: null, customerReference: "", supplierId: null, purchaseOrder: "", workOrder: "",
  productionOrderId: null, lotId: null, serialId: null,
  categoryId: null, failureModeId: null, subFailureModeId: null, causalProcessId: null, responsibleEmployeeId: null,
};

/** A non-conformance raised by hand starts at minor (NCs raised from an inspection, audit, calibration, receipt or import set their own). */
export const NEW_NC = { ...EMPTY, severity: "minor" };

/** API record → form values. */
export const toForm = (n) => ({
  title: n.title ?? "", severity: n.severity, description: n.description ?? "", requirement: n.requirement ?? "", actualResult: n.actualResult ?? "",
  siteId: n.site?.id ?? null, detectedAt: n.detectedAt, detectionProcessId: n.detectionProcess?.id ?? null,
  partId: n.part?.id ?? null, partRevisionId: n.partRevisionId ?? null, lotNumber: n.lotNumber ?? "", serialNumber: n.serialNumber ?? "",
  quantityAffected: n.quantityAffected ?? "", quantityInspected: n.quantityInspected ?? "",
  customerId: n.customer?.id ?? null, customerReference: n.customerReference ?? "", supplierId: n.supplier?.id ?? null,
  purchaseOrder: n.purchaseOrder ?? "", workOrder: n.workOrder ?? "",
  productionOrderId: n.links?.productionOrder?.id ?? null, lotId: n.links?.lot?.id ?? null, serialId: n.links?.serial?.id ?? null,
  categoryId: n.category?.id ?? null, failureModeId: n.failureMode?.id ?? null, subFailureModeId: n.subFailureMode?.id ?? null, causalProcessId: n.causalProcess?.id ?? null,
  responsibleEmployeeId: n.responsibleEmployee?.id ?? null,
});

/** Form values → API body (empty strings → null, quantities → numbers). Only fields relevant to the source (the source itself is not part of the form). */
export const toBody = (form, source) => {
  const body = { ...form, title: form.title.trim() };
  for (const k of ["quantityAffected", "quantityInspected"]) body[k] = form[k] === "" || form[k] === null ? null : Number(form[k]);
  for (const [k, v] of Object.entries(body)) if (typeof v === "string" && k !== "title" && k !== "detectedAt") body[k] = v.trim() === "" ? null : v.trim();
  if (source !== "customer") { delete body.customerId; delete body.customerReference; }
  // Goods receiving may name the supplier it came from; the other sources leave the party fields out (anything entered earlier is kept).
  const supplierSide = source === "supplier" || source === "goods_receiving";
  if (!supplierSide) { delete body.supplierId; delete body.purchaseOrder; }
  if (supplierSide) delete body.workOrder;
  // "Where detected" is not asked for these sources (anything entered earlier is kept).
  if (!detectionApplies(source)) delete body.detectionProcessId;
  return body;
};

export const changedFields = (body, original) => Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(original[k] ?? null)));

