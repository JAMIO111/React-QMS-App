import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
export const CHANGE_GUESSED = new Set(["update", "setLinks", "updateType", "updateFunction", "updateArea"]);

/** Cached change data as it will be after a command (`show.links`: the links with their labels, for `setLinks`). */
export const guessChange = (data, { action, id, body = {}, show = {} }) => {
  switch (action) {
    case "update":
    case "updateType":
    case "updateFunction":
    case "updateArea":
      return updateById(data, id, (x) => setFields(x, body));
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
