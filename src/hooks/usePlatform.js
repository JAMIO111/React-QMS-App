import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useAuth } from "../contexts/AuthProvider";
import { guessCache, rollbackGuess, updateById } from "../lib/optimistic";

/** The operator area: does this signed-in person have access? ({ status: "none" | "needs_mfa" | "ok" }) */
export const usePlatformMe = () => {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["api", "platform", "me", user?.id],
    queryFn: () => apiFetch("/platform/me"),
    enabled: !!user,
    staleTime: 60_000,
    retry: false,
  });
};

/** The sign-up funnel for the last `days` days and the latest sign-ups. Not organisation-scoped. */
export const usePlatformOverview = (days = 30, { enabled = true } = {}) =>
  useQuery({
    queryKey: ["api", "platform", "overview", days],
    queryFn: () => apiFetch(`/platform/overview?days=${days}`),
    enabled,
    retry: false,
    refetchInterval: 60_000,
  });

const useMonitor = (key, path, { refetch = 60_000 } = {}) =>
  useQuery({ queryKey: ["api", "platform", ...key], queryFn: () => apiFetch(path), retry: false, refetchInterval: refetch });

/** Every organisation with its billing state (search by name or owner email, paged). Counts and billing only: no business data. */
export const usePlatformOrganisations = ({ search = "", limit = 25, offset = 0 } = {}) => {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (search.trim()) params.set("search", search.trim());
  return useMonitor(["organisations", search.trim(), limit, offset], `/platform/organisations?${params}`, { refetch: false });
};
export const usePlatformRevenue = () => useMonitor(["revenue"], "/platform/revenue");
export const usePlatformPayments = (limit = 50) => useMonitor(["payments", limit], `/platform/payments?limit=${limit}`);
export const usePlatformEmail = (hours = 24) => useMonitor(["email", hours], `/platform/email?hours=${hours}`, { refetch: 30_000 });
export const usePlatformWorker = () => useMonitor(["worker"], "/platform/worker", { refetch: 30_000 });
export const usePlatformWebhooks = (hours = 24) => useMonitor(["webhooks", hours], `/platform/webhooks?hours=${hours}`, { refetch: 30_000 });
export const usePlatformActivity = (limit = 100) => useMonitor(["activity", limit], `/platform/activity?limit=${limit}`);

/**
 * Recover access for an organisation whose network restrictions lock everyone out (security plan SE5): back to monitor, never off, with a reason and
 * how ownership was verified. Owners and admins are told by the database. The operator's organisations list is read again.
 */
export const useRecoverNetworkPolicy = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ organisationId, reason, verification }) =>
      apiFetch(`/platform/organisations/${organisationId}/recover-network-policy`, { method: "POST", body: { reason, verification } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["api", "platform", "organisations"] }),
  });
};

/**
 * Make single sign-on optional again for an organisation whose company sign-in fails and nobody can get in (sso plan SS8): never off, the provider
 * is kept, with a reason and how ownership was verified. Owners and admins are told by the database.
 */
export const useRecoverSso = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ organisationId, reason, verification }) =>
      apiFetch(`/platform/organisations/${organisationId}/recover-sso`, { method: "POST", body: { reason, verification } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["api", "platform", "organisations"] }),
  });
};

/** Organisations paying by invoice (docs/invoice-billing-plan.md IV3): whether the first invoice is paid, what is open and how late, and the two operator switches. */
export const usePlatformInvoiceAccounts = () => useMonitor(["invoice-accounts"], "/platform/invoice-accounts", { refetch: 60_000 });

/**
 * Allow or refuse invoicing for one organisation, or lift the one-invoiced-organisation-per-company block (each with a reason). The account shows the change
 * at once and goes back if the server refuses.
 */
export const useInvoiceAccountMutation = () => {
  const queryClient = useQueryClient();
  const listKey = ["api", "platform", "invoice-accounts"];
  return useMutation({
    mutationFn: ({ organisationId, action, value, reason }) =>
      apiFetch(`/platform/organisations/${organisationId}/${action === "billing" ? "invoice-billing" : "invoice-company-exempt"}`, {
        method: "POST",
        body: action === "billing" ? { allowed: value, reason } : { exempt: value, reason },
      }),
    onMutate: async ({ organisationId, action, value }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData(listKey);
      queryClient.setQueryData(listKey, (data) =>
        data ? { ...data, data: data.data.map((a) => (a.organisationId === organisationId ? { ...a, [action === "billing" ? "billingAllowed" : "companyExempt"]: value } : a)) } : data,
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => queryClient.setQueryData(listKey, ctx?.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
  });
};

/** Connector agent releases (AG6b): every one including withdrawn, how many agents run each, and whether the API has release keys to check them. */
export const usePlatformAgentReleases = () => useMonitor(["agent-releases"], "/platform/agent-releases", { refetch: false });

/**
 * Publish a signed release (the manifest text and its signature, from connector-agent/release/sign-release.mjs) or withdraw one with a reason.
 * Withdrawing shows at once (and goes back if refused); publishing waits for the server, which checks the signature.
 */
export const useAgentReleaseMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: ({ action, id, body }) =>
      action === "withdraw"
        ? guessCache(queryClient, ["api", "platform", "agent-releases"], (data) =>
            updateById(data, id, (r) => ({ ...r, status: "withdrawn", withdrawnReason: body?.reason ?? null, withdrawnAt: new Date().toISOString() })),
          )
        : { optimistic: false, snapshot: [] },
    onError: (_error, _vars, context) => rollbackGuess(queryClient, context),
    mutationFn: ({ action, id, body }) =>
      action === "withdraw"
        ? apiFetch(`/platform/agent-releases/${id}/withdraw`, { method: "POST", body })
        : apiFetch("/platform/agent-releases", { method: "POST", body }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["api", "platform", "agent-releases"] }),
  });
};
