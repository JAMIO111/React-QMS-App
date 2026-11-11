import { Link, Outlet } from "react-router-dom";
import { LockIcon } from "@/components/icons";
import { usePermissions } from "../hooks/useQmsApi";
import { usePlanCatalogue, useSubscriptionAccess } from "../hooks/useSubscription";

const REASONS = {
  no_seat_assigned: "You have not been given a subscription package.",
  no_active_subscription: "Your organisation has no active subscription.",
  payment_overdue: "Your organisation's subscription payment is overdue.",
  subscription_suspended: "Your organisation's subscription is suspended.",
  insufficient_seats: "Your organisation has more assigned users than purchased seats.",
};

/** Explains why a module is unavailable. Upgrade options are shown only to subscription managers. */
export const RestrictedModule = ({ moduleName, access, requiredPlan }) => {
  const { can } = usePermissions();
  const manager = can("subscription.manage") || can("subscription.seats");
  return (
    <div role="alert" className="mx-auto mt-16 flex max-w-lg flex-col items-center gap-3 text-center">
      <LockIcon className="text-3xl text-secondary-text" />
      <h1 className="text-xl font-semibold text-primary-text">{moduleName}</h1>
      <p className="text-secondary-text">
        {REASONS[access.reason] ?? "This module requires a higher subscription package."}
      </p>
      <p className="text-sm text-secondary-text">
        Current package: {access.plan?.name ?? "none"}
        {requiredPlan ? `. Required package: ${requiredPlan}.` : "."}
      </p>
      {manager ? (
        <Link to="/Settings/Subscription" className="rounded-lg border border-border-color px-3 py-2 text-sm text-primary-text hover:border-border-dark-color">
          Manage subscription
        </Link>
      ) : (
        <p className="text-sm text-secondary-text">Ask your organisation's subscription administrator for access.</p>
      )}
    </div>
  );
};

/**
 * Route guard: renders the nested routes when the member's package includes `module`. This only
 * improves the experience; the database and API refuse the same requests on their own.
 */
const RequireModule = ({ module: moduleSlug }) => {
  const { data: access, isLoading, error } = useSubscriptionAccess();
  const { can } = usePermissions();
  const level = access?.modules?.[moduleSlug];
  const restricted = !!access?.enforced && !(level && level !== "none");
  // The catalogue (which package would unlock it) is only for someone who may read subscriptions, and only when the module is locked.
  const catalogue = usePlanCatalogue({ enabled: restricted && can("subscription.read") });
  if (isLoading || error || !access || !restricted) return <Outlet />;

  const mod = catalogue.data?.modules.find((m) => m.slug === moduleSlug);
  const required = can("subscription.read")
    ? catalogue.data?.plans.find((p) => (p.levels?.[moduleSlug] ?? "none") !== "none")?.name
    : undefined;
  return <RestrictedModule moduleName={mod?.name ?? moduleSlug} access={access} requiredPlan={required} />;
};

export default RequireModule;
