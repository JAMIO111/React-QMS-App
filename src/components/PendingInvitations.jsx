import { describeApiError } from "../lib/api-client";
import { useAcceptInvitation, useMyInvitations } from "../hooks/useQmsApi";

/** Invitations addressed to the signed-in person, with an Accept button each. Renders nothing if none. */
const PendingInvitations = () => {
  const { data, error } = useMyInvitations();
  const accept = useAcceptInvitation();
  const invitations = data?.data ?? [];
  if (error || invitations.length === 0) return null;

  return (
    <section aria-label="Invitations" className="flex flex-col gap-2">
      <h2 className="font-semibold">You've been invited</h2>
      <ul className="flex flex-col gap-2">
        {invitations.map((inv) => (
          <li key={inv.membershipId} className="flex items-center justify-between gap-3 rounded-xl border border-border-color p-3">
            <div>
              <div className="font-medium">{inv.organisationName}</div>
              {inv.invitedByName && <div className="text-sm text-secondary-text">Invited by {inv.invitedByName}</div>}
              {inv.roles?.length > 0 && <div className="text-sm text-secondary-text">As {inv.roles.map((r) => r.name).join(", ")}{inv.packageName ? ` · ${inv.packageName} seat` : ""}</div>}
              {inv.expired && <div className="text-sm text-error-color">Expired: ask for a new invitation</div>}
            </div>
            <button
              type="button"
              disabled={accept.isPending || inv.expired}
              onClick={() => accept.mutate(inv.membershipId)}
              className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
              Accept
            </button>
          </li>
        ))}
      </ul>
      {accept.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(accept.error)}
        </p>
      )}
    </section>
  );
};

export default PendingInvitations;
