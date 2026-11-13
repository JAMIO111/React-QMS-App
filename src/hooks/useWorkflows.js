import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

/** Workflow rules (WF1): the tasks rules gave the signed-in person. Any member may hold one, so these need no workflow permission. */
const key = (organisationId, ...rest) => ["api", "org", organisationId, "workflows", ...rest];

export const useMyTasks = (status = "open", { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "my-tasks", status),
    queryFn: () => apiFetch(`/workflow-tasks/mine?status=${status}`, { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
};

const TASK_COMMANDS = {
  complete: ({ id, body }) => [`/workflow-tasks/${id}/complete`, "POST", body ?? {}],
  reopen: ({ id }) => [`/workflow-tasks/${id}/reopen`, "POST", {}],
  cancel: ({ id, body }) => [`/workflow-tasks/${id}/cancel`, "POST", body],
};

/**
 * Closes, reopens or cancels a task. The task leaves (or joins) the open list at once and comes back if the server refuses;
 * the organisation is refreshed afterwards, so the menu badge and the home page follow.
 */
export const useTaskMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const listKey = key(organisationId, "my-tasks");
  return useMutation({
    mutationFn: (command) => {
      const make = TASK_COMMANDS[command.action];
      if (!make) throw new Error(`Unknown action ${command.action}`);
      const [path, method, body] = make(command);
      return apiFetch(path, { method, body, organisationId });
    },
    onMutate: async (command) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueriesData({ queryKey: listKey });
      const status = command.action === "complete" ? "done" : command.action === "cancel" ? "cancelled" : "open";
      for (const [k, data] of previous) {
        if (!data?.data) continue;
        const was = data.data.find((t) => t.id === command.id);
        if (!was) continue;
        const shown = k[k.length - 1];
        const rows = shown === "all" || shown === status ? data.data.map((t) => (t.id === command.id ? { ...t, status, overdue: status === "open" && t.overdue } : t)) : data.data.filter((t) => t.id !== command.id);
        const delta = was.status === "open" && status !== "open" ? -1 : was.status !== "open" && status === "open" ? 1 : 0;
        queryClient.setQueryData(k, { ...data, data: rows, openCount: Math.max(0, (data.openCount ?? 0) + delta) });
      }
      return { previous };
    },
    onError: (_err, _command, context) => {
      for (const [k, data] of context?.previous ?? []) queryClient.setQueryData(k, data);
    },
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/* ---------------- Rules (WF2): workflows.read to read, workflows.manage to write and test ---------------- */

export const useWorkflowTriggers = ({ enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "triggers"),
    queryFn: () => apiFetch("/workflow-triggers", { organisationId }),
    enabled: !!organisationId && enabled,
    staleTime: 10 * 60_000,
    retry: false,
    select: (r) => r.data,
  });
};

export const useWorkflowRules = () => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "rules"),
    queryFn: () => apiFetch("/workflow-rules", { organisationId }),
    enabled: !!organisationId,
    retry: false,
    select: (r) => r.data,
  });
};

export const useWorkflowRule = (id) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "rule", id),
    queryFn: () => apiFetch(`/workflow-rules/${id}`, { organisationId }),
    enabled: !!organisationId && !!id && id !== "new",
    retry: false,
  });
};

const RULE_COMMANDS = {
  create: ({ body }) => ["/workflow-rules", "POST", body],
  update: ({ id, body }) => [`/workflow-rules/${id}`, "PATCH", body],
  status: ({ id, body }) => [`/workflow-rules/${id}/status`, "POST", body],
};

/** Writes a rule (create, update, status). Every command answers with the whole rule, which replaces the cached one. */
export const useWorkflowRuleMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command) => {
      const make = RULE_COMMANDS[command.action];
      if (!make) throw new Error(`Unknown action ${command.action}`);
      const [path, method, body] = make(command);
      return apiFetch(path, { method, body, organisationId });
    },
    onSuccess: (rule) => {
      if (rule?.id) queryClient.setQueryData(key(organisationId, "rule", rule.id), rule);
      return refreshOrganisation(queryClient, organisationId);
    },
  });
};

/** The latest events a rule with this trigger could have run on (for testing). */
export const useWorkflowTestEvents = (trigger, { enabled = true } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, "test-events", trigger),
    queryFn: () => apiFetch(`/workflow-test-events?trigger=${encodeURIComponent(trigger)}`, { organisationId }),
    enabled: !!organisationId && !!trigger && enabled,
    retry: false,
    select: (r) => r.data,
  });
};

/** A dry run of the rule as written against one event: nothing is saved or sent, so nothing needs refreshing. */
export const useTestWorkflowRule = () => {
  const { organisationId } = useOrganisation();
  return useMutation({ mutationFn: (body) => apiFetch("/workflow-tests", { method: "POST", body, organisationId }) });
};
