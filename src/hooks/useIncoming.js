import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "incoming", ...rest];
const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** Incoming inspection requirements (drafts and approved by default). */
export const useRequirements = (filters = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "requirements", filters),
    queryFn: () => apiFetch(`/inspection-requirements?${qs(filters)}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** What the approved requirements would decide for a supplier, part and quantity. Nothing is recorded. */
export const useIncomingPreview = ({ supplierId, partId, quantity, enabled = true }) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "preview", supplierId, partId, quantity),
    queryFn: () => apiFetch(`/incoming-inspection/preview?${qs({ supplierId, partId, quantity })}`, { organisationId }),
    enabled: !!organisationId && !!supplierId && Number(quantity) > 0 && enabled,
    retry: false,
  });
};

/** Received lines of a supplier to link a non-conformance to (searchable, newest first). */
export const useReceiptLineLookup = ({ supplierId, partId, q }, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "line-lookup", supplierId, partId, q),
    queryFn: () => apiFetch(`/goods-receipt-lines/lookup?${qs({ supplierId, partId, q })}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!supplierId && enabled,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

/** The goods receipt line(s) a non-conformance was raised from. */
export const useNcrReceiptSource = (ncrId, enabled = true) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "ncr-source", ncrId),
    queryFn: () => apiFetch(`/ncrs/${ncrId}/receipt-source`, { organisationId }),
    enabled: !!organisationId && !!ncrId && enabled,
    retry: false,
  });
};

/** Commands on requirements and on receipt lines. Everything is marked stale: lots, inspections, NCs and the receipt itself show what changed. */
export const useIncomingMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body: body ?? {}, organisationId });
      switch (action) {
        case "createRequirement":
          return send("/inspection-requirements");
        case "updateRequirement":
          return send(`/inspection-requirements/${id}`, "PATCH");
        case "approveRequirement":
          return send(`/inspection-requirements/${id}/approve`);
        case "retireRequirement":
          return send(`/inspection-requirements/${id}/retire`);
        case "startInspection":
          return send(`/goods-receipt-lines/${id}/start-inspection`);
        case "disposition":
          return send(`/goods-receipt-lines/${id}/disposition`);
        case "raiseNcr":
          return send(`/goods-receipt-lines/${id}/raise-ncr`);
        case "linkNcr":
          return send(`/ncrs/${id}/receipt-link`);
        case "unlinkNcr":
          return send(`/receipt-line-ncrs/${id}/unlink`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};
