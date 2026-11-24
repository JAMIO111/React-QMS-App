import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DASHBOARD_STALE_MS } from "@/lib/dashboardPeriod";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { useToast } from "../contexts/ToastProvider";
import { updateById } from "../lib/optimistic";
import { commandGuessHandlers, setFields } from "../lib/guessCommands";

/** Change management (docs/change-management-plan.md): the lists, changes and their scope and files. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "change", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

const useList = (path, name, { all = false } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, name, all),
    queryFn: () => apiFetch(`${path}?${qs({ all: all ? "true" : "" })}`, { organisationId }),
    enabled: !!organisationId,
    retry: false,
  });
};
export const useChangeTypes = (opts) => useList("/change-types", "types", opts);
export const useChangeFunctions = (opts) => useList("/change-functions", "functions", opts);
export const useChangeAreas = (opts) => useList("/change-areas", "areas", opts);

/** Members who could be put on a board, and whether each can sign. */
export const useChangeSigners = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "signers"),
    queryFn: () => apiFetch("/change-signers", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    retry: false,
    select: (r) => r.data,
  });
};

/** The register: filters and paging are the server's. */
export const useChanges = (params) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/changes?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

export const useChange = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "change", id),
    queryFn: () => apiFetch(`/changes/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** What is waiting for the caller: sign-offs, open tasks, and the changes they raised that are still going. */
/** The changes that name one record (raised from it, covering it, or with a task on it), and whether the caller may raise one from it. */
export const useLinkedChanges = (kind, id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "linked", kind, id),
    queryFn: () => apiFetch(`/changes/linked?${qs({ kind, id })}`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
  });
};

/** What a change raised from a record starts with (nothing saved). */
export const useChangeDraft = (kind, id, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "draft", kind, id),
    queryFn: () => apiFetch(`/change-draft?${qs({ kind, id })}`, { organisationId }),
    enabled: !!organisationId && !!id && enabled,
    retry: false,
    staleTime: 0,
  });
};

export const useMyChanges = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "mine"),
    queryFn: () => apiFetch("/changes/mine", { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

/** The menu badge (sign-offs waiting plus open tasks), polled every five minutes like the other badges. */
export const useMyChangeCount = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "mine-count"),
    queryFn: () => apiFetch("/changes/mine/count", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
};

/** The files on a change, removed ones included (the page folds them away). */
export const useChangeAttachments = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "attachments", id),
    queryFn: () => apiFetch(`/changes/${id}/attachments?deleted=include`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
    select: (r) => r.data,
  });
};

/** Remove or restore a file: mutate({ path: "/change-attachments/<id>/delete", body }). Refreshes the organisation's data afterwards. */
export const useChangeAttachmentMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** The change commands shown before the server answers; the others wait (raising a change, cancelling: the database decides). */
export const CHANGE_GUESSED = new Set(["update", "setLinks", "setImpact", "updateType", "updateFunction", "updateArea"]);

/** Cached change data as it will be after a command (`show.links`: the links with their labels, for `setLinks`). */
export const guessChange = (data, { action, id, body = {}, show = {} }) => {
  switch (action) {
    case "update":
    case "updateType":
    case "updateFunction":
    case "updateArea":
      return updateById(data, id, (x) => setFields(x, body));
    case "setImpact":
      return updateById(data, id, (c) =>
        Array.isArray(c.impacts)
          ? { ...c, impacts: c.impacts.map((i) => (i.areaId === body.areaId ? { ...i, status: body.status, note: body.status === "not_assessed" ? null : body.note ?? null, assessedBy: show.me ?? i.assessedBy } : i)) }
          : c,
      );
    case "setLinks":
      return show.links ? updateById(data, id, (c) => ("links" in c ? { ...c, links: show.links, linkCount: show.links.length } : c)) : data;
    default:
      return data;
  }
};

/** One command at a time: { action, id, body }. Every one refreshes the organisation's cached data. */
export const useChangeMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "create":
          return send("/changes");
        case "update":
          return send(`/changes/${id}`, "PATCH");
        case "setLinks":
          return send(`/changes/${id}/links`, "PUT");
        case "cancel":
          return send(`/changes/${id}/cancel`);
        case "submit":
          return send(`/changes/${id}/submit`);
        case "setImpact":
          return send(`/changes/${id}/impacts`, "PUT");
        case "setBoard":
          return send(`/changes/${id}/board`, "PUT");
        case "sendToBoard":
          return send(`/changes/${id}/send-to-board`);
        case "recall":
          return send(`/changes/${id}/recall`);
        case "decide":
          return send(`/change-signoffs/${id}/decide`);
        case "setCutIn":
          return send(`/changes/${id}/cut-in`, "PUT");
        case "setCustomerApproval":
          return send(`/changes/${id}/customer-approval`, "PUT");
        case "addTask":
          return send(`/changes/${id}/tasks`);
        case "updateTask":
          return send(`/change-tasks/${id}`, "PATCH");
        case "linkTask":
          return send(`/change-tasks/${id}/link`, "PUT");
        case "completeTask":
          return send(`/change-tasks/${id}/complete`);
        case "cancelTask":
          return send(`/change-tasks/${id}/cancel`);
        case "reopenTask":
          return send(`/change-tasks/${id}/reopen`);
        case "startRevision":
          return send(`/change-tasks/${id}/start-revision`);
        case "review":
          return send(`/changes/${id}/reviews`);
        case "createType":
          return send("/change-types");
        case "updateType":
          return send(`/change-types/${id}`, "PATCH");
        case "createFunction":
          return send("/change-functions");
        case "updateFunction":
          return send(`/change-functions/${id}`, "PATCH");
        case "updateArea":
          return send(`/change-areas/${id}`, "PATCH");
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    // The guessed commands show at once; a refusal puts the change back and says why in a toast.
    ...commandGuessHandlers({ queryClient, prefix: key(organisationId), guess: guessChange, guessed: CHANGE_GUESSED, showToast: toast?.showToast }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** The changes dashboard for a period (`period` from useDashboardPeriod): what is open, waiting and late as of today, and what moved in the period. */
export const useChangeDashboard = (period) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "dashboard", period?.fromIso, period?.toIso),
    queryFn: () => apiFetch(`/changes-dashboard?${qs({ from: period.fromIso, to: period.toIso })}`, { organisationId }),
    staleTime: DASHBOARD_STALE_MS,
    enabled: !!organisationId && !!period?.fromIso,
    placeholderData: keepPreviousData,
    retry: false,
  });
};
