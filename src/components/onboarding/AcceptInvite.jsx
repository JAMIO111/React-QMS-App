import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import FortressMark from "../../assets/fortress-qms.png";
import Field from "../ui/Field";
import { CheckIcon } from "@/components/icons";
import { describeApiError } from "../../lib/api-client";
import { expiresIn } from "../../lib/onboarding";
import { useAuth } from "../../contexts/AuthProvider";
import { useAcceptInvitation, useMe, useMyInvitations, usePermissions, useUpdateProfile } from "../../hooks/useQmsApi";
import { buttonClass } from "../master-data/shared";

const Shell = ({ children }) => (
  <main className="h-dvh w-full overflow-y-auto bg-primary-bg">
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-border-color bg-secondary-bg p-6 text-primary-text">
        <div className="flex items-center gap-3">
          <img src={FortressMark} alt="" className="h-9 w-9 rounded-lg" />
          <span className="text-lg font-semibold">Fortress QMS</span>
        </div>
        {children}
      </div>
    </div>
  </main>
);

/** One invitation in words: who invited you, as what, where, with which seat, and for how long it stands. */
const InvitationCard = ({ invitation: inv, onAccept, pending, disabled }) => (
  <li className="flex flex-col gap-3 rounded-xl border border-border-color p-4">
    <div>
      <h2 className="text-lg font-semibold">{inv.organisationName}</h2>
      <p className="text-sm text-secondary-text">{inv.invitedByName ? `${inv.invitedByName} invited you` : "You have been invited"}</p>
    </div>
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
      <dt className="text-secondary-text">Your role</dt>
      <dd>{inv.roles.length ? inv.roles.map((r) => r.name).join(", ") : "To be decided by your administrator"}</dd>
      {inv.departments.length > 0 && (
        <>
          <dt className="text-secondary-text">Department</dt>
          <dd>{inv.departments.join(", ")}</dd>
        </>
      )}
      {inv.packageName && (
        <>
          <dt className="text-secondary-text">Your seat</dt>
          <dd>{inv.packageName}, already reserved for you. You pay nothing: it comes from the organisation's subscription.</dd>
        </>
      )}
    </dl>
    {inv.message && <blockquote className="rounded-lg border-l-4 border-brand-primary bg-primary-bg/50 px-3 py-2 text-sm italic">{inv.message}</blockquote>}
    {inv.expired ? (
      <p role="alert" className="text-sm text-error-color">This invitation has expired. Ask {inv.invitedByName ?? "the person who invited you"} to send you a new one.</p>
    ) : (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-secondary-text">{inv.expiresAt ? `Expires in ${expiresIn(inv.expiresAt)}` : ""}</span>
        <button type="button" className={buttonClass.primary} disabled={pending || disabled} onClick={() => onAccept(inv)}>
          {pending ? "Joining…" : `Join ${inv.organisationName}`}
        </button>
      </div>
    )}
  </li>
);

/** After joining: what you can do, your seat, two-factor, and where to start. */
const Welcome = ({ invitation: inv, mfaRequired }) => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const starts = [
    { show: can("ncr.read"), to: "/Non-Conformance", label: "Non-conformances", hint: "Raise and follow up problems" },
    { show: can("inspection.read"), to: "/Inspections", label: "Inspections", hint: "Record results against the control plan" },
    { show: can("calibration.read"), to: "/Calibration", label: "Calibration", hint: "Gauges and their due dates" },
    { show: can("documentation.read"), to: "/Documentation/My-Alerts", label: "Quality alerts", hint: "Alerts addressed to you" },
    { show: can("capa.read"), to: "/CAPA/My-Actions", label: "My actions", hint: "Corrective actions assigned to you" },
  ].filter((s) => s.show);
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-color text-white"><CheckIcon className="h-5 w-5" aria-label="Joined" /></span>
        <div>
          <h1 className="text-xl font-semibold">Welcome to {inv.organisationName}</h1>
          <p className="text-sm text-secondary-text">You joined as {inv.roles.map((r) => r.name).join(", ") || "a member"}{inv.packageName ? ` with a ${inv.packageName} seat` : ""}.</p>
        </div>
      </div>
      {mfaRequired ? (
        <p role="status" className="rounded-xl border border-error-color p-3 text-sm">
          {inv.organisationName} requires two-factor sign-in. <Link to="/mfa" className="text-link-color underline">Set it up now</Link> to use the app.
        </p>
      ) : (
        <p className="text-sm text-secondary-text">
          Tip: protect your account with two-factor sign-in in <Link to="/Settings/Account" className="text-link-color underline">Settings → Account</Link>.
        </p>
      )}
      <section aria-label="Where to start">
        <h2 className="mb-2 text-sm font-semibold">Where to start</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {starts.map((s) => (
            <li key={s.to}>
              <Link to={s.to} className="flex h-full flex-col rounded-xl border border-border-color p-3 hover:border-border-dark-color">
                <span className="font-medium">{s.label}</span>
                <span className="text-xs text-secondary-text">{s.hint}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <div className="flex justify-end">
        <button type="button" className={buttonClass.secondary} onClick={() => navigate("/Dashboard", { replace: true })}>Go to the dashboard</button>
      </div>
    </>
  );
};

/**
 * The invitee's page (/accept-invite): the invitations waiting for the signed-in address, in words, then a welcome. Asks for a name first if the profile has none.
 * No payment and no organisation set-up here: the seat comes from the organisation.
 */
const AcceptInvite = () => {
  const { user } = useAuth();
  const me = useMe();
  const invitations = useMyInvitations();
  const accept = useAcceptInvitation();
  const updateProfile = useUpdateProfile();
  const [joined, setJoined] = useState(null);
  const [firstName, setFirstName] = useState("");
  const [surname, setSurname] = useState("");
  const [error, setError] = useState(null);

  if (invitations.isLoading || me.isLoading) return <Shell><p className="text-sm text-secondary-text">Loading…</p></Shell>;
  if (joined) return <Shell><Welcome invitation={joined} mfaRequired={!!me.data?.mfa?.requiredBy?.some((o) => o.id === joined.organisationId)} /></Shell>;

  const list = invitations.data?.data ?? [];
  const profile = me.data?.profile;
  const needsName = !profile?.firstName || !profile?.surname;
  const nameMissing = needsName && (!firstName.trim() || !surname.trim());

  const join = async (inv) => {
    setError(null);
    try {
      if (needsName) await updateProfile.mutateAsync({ firstName: firstName.trim(), surname: surname.trim() });
      await accept.mutateAsync(inv.membershipId);
      setJoined(inv);
    } catch (e) {
      setError(e);
    }
  };

  if (list.length === 0) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">No invitations for {user?.email ?? "this address"}</h1>
        <p className="text-sm text-secondary-text">If you were expecting one, check that you signed in with the address it was sent to, or ask the person who invited you to send it again.</p>
        <div className="flex gap-2">
          <Link to="/" className={buttonClass.neutral}>Continue</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div>
        <h1 className="text-xl font-semibold">{list.length === 1 ? "You have been invited" : "You have been invited to join"}</h1>
        <p className="text-sm text-secondary-text">Signed in as {user?.email}</p>
      </div>
      {needsName && (
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium">Your name</legend>
          <Field label="First name" required value={firstName} maxLength={100} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
          <Field label="Surname" required value={surname} maxLength={100} onChange={(e) => setSurname(e.target.value)} autoComplete="family-name" />
        </fieldset>
      )}
      <ul aria-label="Invitations" className="flex flex-col gap-3">
        {list.map((inv) => (
          <InvitationCard key={inv.membershipId} invitation={inv} onAccept={join} pending={accept.isPending || updateProfile.isPending} disabled={nameMissing} />
        ))}
      </ul>
      {nameMissing && <p className="text-xs text-secondary-text">Enter your name to join.</p>}
      {error && <p role="alert" className="text-sm text-error-color">{describeApiError(error)}</p>}
    </Shell>
  );
};

export default AcceptInvite;
