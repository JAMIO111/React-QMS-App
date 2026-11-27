import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api-client";
import { useOrganisation } from "../contexts/OrganisationProvider";
import { refreshOrganisation } from "../lib/refresh";
import { guessCache, rollbackGuess } from "../lib/optimistic";

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
/**
 * True while an invoiced organisation's first invoice is unpaid: reporting keys wait until it is paid (the server refuses with 403 payable_first; this only
 * says so before the person tries). False when the organisation pays by card, the invoice is paid, or the person may not read the subscription.
 */
export const useFirstInvoicePending = ({ enabled = true } = {}) => {
  const overview = useSubscriptionOverview({ enabled });
  return enabled && overview.data?.firstInvoicePending === true;
};
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

/**
 * Seat purchases and package assignment; every change refreshes the whole subscription view. Giving or taking away a seat is optimistic: the
 * person's seat and the seats left change at once and go back if the server refuses (no seat free, the Controller rule). Buying seats waits.
 */
export const useSubscriptionMutation = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    onMutate: async (vars) => {
      if (vars.action !== "assign" && vars.action !== "remove") return { optimistic: false, snapshot: [] };
      const rows = queryClient.getQueryData(key(organisationId, "assignments"))?.data ?? [];
      const previous = rows.find((r) => r.membershipId === vars.membershipId)?.plan?.slug ?? null;
      const items = queryClient.getQueryData(key(organisationId, "overview"))?.items ?? [];
      const planName = vars.planName ?? items.find((i) => i.planSlug === vars.planSlug)?.planName ?? vars.planSlug ?? null;
      return guessCache(queryClient, key(organisationId), (data, queryKey) => guessSeat(data, queryKey.at(-1), { ...vars, previous, planName }));
    },
    onError: (_error, _vars, context) => rollbackGuess(queryClient, context),
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

/**
 * The seat assignments (`{ data }`, `part` "assignments") or the overview (`items` with assigned / available, `part` "overview") as they will be
 * once `membershipId` gets `planSlug` (`action: "assign"`) or loses its seat (`"remove"`). `previous` = the slug they held before.
 */
export const guessSeat = (data, part, { action, membershipId, planSlug = null, planName = null, previous = null }) => {
  const next = action === "assign" ? planSlug : null;
  if (!data || next === previous) return data;
  if (part === "assignments" && Array.isArray(data.data)) {
    let changed = false;
    const rows = data.data.map((r) => {
      if (r.membershipId !== membershipId) return r;
      changed = true;
      return { ...r, plan: next ? { ...(r.plan ?? {}), slug: next, name: planName ?? next } : null };
    });
    return changed ? { ...data, data: rows } : data;
  }
  if (part === "overview" && Array.isArray(data.items)) {
    const delta = (slug) => (slug === next ? 1 : 0) - (slug === previous ? 1 : 0);
    const items = data.items.map((i) => {
      const d = delta(i.planSlug);
      return d ? { ...i, assigned: i.assigned + d, available: Math.max(0, i.available - d) } : i;
    });
    const totals = data.totals
      ? { ...data.totals, seatsAssigned: items.reduce((t, i) => t + i.assigned, 0), seatsAvailable: items.reduce((t, i) => t + i.available, 0) }
      : data.totals;
    return { ...data, items, totals };
  }
  return data;
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

/** Starts a subscription paid by invoice (no Checkout, no trial). Resolves with { subscription, vat }; access and permissions change, so they are refreshed too. */
export const useStartInvoiceSubscription = () => {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiFetch("/billing/invoice-subscription", { method: "POST", body, organisationId }),
    onSettled: () => refreshOrganisation(queryClient, organisationId, { me: true }),
  });
};

/** Whether this company may be invoiced (the one-organisation-per-company rule and the operator's switch); changes nothing. Resolves with { problems }. */
export const useCheckInvoiceCompany = () => {
  const { organisationId } = useOrganisation();
  return useMutation({
    mutationFn: ({ legalName, vatNumber }) => apiFetch("/billing/invoice-company/check", { method: "POST", body: { legalName, ...(vatNumber ? { vatNumber } : {}) }, organisationId }),
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
