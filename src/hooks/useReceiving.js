import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "receiving", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** Purchase order register page: { data, page, pageSize, total }. */
export const usePurchaseOrders = (filters = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "orders", filters),
    queryFn: () => apiFetch(`/purchase-orders?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

/** One order with each line's received / outstanding / late and its receipts. */
export const usePurchaseOrder = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "order", id),
    queryFn: () => apiFetch(`/purchase-orders/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Open orders for a picker. */
export const usePoLookup = ({ supplierId, enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "po-lookup", supplierId),
    queryFn: () => apiFetch(`/purchase-orders/lookup?${qs({ supplierId })}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!supplierId && enabled,
    retry: false,
  });
};

export const useReceipts = (filters = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "receipts", filters),
    queryFn: () => apiFetch(`/goods-receipts?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

export const useReceipt = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "receipt", id),
    queryFn: () => apiFetch(`/goods-receipts/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Commands on orders and receipts; each answers with the record it changed. Everything is marked stale: lots, traceability and supplier counts show receipts too. */
export const useReceivingMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body: body ?? {}, organisationId });
      switch (action) {
        case "createOrder":
          return send("/purchase-orders");
        case "closeOrder":
          return send(`/purchase-orders/${id}/close`);
        case "cancelOrder":
          return send(`/purchase-orders/${id}/cancel`);
        case "agreedDate":
          return send(`/purchase-order-lines/${id}`, "PATCH");
        case "recordReceipt":
          return send("/goods-receipts");
        case "cancelReceipt":
          return send(`/goods-receipts/${id}/cancel`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};
