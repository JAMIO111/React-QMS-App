import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { useToast } from "../contexts/ToastProvider";
import { pendingId, updateById } from "../lib/optimistic";
import { commandGuessHandlers, nowIso, setFields } from "../lib/guessCommands";

/** CAPA / 8D (docs/capa-8d-plan.md): the register, one 8D with its steps, team and NC links, and the commands. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "capa", ...rest];

const qs = (params) => {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && p.set(k, v));
  return p.toString();
};

export const useCapas = (filters = {}, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "list", filters),
    queryFn: () => apiFetch(`/capas?${qs(filters)}`, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
  });
};

export const useCapa = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "detail", id),
    queryFn: () => apiFetch(`/capas/${id}`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
  });
};

/** The signed-in person's own actions across running 8Ds ({ data, openCount }); status open | done | all. */
export const useMyCapaActions = (status = "open", { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "my-actions", status),
    queryFn: () => apiFetch(`/capa-actions/mine?status=${status}`, { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
};

/** Evidence files on an 8D (removed ones included, so they can be restored). */
export const useCapaAttachments = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "attachments", id),
    queryFn: () => apiFetch(`/capas/${id}/attachments?deleted=include`, { organisationId }),
    enabled: !!organisationId && !!id,
    retry: false,
    select: (r) => r.data,
  });
};

/** Remove or restore a file: mutate({ path: "/capa-attachments/<id>/delete", body }). Refreshes the organisation's data afterwards. */
export const useCapaAttachmentMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = "POST", body }) => apiFetch(path, { method, body, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Active members for the team and owner pickers (needs capa.manage). */
export const useCapaPeople = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "people"),
    queryFn: () => apiFetch("/capas/people", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    retry: false,
    select: (r) => r.data,
  });
};

/** The 8Ds a non-conformance is linked to. */
export const useNcrCapas = (ncrId, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "ncr", ncrId),
    queryFn: () => apiFetch(`/ncrs/${ncrId}/capas`, { organisationId }),
    enabled: !!organisationId && !!ncrId && enabled,
    retry: false,
    select: (r) => r.data,
  });
};

/**
 * action: create | update | completeStep | reopenStep | cancel | reopen | addTeam | updateTeam | linkNcr | unlinkNcr | addAnalysis | updateAnalysis |
 * removeAnalysis | addRootCause | updateRootCause | removeRootCause | close | addVerification | addAction | updateAction | completeAction | cancelAction | reopenAction.
 * Every command answers with the 8D, which is put in the cache; then everything in the organisation is refreshed (lib/refresh.js).
 * `id` is the 8D, except for updateTeam (the team member), unlinkNcr (the link), updateAnalysis and removeAnalysis (the analysis) and the action
 * commands that work on one action (updateAction, completeAction, cancelAction, reopenAction) and the root cause commands that work on one cause.
 */
export const useCapaMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ action, id, body }) => {
      const post = (path, method = "POST") => apiFetch(path, { method, body, organisationId });
      switch (action) {
        case "create":
          return post("/capas");
        case "update":
          return post(`/capas/${id}`, "PATCH");
        case "completeStep":
          return post(`/capas/${id}/complete-step`);
        case "reopenStep":
          return post(`/capas/${id}/reopen-step`);
        case "cancel":
          return post(`/capas/${id}/cancel`);
        case "reopen":
          return post(`/capas/${id}/reopen`);
        case "addTeam":
          return post(`/capas/${id}/team`);
        case "updateTeam":
          return post(`/capa-team/${id}`, "PATCH");
        case "linkNcr":
          return post(`/capas/${id}/ncrs`);
        case "unlinkNcr":
          return post(`/capa-ncr-links/${id}/unlink`);
        case "addAnalysis":
          return post(`/capas/${id}/analyses`);
        case "updateAnalysis":
          return post(`/capa-analyses/${id}`, "PATCH");
        case "removeAnalysis":
          return post(`/capa-analyses/${id}`, "DELETE");
        case "addRootCause":
          return post(`/capas/${id}/root-causes`);
        case "updateRootCause":
          return post(`/capa-root-causes/${id}`, "PATCH");
        case "removeRootCause":
          return post(`/capa-root-causes/${id}`, "DELETE");
        case "close":
          return post(`/capas/${id}/close`);
        case "addVerification":
          return post(`/capas/${id}/verifications`);
        case "addAction":
          return post(`/capas/${id}/actions`);
        case "updateAction":
          return post(`/capa-actions/${id}`, "PATCH");
        case "completeAction":
          return post(`/capa-actions/${id}/complete`);
        case "cancelAction":
          return post(`/capa-actions/${id}/cancel`);
        case "reopenAction":
          return post(`/capa-actions/${id}/reopen`);
        default:
          throw new Error(`Unknown action ${action}`);
      }
    },
    // The guessed commands (CAPA_GUESSED) show at once; a refusal puts the 8D back and says why in a toast.
    ...commandGuessHandlers({ queryClient, prefix: key(organisationId), guess: guessCapa, guessed: CAPA_GUESSED, showToast: toast?.showToast }),
    onSuccess: (data) => {
      if (data?.id && data?.steps) queryClient.setQueryData(key(organisationId, "detail", data.id), data);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** The commands shown before the server answers (see guessCapa). The rest wait: their outcome is worked out by the database (steps, stage, closing, verification). */
export const CAPA_GUESSED = new Set([
  "update", "updateTeam", "addTeam", "unlinkNcr", "updateAnalysis", "removeAnalysis", "updateRootCause", "removeRootCause",
  "addAction", "updateAction", "completeAction", "cancelAction", "reopenAction",
]);

/** The 8D header fields of the 5W2H, sent as d2What … and shown under `problem`. */
const problemKey = (k) => (/^d2[A-Z]/.test(k) ? k[2].toLowerCase() + k.slice(3) : null);

/**
 * Cached 8D data as it will be after a command (`useCapaMutation` vars, plus `show` for names the server only gets ids of: `ownerName`, `name`).
 * Unknown commands leave it alone; the server's answer replaces the guess.
 */
export const guessCapa = (data, { action, id, body = {}, show = {} }) => {
  const now = nowIso();
  switch (action) {
    case "update":
      return updateById(data, id, (capa) => {
        let next = setFields(capa, body);
        const problem = Object.fromEntries(Object.entries(body).map(([k, v]) => [problemKey(k), v]).filter(([k]) => k));
        if (next.problem && Object.keys(problem).length) next = { ...next, problem: { ...next.problem, ...problem } };
        if ("ownerMembershipId" in body && capa.owner && typeof capa.owner === "object") {
          next = { ...next, owner: body.ownerMembershipId ? { ...capa.owner, membershipId: body.ownerMembershipId, name: show.ownerName ?? capa.owner.name } : null };
        }
        return next;
      });
    case "updateTeam":
      return updateById(data, id, (t) => (body.ended ? { ...t, endedAt: now } : setFields(t, body)));
    case "addTeam":
      return updateById(data, id, (capa) => {
        if (!Array.isArray(capa.team)) return capa;
        const external = !body.membershipId;
        const member = {
          id: pendingId(), membershipId: body.membershipId ?? null, userId: null, name: show.name ?? body.externalName ?? "…", company: body.externalCompany ?? null,
          email: body.externalEmail ?? null, role: body.role ?? "member", external, endedAt: null,
        };
        return { ...capa, team: [...capa.team, member] };
      });
    case "unlinkNcr": {
      // On the 8D the link is ended (kept in the history); on the NC page's list the 8D goes.
      const ended = updateById(data, id, (link) => ("endedAt" in link ? { ...link, endedAt: now, endReason: body.reason ?? null } : link));
      return Array.isArray(ended) ? ended.filter((row) => row?.linkId !== id) : ended?.data && Array.isArray(ended.data) ? { ...ended, data: ended.data.filter((row) => row?.linkId !== id) } : ended;
    }
    case "updateAnalysis":
      return updateById(data, id, (a) => setFields(a, body));
    case "removeAnalysis":
    case "removeRootCause":
      return updateById(data, id, (x) => x, { remove: true });
    case "updateRootCause":
      return updateById(data, id, (c) => {
        const next = setFields(c, body);
        if (body.verified === true && !c.verified) return { ...next, verifiedAt: now };
        if (body.verified === false) return { ...next, verifiedAt: null, verifiedBy: null };
        return next;
      });
    case "addAction":
      return updateById(data, id, (capa) => {
        if (!Array.isArray(capa.actions)) return capa;
        const action = {
          id: pendingId(), phase: body.phase, description: body.description ?? "", status: "open", rootCauseId: body.rootCauseId ?? null, dueDate: body.dueDate ?? null,
          owner: body.ownerTeamMemberId ? { teamMemberId: body.ownerTeamMemberId, name: show.ownerName ?? "…" } : null,
          evidenceNote: null, cancelReason: null, doneAt: null, doneBy: null, isAssignee: false, overdue: false,
        };
        return { ...capa, actions: [...capa.actions, action] };
      });
    case "updateAction":
      return updateById(data, id, (a) => {
        const next = setFields(a, body);
        if (!("ownerTeamMemberId" in body)) return next;
        return { ...next, owner: body.ownerTeamMemberId ? { ...(a.owner ?? {}), teamMemberId: body.ownerTeamMemberId, name: show.ownerName ?? a.owner?.name ?? "…" } : null };
      });
    case "completeAction":
      return updateById(data, id, (a) => ({ ...a, status: "done", evidenceNote: body.evidenceNote ?? a.evidenceNote ?? null, doneAt: now, overdue: false }));
    case "cancelAction":
      return updateById(data, id, (a) => ({ ...a, status: "cancelled", cancelReason: body.reason ?? null, overdue: false }));
    case "reopenAction":
      return updateById(data, id, (a) => ({ ...a, status: "open", doneAt: null, doneBy: null, cancelReason: null }));
    default:
      return data;
  }
};
