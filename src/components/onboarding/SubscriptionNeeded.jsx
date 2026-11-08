import { Link } from "react-router-dom";
import { LockIcon } from "@/components/icons";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useOrganisationAccess, usePermissions } from "../../hooks/useQmsApi";
import CTAButton from "@/components/CTAButton";

const TEXT = {
  needs_subscription: { title: "Choose a plan to get started", body: "This organisation does not have a subscription yet. A subscription with at least one Controller seat, held by an owner, is needed to use Fortress QMS." },
  lapsed: { title: "Your subscription needs attention", body: "This organisation's subscription is no longer active, or no owner holds a Controller seat. Everything is kept safe and comes back as soon as it is fixed." },
};

/** Shown in place of the app while the organisation has no valid subscription. Only people with billing access are offered the way to fix it. */
const SubscriptionNeeded = () => {
  const { organisation } = useOrganisation();
  const { accessState, onboarding } = useOrganisationAccess();
  const { can } = usePermissions();
  const text = TEXT[accessState] ?? TEXT.lapsed;
  const billing = can("subscription.manage") || can("subscription.read");
  return (
    <div role="alert" className="mx-auto mt-16 flex max-w-lg flex-col items-center gap-3 px-4 text-center">
      <LockIcon className="text-3xl text-secondary-text" />
      <h1 className="text-xl font-semibold text-primary-text">{text.title}</h1>
      <p className="text-secondary-text">{text.body}</p>
      {billing ? (
        <div className="flex flex-wrap justify-center gap-2">
          {onboarding === "in_progress" && can("organisation.manage") && (
            <CTAButton to="/setup/plan" type="main" size="lg" className="font-medium">Continue set-up</CTAButton>
          )}
          <Link to="/Settings/Subscription" className="rounded-lg border border-border-color px-4 py-2 text-sm text-primary-text hover:border-border-dark-color">Subscription &amp; billing</Link>
        </div>
      ) : (
        <p className="text-sm text-secondary-text">Ask an owner or administrator of {organisation?.name ?? "your organisation"} to set up the subscription.</p>
      )}
    </div>
  );
};

export default SubscriptionNeeded;
