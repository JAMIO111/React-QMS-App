import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useAuth } from "../contexts/AuthProvider";

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
export const usePlatformWebhooks = (hours = 24) => useMonitor(["webhooks", hours], `/platform/webhooks?hours=${hours}`, { refetch: 30_000 });
export const usePlatformActivity = (limit = 100) => useMonitor(["activity", limit], `/platform/activity?limit=${limit}`);
