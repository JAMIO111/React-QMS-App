import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** Supplier quality (docs/supplier-quality-plan.md): the register, a supplier's profile and history, classifications, and the commands. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "supplier-quality", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

export const useSupplierRegister = (filters = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", filters),
    queryFn: () => apiFetch(`/supplier-quality/suppliers?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

export const useSupplier = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "detail", id),
    queryFn: () => apiFetch(`/supplier-quality/suppliers/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

export const useSupplierHistory = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "history", id),
    queryFn: () => apiFetch(`/supplier-quality/suppliers/${id}/history`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** Classifications: the active ones for pickers and filters, or `all` for the settings page. */
export const useSupplierClassifications = ({ all = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "classifications", all),
    queryFn: () => apiFetch(`/supplier-quality/classifications?${qs({ all: all ? "true" : "" })}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

export const useSupplierMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "create":
          return send("/supplier-quality/suppliers");
        case "update":
          return send(`/supplier-quality/suppliers/${id}`, "PATCH");
        case "status":
          return send(`/supplier-quality/suppliers/${id}/status`);
        case "classifications":
          return send(`/supplier-quality/suppliers/${id}/classifications`, "PUT");
        case "addContact":
          return send(`/supplier-quality/suppliers/${id}/contacts`);
        case "updateContact":
          return send(`/supplier-quality/supplier-contacts/${id}`, "PATCH");
        case "addProduct":
          return send(`/supplier-quality/suppliers/${id}/products`);
        case "updateProduct":
          return send(`/supplier-quality/supplier-products/${id}`, "PATCH");
        case "createClassification":
          return send("/supplier-quality/classifications");
        case "updateClassification":
          return send(`/supplier-quality/classifications/${id}`, "PATCH");
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: (data) => {
      // Commands on a supplier answer with the whole profile.
      if (data?.id && data?.counts) queryClient.setQueryData(key(organisationId, "detail", data.id), data);
      refreshOrganisation(queryClient, organisationId);
    },
  });
};
