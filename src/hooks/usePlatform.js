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
