import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";

const key = (organisationId, ...rest) => ["api", "org", organisationId, "subscription", ...rest];

const useOrgQuery = (parts, path, { enabled = true, select, staleTime } = {}) => {
  const { organisationId } = useOrganisation();
  return useQuery({
    queryKey: key(organisationId, ...parts),
    queryFn: () => apiFetch(path, { organisationId }),
    enabled: !!organisationId && enabled,
    retry: false,
    ...(select ? { select } : {}),
    ...(staleTime ? { staleTime } : {}),
  });
};
const dataOf = (r) => r.data;

/** The packages on sale (needs `subscription.read`: pass `enabled` where someone without it may be looking). */
export const usePlanCatalogue = ({ enabled = true } = {}) => useOrgQuery(["plans"], "/subscription-plans", { enabled, staleTime: 1000 * 60 * 5 });
export const useSubscriptionOverview = ({ enabled = true } = {}) => useOrgQuery(["overview"], "/subscription", { enabled });
export const useSeatAssignments = ({ enabled = true } = {}) => useOrgQuery(["assignments"], "/subscription/assignments", { enabled, select: dataOf });
export const useInvoices = ({ enabled = true } = {}) => useOrgQuery(["invoices"], "/billing/invoices", { enabled, select: dataOf });
export const useSubscriptionHistory = () => useOrgQuery(["history"], "/subscription/history", { select: dataOf });

/**
 * The signed-in member's package and access level per module: { enforced, reason, plan, modules }.
 * Drives navigation and restriction pages only; the server enforces entitlements again.
 */
export const useSubscriptionAccess = () => useOrgQuery(["access"], "/subscription/access", { staleTime: 1000 * 60 });

/**
 * Whether a module is available to the current member. While unknown (loading, API unreachable) or
 * when the organisation is not enforcing entitlements, everything stays visible.
 */
export const useModuleAccess = () => {
  const { data, isLoading, error } = useSubscriptionAccess();
  return (moduleSlug) => {
    if (!moduleSlug || isLoading || error || !data || !data.enforced) return true;
    const level = data.modules?.[moduleSlug];
    return !!level && level !== "none";
  };
};

/** Seat purchases and package assignment; every change refreshes the whole subscription view. */
export const useSubscriptionMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ action, membershipId, planSlug, quantity }) => {
      switch (action) {
        case "seats":
          return apiFetch("/subscription/seats", { method: "PUT", body: { planSlug, quantity }, organisationId });
        case "assign":
          return apiFetch(`/subscription/assignments/${membershipId}`, { method: "PUT", body: { planSlug }, organisationId });
        case "remove":
          return apiFetch(`/subscription/assignments/${membershipId}`, { method: "DELETE", organisationId });
        default:
          throw new Error(`Unknown subscription action ${action}`);
      }
    },
    // Seats and packages decide what people may use, so permissions are refreshed too.
    onSettled: () => refreshOrganisation(queryClient, organisationId, { me: true }),
  });
};

/** Starts Stripe Checkout (14-day trial, card required). Resolves with { url, sessionId }: send the browser to url. */
export const useStartCheckout = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ interval, seats, returnTo = "setup" }) =>
      apiFetch("/billing/checkout-session", { method: "POST", body: { interval, seats, returnTo }, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/**
 * After Stripe sends the person back: asks the server to check the Checkout with Stripe and apply the subscription.
 * Resolves with { status: "open" | "complete" | "expired", subscription }. Access and permissions change, so they are refreshed too.
 */
export const useConfirmCheckout = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId }) => apiFetch("/billing/checkout-session/confirm", { method: "POST", body: { sessionId }, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId, { me: true }),
  });
};

/** Stripe's Customer Portal address (card, invoices, tax details, cancellation at period end). */
export const usePortalSession = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/billing/portal-session", { method: "POST", organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** What a seat change would cost now (proration from Stripe); changes nothing. `seats` = { planSlug: quantity } for the packages to change. */
export const useSeatPreview = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ seats }) => apiFetch("/billing/seats/preview", { method: "POST", body: { seats }, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
};

/** Changes seats on the Stripe subscription (prorated). Seats decide what people may use, so permissions are refreshed too. */
export const useChangeSeats = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ seats }) => apiFetch("/billing/seats", { method: "PUT", body: { seats }, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId, { me: true }),
  });
};
