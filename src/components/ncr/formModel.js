import { format } from "date-fns";

/** NCR form values ↔ API bodies. */
export const EMPTY = {
  title: "", severity: null, description: "", requirement: "", actualResult: "", siteId: null, detectedAt: format(new Date(), "yyyy-MM-dd"),
  detectionProcessId: null, partId: null, partRevisionId: null, lotNumber: "", serialNumber: "", quantityAffected: "", quantityInspected: "",
  customerId: null, customerReference: "", supplierId: null, purchaseOrder: "", workOrder: "",
  failureModeId: null, subFailureModeId: null, causalProcessId: null, responsibleEmployeeId: null,
};

/** API record → form values. */
export const toForm = (n) => ({
  title: n.title ?? "", severity: n.severity, description: n.description ?? "", requirement: n.requirement ?? "", actualResult: n.actualResult ?? "",
  siteId: n.site?.id ?? null, detectedAt: n.detectedAt, detectionProcessId: n.detectionProcess?.id ?? null,
  partId: n.part?.id ?? null, partRevisionId: n.partRevisionId ?? null, lotNumber: n.lotNumber ?? "", serialNumber: n.serialNumber ?? "",
  quantityAffected: n.quantityAffected ?? "", quantityInspected: n.quantityInspected ?? "",
  customerId: n.customer?.id ?? null, customerReference: n.customerReference ?? "", supplierId: n.supplier?.id ?? null,
  purchaseOrder: n.purchaseOrder ?? "", workOrder: n.workOrder ?? "",
  failureModeId: n.failureMode?.id ?? null, subFailureModeId: n.subFailureMode?.id ?? null, causalProcessId: n.causalProcess?.id ?? null,
  responsibleEmployeeId: n.responsibleEmployee?.id ?? null,
});

/** Form values → API body (empty strings → null, quantities → numbers). Only fields relevant to the source. */
export const toBody = (form, source) => {
  const body = { ...form, title: form.title.trim() };
  for (const k of ["quantityAffected", "quantityInspected"]) body[k] = form[k] === "" || form[k] === null ? null : Number(form[k]);
  for (const [k, v] of Object.entries(body)) if (typeof v === "string" && k !== "title" && k !== "detectedAt") body[k] = v.trim() === "" ? null : v.trim();
  if (source !== "customer") { delete body.customerId; delete body.customerReference; }
  if (source !== "supplier") { delete body.supplierId; delete body.purchaseOrder; }
  if (source === "supplier") delete body.workOrder;
  return body;
};

export const changedFields = (body, original) => Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(original[k] ?? null)));

