import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { usePermissions } from "../hooks/useQmsApi";
import { useSubscriptionOverview } from "../hooks/useSubscription";
import { subscriptionWarning } from "../lib/goLive";

const dismissedKey = (kind) => `qms.subscriptionBanner.${kind}`;
const isDismissed = (kind) => {
  try {
    return sessionStorage.getItem(dismissedKey(kind)) === "1";
  } catch {
    return false;
  }
};
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

/**
 * A warning strip above the page for people who can see the subscription: payment overdue (always, with the date access stops), trial ending soon, or a
 * subscription set to end. The last two can be dismissed for the rest of the browser session. Not shown on the billing page itself, which says the same.
 */
const SubscriptionBanner = () => {
  const { can } = usePermissions();
  const { pathname } = useLocation();
  const allowed = can("subscription.read");
  const { data } = useSubscriptionOverview({ enabled: allowed });
  const [, bump] = useState(0);
  const warning = allowed ? subscriptionWarning(data?.subscription) : null;
  if (!warning || pathname.startsWith("/Settings/Subscription") || (warning.dismissible && isDismissed(warning.kind))) return null;

  const text = {
    past_due: `Your last payment failed. ${warning.accessEnds ? `Access to Fortress QMS stops on ${date(warning.accessEnds)} unless it is fixed.` : "Please fix it to keep access."}`,
    trial_ending: `Your free trial ends in ${warning.daysLeft} ${warning.daysLeft === 1 ? "day" : "days"} (${date(warning.endsOn)}). Your card is charged then.`,
    cancelling: `Your subscription ends on ${date(warning.endsOn)}. After that the organisation is locked to billing.`,
  }[warning.kind];

  return (
    <div role={warning.kind === "past_due" ? "alert" : "status"} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <span className="min-w-0 flex-1">{text}</span>
      <Link to="/Settings/Subscription" className="font-semibold underline">
        {warning.kind === "past_due" ? "Update payment details" : "Manage billing"}
      </Link>
      {warning.dismissible && (
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.setItem(dismissedKey(warning.kind), "1");
            } catch {
              // Only lasts until the next render.
            }
            bump((n) => n + 1);
          }}
          className="rounded px-2 py-0.5 hover:bg-amber-100 dark:hover:bg-amber-900">
          Dismiss
        </button>
      )}
    </div>
  );
};

export default SubscriptionBanner;
