import CTAButton from "@/components/CTAButton";
import { ShieldAlertIcon } from "@/components/icons";
import { useOrganisation } from "../contexts/OrganisationProvider";

/**
 * Shown instead of the app when the organisation does not allow the network the person is on (docs/security-plan.md SE4). It shows nothing
 * of the organisation's data: only its name, the address Fortress sees and what to do. Another organisation the person belongs to can still be
 * chosen from the switcher in the header.
 */
const NetworkBlocked = ({ address, onRetry, retrying }) => {
  const { organisation, organisations, selectOrganisation, organisationId } = useOrganisation();
  const others = (organisations ?? []).filter((o) => o.id !== organisationId);
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto bg-primary-bg p-4" role="alert" aria-labelledby="network-blocked-title">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-border-color bg-secondary-bg p-6 shadow-sm">
        <ShieldAlertIcon className="text-4xl text-warning-color" aria-hidden />
        <h1 id="network-blocked-title" className="text-xl font-semibold text-primary-text">
          {organisation?.name ?? "This organisation"} is not available on this network
        </h1>
        <p className="text-sm text-secondary-text">
          Access is only allowed from the organisation&apos;s approved networks
          {address ? (
            <>
              {" "}(your address: <span className="font-mono text-primary-text">{address}</span>)
            </>
          ) : null}
          . Connect through your company network or VPN, or ask an administrator to approve this network.
        </p>
        <div className="flex flex-wrap gap-2">
          <CTAButton type="main" size="md" onClick={onRetry} loading={retrying}>
            Try again
          </CTAButton>
          {others.length > 0 && (
            <CTAButton type="secondary" size="md" onClick={() => selectOrganisation(others[0].id)}>
              Switch to {others[0].name}
            </CTAButton>
          )}
        </div>
      </div>
    </div>
  );
};

export default NetworkBlocked;
