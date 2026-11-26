import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { useToast } from "../contexts/ToastProvider";
import { guessed } from "../lib/supplierQualityGuesses";
import { SHIPPING_OPTIMISTIC, guessShipping } from "../lib/shippingGuesses";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "shipping", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** Customer order register page: { data, page, pageSize, total }. */
export const useCustomerOrders = (filters = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "orders", filters),
    queryFn: () => apiFetch(`/customer-orders?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

/** One order with each line's shipped / outstanding / over / late and its shipments. */
export const useCustomerOrder = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "order", id),
    queryFn: () => apiFetch(`/customer-orders/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Open orders for a picker. */
export const useOrderLookup = ({ customerId, enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "order-lookup", customerId),
    queryFn: () => apiFetch(`/customer-orders/lookup?${qs({ customerId })}`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && !!customerId && enabled,
    retry: false,
  });
};

export const useShipments = (filters = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "shipments", filters),
    queryFn: () => apiFetch(`/shipments?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

export const useShipment = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "shipment", id),
    queryFn: () => apiFetch(`/shipments/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/**
 * Commands on orders and shipments; each answers with the record it changed. Everything is marked stale: lots, traceability and customer figures show shipments too.
 * Closing or cancelling an order, an agreed date and cancelling a shipment show at once (`SHIPPING_OPTIMISTIC`; a refusal is put back with a toast).
 */
export const useShippingMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    ...guessed(queryClient, organisationId, toast, SHIPPING_OPTIMISTIC, guessShipping),
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body: body ?? {}, organisationId });
      switch (action) {
        case "createOrder":
          return send("/customer-orders");
        case "closeOrder":
          return send(`/customer-orders/${id}/close`);
        case "cancelOrder":
          return send(`/customer-orders/${id}/cancel`);
        case "agreedDate":
          return send(`/customer-order-lines/${id}`, "PATCH");
        case "recordShipment":
          return send("/shipments");
        case "cancelShipment":
          return send(`/shipments/${id}/cancel`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
  });
};
