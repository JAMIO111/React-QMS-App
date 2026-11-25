import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { useToast } from "../contexts/ToastProvider";
import { updateById } from "../lib/optimistic";
import { commandGuessHandlers, setFields } from "../lib/guessCommands";

/** FMEA (docs/fmea-plan.md): the register, an FMEA with its revisions, a revision with its team and scope. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "fmea", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

/** The register: filters and paging are the server's. */
export const useFmeas = (params) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", params),
    queryFn: () => apiFetch(`/fmeas?${qs(params)}`, { organisationId }),
    enabled: !!organisationId,
    placeholderData: keepPreviousData,
    retry: false,
  });
};

/** FMEAs that cover one thing (a part, family, control plan or machine): for the cards and banners on those pages. */
export const useFmeasCovering = (params, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "covering", params),
    queryFn: () => apiFetch(`/fmeas?${qs({ ...params, status: "draft,active", pageSize: 50 })}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

export const useFmea = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "fmea", id),
    queryFn: () => apiFetch(`/fmeas/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

export const useFmeaRevision = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "revision", id),
    queryFn: () => apiFetch(`/fmea-revisions/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** Members who may be named on a team or as approver, and whether each can approve. */
export const useFmeaPeople = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "people"),
    queryFn: () => apiFetch("/fmea-people", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    retry: false,
    select: (r) => r.data,
  });
};

/** The commands shown before the server answers; the others wait (starting, submitting, approving: the database decides). */
export const FMEA_GUESSED = new Set(["update", "updateRevision", "setLinks", "setTeam", "setApprover"]);

/** Cached FMEA data as it will be after a command (`show`: the links, team or approver with their labels, for the commands that replace them). */
export const guessFmea = (data, { action, id, body = {}, show = {} }) => {
  switch (action) {
    case "update":
    case "updateRevision":
      return updateById(data, id, (x) => setFields(x, body));
    case "setLinks":
      return show.links ? updateById(data, id, (r) => ("links" in r ? { ...r, links: show.links } : r)) : data;
    case "setTeam":
      return show.team ? updateById(data, id, (r) => ("team" in r ? { ...r, team: show.team } : r)) : data;
    case "setApprover":
      return updateById(data, id, (r) => ("approver" in r ? { ...r, approver: show.approver ?? null } : r));
    default:
      return data;
  }
};

/** One command at a time: { action, id, body, show }. Every one refreshes the organisation's cached data. */
export const useFmeaMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const send = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "create":
          return send("/fmeas");
        case "update":
          return send(`/fmeas/${id}`, "PATCH");
        case "startRevision":
          return send(`/fmeas/${id}/revisions`);
        case "withdraw":
          return send(`/fmeas/${id}/withdraw`);
        case "updateRevision":
          return send(`/fmea-revisions/${id}`, "PATCH");
        case "setTeam":
          return send(`/fmea-revisions/${id}/team`, "PUT");
        case "setLinks":
          return send(`/fmea-revisions/${id}/links`, "PUT");
        case "setApprover":
          return send(`/fmea-revisions/${id}/approver`, "PUT");
        case "submit":
          return send(`/fmea-revisions/${id}/submit`);
        case "approve":
          return send(`/fmea-revisions/${id}/approve`);
        case "sendBack":
          return send(`/fmea-revisions/${id}/send-back`);
        case "recall":
          return send(`/fmea-revisions/${id}/recall`);
        case "discard":
          return send(`/fmea-revisions/${id}/discard`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    // The guessed commands show at once; a refusal puts the record back and says why in a toast.
    ...commandGuessHandlers({ queryClient, prefix: key(organisationId), guess: guessFmea, guessed: FMEA_GUESSED, showToast: toast?.showToast }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};
