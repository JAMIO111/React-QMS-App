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

export const useSupplierDocuments = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "documents", id),
    queryFn: () => apiFetch(`/supplier-quality/suppliers/${id}/documents`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

export const useSupplierCertifications = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "certifications", id),
    queryFn: () => apiFetch(`/supplier-quality/suppliers/${id}/certifications`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** Current certifications and documents that expired or expire within `days`, across suppliers. */
export const useExpiryWatchlist = ({ days = 60, kind = "" } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "watchlist", days, kind),
    queryFn: () => apiFetch(`/supplier-quality/expiry-watchlist?${qs({ days, kind })}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

/** Commands on certifications and documents; each answers with the record it changed. */
export const useQualificationMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "addDocument":
          return send(`/supplier-quality/suppliers/${id}/documents`);
        case "updateDocument":
          return send(`/supplier-quality/supplier-documents/${id}`, "PATCH");
        case "verifyDocument":
          return send(`/supplier-quality/supplier-documents/${id}/verify`);
        case "removeDocument":
          return send(`/supplier-quality/supplier-documents/${id}/remove`);
        case "addCertification":
          return send(`/supplier-quality/suppliers/${id}/certifications`);
        case "updateCertification":
          return send(`/supplier-quality/supplier-certifications/${id}`, "PATCH");
        case "renewCertification":
          return send(`/supplier-quality/supplier-certifications/${id}/renew`);
        case "verifyCertification":
          return send(`/supplier-quality/supplier-certifications/${id}/verify`);
        case "withdrawCertification":
          return send(`/supplier-quality/supplier-certifications/${id}/withdraw`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** The organisation's current risk model and its versions. */
export const useRiskModel = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "risk-model"),
    queryFn: () => apiFetch("/supplier-quality/risk-model", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

/** A supplier's risk assessments, the current one first. */
export const useRiskAssessments = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "risk-assessments", id),
    queryFn: () => apiFetch(`/supplier-quality/suppliers/${id}/risk-assessments`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** What a set of scores would give under the current model; nothing is saved, so nothing is refreshed. */
export const usePreviewRisk = () => {
  const { organisationId } = useOrganisation();
  return useMutation({ mutationFn: ({ id, scores }) => apiFetch(`/supplier-quality/suppliers/${id}/risk-assessments/preview`, { method: "POST", body: { scores }, organisationId }) });
};

/** Record an assessment (`record`) or save a new version of the model (`saveModel`). */
export const useRiskMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      if (action === "record") return apiFetch(`/supplier-quality/suppliers/${id}/risk-assessments`, { method: "POST", body, organisationId });
      if (action === "saveModel") return apiFetch("/supplier-quality/risk-model", { method: "PUT", body, organisationId });
      throw new Error(`Unknown action ${action}`);
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** The organisation's assessment templates, each with its current version. */
export const useAssessmentTemplates = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "assessment-templates"),
    queryFn: () => apiFetch("/supplier-quality/assessment-templates", { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};

export const useSupplierAssessments = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "assessments", id),
    queryFn: () => apiFetch(`/supplier-quality/suppliers/${id}/assessments`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** One assessment: its frozen questions, the answers so far and what is still needed. */
export const useSupplierAssessment = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "assessment", id),
    queryFn: () => apiFetch(`/supplier-quality/supplier-assessments/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

export const useApprovalDecisions = (id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "approval-decisions", id),
    queryFn: () => apiFetch(`/supplier-quality/suppliers/${id}/approval-decisions`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** Commands for templates, assessments and approval decisions; each answers with the record it changed. */
export const useAssessmentMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "createTemplate":
          return send("/supplier-quality/assessment-templates");
        case "updateTemplate":
          return send(`/supplier-quality/assessment-templates/${id}`, "PATCH");
        case "saveTemplateVersion":
          return send(`/supplier-quality/assessment-templates/${id}/versions`);
        case "startAssessment":
          return send(`/supplier-quality/suppliers/${id}/assessments`);
        case "respond":
          return send(`/supplier-quality/supplier-assessments/${id}/responses`, "PUT");
        case "completeAssessment":
          return send(`/supplier-quality/supplier-assessments/${id}/complete`);
        case "abandonAssessment":
          return send(`/supplier-quality/supplier-assessments/${id}/abandon`);
        case "propose":
          return send(`/supplier-quality/suppliers/${id}/approval-decisions`);
        case "decide":
          return send(`/supplier-quality/supplier-approval-decisions/${id}/decide`);
        case "withdraw":
          return send(`/supplier-quality/supplier-approval-decisions/${id}/withdraw`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    // A decision can change the supplier's status, which shows everywhere, so everything is marked stale.
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};

// ---- SCARs (supplier corrective action requests) ----------------------------------------------

/** Register page: { data, page, pageSize, total }. Filters: q, status (running | all | statuses), overdue, severity, supplierId, ncrId, sort, order, page, pageSize. */
export const useScars = (filters = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "scars", filters),
    queryFn: () => apiFetch(`/supplier-quality/scars?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    placeholderData: (previous) => previous,
  });
};

/** Active members, for choosing the internal owner of a SCAR. */
export const useScarPeople = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "scar-people"),
    queryFn: () => apiFetch(`/supplier-quality/scar-people`, { organisationId }).then((r) => r.data),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** One SCAR with its NC links, responses (each with our review), implementation, verification, extensions and history. */
export const useScar = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "scar", id),
    queryFn: () => apiFetch(`/supplier-quality/scars/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Commands on SCARs; each answers with the whole SCAR (the create too). Everything is marked stale: the register, supplier counts and NC cards all show them. */
export const useScarMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(`/supplier-quality${path}`, { method, body: body ?? {}, organisationId });
      switch (action) {
        case "create":
          return send("/scars");
        case "update":
          return send(`/scars/${id}`, "PATCH");
        case "issue":
          return send(`/scars/${id}/issue`);
        case "acknowledge":
          return send(`/scars/${id}/acknowledge`);
        case "respond":
          return send(`/scars/${id}/responses`);
        case "startReview":
          return send(`/scars/${id}/start-review`);
        case "review":
          return send(`/scars/${id}/review`);
        case "implement":
          return send(`/scars/${id}/implementations`);
        case "verify":
          return send(`/scars/${id}/verifications`);
        case "extend":
          return send(`/scars/${id}/extensions`);
        case "cancel":
          return send(`/scars/${id}/cancel`);
        case "linkNcr":
          return send(`/scars/${id}/ncrs`);
        case "unlinkNcr":
          return send(`/scar-ncrs/${id}/unlink`);
        case "addItem":
          return send(`/scars/${id}/items`);
        case "removeItem":
          return send(`/scar-items/${id}/remove`);
        case "decideExtension":
          return send(`/scar-extensions/${id}/decide`);
        case "withdrawExtension":
          return send(`/scar-extensions/${id}/withdraw`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    onSuccess: () => refreshOrganisation(queryClient, organisationId),
  });
};
