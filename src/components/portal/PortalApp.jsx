import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useOutletContext, useSearchParams } from "react-router-dom";
import FortressMark from "../../assets/fortress-qms.png";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import { useMe } from "../../hooks/useQmsApi";
import { usePortalHome, usePortalMutation, usePortalScars, usePortalShares } from "../../hooks/usePortal";
import useSignOut from "../../hooks/useSignOut";
import { describeApiError } from "../../lib/api-client";
import { accessFor, dueWords, partyKindLabel, rememberPortalOrganisation, rememberedPortalOrganisation, scarPath, scarStatus, sharedPath, shareKindLabel, shortDate } from "../../lib/portal";
import PortalPeople from "./PortalPeople";

/**
 * The supplier and customer portal (docs/external-portal-plan.md PT1), at /portal: for people who act for a supplier or customer of an organisation
 * and are not members of it. Its own layout and no staff menu. This slice holds the foundation (where they have access, accepting an invitation, who
 * to talk to, and an admin's own colleagues); shared records, responses and performance arrive in the next slices.
 */
const PortalApp = () => {
  const me = useMe();
  const [signOut] = useSignOut();
  const [params] = useSearchParams();
  const [chosen, setChosen] = useState(params.get("org") || rememberedPortalOrganisation());
  const portal = useMemo(() => me.data?.portal ?? [], [me.data]);
  const current = useMemo(() => accessFor(portal, chosen), [portal, chosen]);

  useEffect(() => {
    if (current) rememberPortalOrganisation(current.organisationId);
  }, [current]);

  if (me.isLoading) return <div className="h-screen bg-primary-bg"><LoadingScreen fullscreen /></div>;
  const invitations = me.data?.portalInvitations ?? [];
  const isMember = (me.data?.memberships ?? []).length > 0;

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-primary-bg text-primary-text">
      <header className="flex flex-wrap items-center gap-3 border-b border-border-color bg-secondary-bg px-4 py-2">
        <img src={FortressMark} alt="" className="h-8 w-8 rounded-lg" />
        <div className="min-w-0 grow">
          <p className="text-sm font-semibold">{current ? current.organisationName : "Fortress QMS"}</p>
          <p className="text-xs text-secondary-text">{current ? `Portal for ${current.partyName}` : "Supplier and customer portal"}</p>
        </div>
        {portal.length > 1 && (
          <div className="w-64">
            <ComboField
              label="Organisation"
              value={current?.id}
              onChange={(id) => setChosen(portal.find((a) => a.id === id)?.organisationId ?? null)}
              options={portal.map((a) => ({ value: a.id, label: a.organisationName, hint: a.partyName }))}
            />
          </div>
        )}
        {isMember && <CTAButton to="/" type="neutral" size="default">Open the QMS</CTAButton>}
        <CTAButton type="secondary" size="default" onClick={signOut}>Sign out</CTAButton>
      </header>
      <main className="min-h-0 grow overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
          {invitations.length > 0 && <Invitations invitations={invitations} />}
          {current ? <Outlet context={{ access: current }} /> : invitations.length === 0 && <Nothing email={me.data?.profile?.email} />}
        </div>
      </main>
    </div>
  );
};

export default PortalApp;

const Nothing = ({ email }) => (
  <section aria-labelledby="no-portal" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-6">
    <h1 id="no-portal" className="text-xl font-semibold">No portal access for {email ?? "this address"}</h1>
    <p className="text-sm text-secondary-text">
      If you were expecting an invitation, check that you signed in with the address it was sent to, or ask the person who invited you to send it again.
      Your access may also have been paused or removed.
    </p>
  </section>
);

function Invitations({ invitations }) {
  const mutate = usePortalMutation();
  const [error, setError] = useState(null);
  return (
    <section aria-labelledby="portal-invitations" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
      <div>
        <h1 id="portal-invitations" className="text-xl font-semibold">{invitations.length === 1 ? "You have been invited" : "You have been invited to portals"}</h1>
        <p className="text-sm text-secondary-text">Accept to see and respond to what each organisation shares with the company you work for.</p>
      </div>
      <ul aria-label="Portal invitations" className="flex flex-col gap-3">
        {invitations.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-color p-4">
            <div>
              <h2 className="text-base font-semibold">{inv.organisationName}</h2>
              <p className="text-sm text-secondary-text">For {inv.partyName}</p>
            </div>
            {inv.expired ? (
              <span className="text-sm text-error-color">Expired. Ask for a new invitation.</span>
            ) : (
              <CTAButton
                type="main"
                size="lg"
                loading={mutate.isPending && mutate.variables?.id === inv.id}
                onClick={() => {
                  setError(null);
                  mutate.mutate({ action: "accept", id: inv.id }, { onError: setError });
                }}>
                Accept
              </CTAButton>
            )}
          </li>
        ))}
      </ul>
      {error && <Callout tone="error" role="alert">{describeApiError(error)}</Callout>}
    </section>
  );
}

export function PortalHome() {
  const { access } = useOutletContext();
  const home = usePortalHome(access.organisationId);
  const shares = usePortalShares(access.organisationId, { enabled: !access.mfaRequired });
  const scars = usePortalScars(access.organisationId, { enabled: !access.mfaRequired });
  const contact = access.contactName || access.organisationName;

  if (access.mfaRequired) {
    return (
      <Callout tone="warning" title="Two-factor authentication needed" role="alert">
        {access.organisationName} asks everyone who signs in to its portal to use two-factor authentication.{" "}
        <Link to={`/mfa?next=${encodeURIComponent("/portal")}`} className="font-medium text-link-color hover:underline">Set it up or enter your code</Link> to continue.
      </Callout>
    );
  }
  if (home.isLoading) return <LoadingScreen />;
  if (home.error) return <Callout tone="error" role="alert">{describeApiError(home.error)}</Callout>;

  return (
    <>
      <section aria-labelledby="portal-welcome" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h1 id="portal-welcome" className="text-xl font-semibold">{access.partyName}</h1>
        <p className="text-sm text-secondary-text">{partyKindLabel(access.partyKind)} portal for {access.organisationName}</p>
        <p className="text-sm text-primary-text">Your contact at {access.organisationName}: <span className="font-medium">{contact}</span></p>
      </section>
      {access.partyKind === "supplier" && (
        <p className="text-sm">
          <Link to="/portal/performance" className="font-medium text-link-color hover:underline">See your performance</Link>
          <span className="text-secondary-text"> — on time, in full and quality, as {access.organisationName} measures them.</span>
        </p>
      )}
      {home.data.scarsAwaiting.length > 0 && (
        <section aria-labelledby="portal-scars-awaiting" className="rounded-2xl border border-warning-color/40 bg-secondary-bg p-5">
          <h2 id="portal-scars-awaiting" className="text-lg font-semibold">Waiting for your response</h2>
          <ScarList items={home.data.scarsAwaiting} organisationId={access.organisationId} label="Requests waiting for your response" />
        </section>
      )}
      {home.data.scarsWithActions?.length > 0 && (
        <section aria-labelledby="portal-scar-actions" className="rounded-2xl border border-warning-color/40 bg-secondary-bg p-5">
          <h2 id="portal-scar-actions" className="text-lg font-semibold">Actions for you</h2>
          <ScarList items={home.data.scarsWithActions} organisationId={access.organisationId} label="Requests with actions for you" />
        </section>
      )}
      <section aria-labelledby="portal-attention" className="rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 id="portal-attention" className="text-lg font-semibold">Needs your attention</h2>
        {home.data.attention.length === 0 ? (
          <p className="mt-1 text-sm text-secondary-text">
            {home.data.shared === 0
              ? `Nothing has been shared with you yet. When ${access.organisationName} shares a non-conformance or an 8D with you, it will appear here.`
              : "Nothing new. You have seen everything shared with you and there are no new replies."}
          </p>
        ) : (
          <SharedList items={home.data.attention} organisationId={access.organisationId} label="Needs your attention" />
        )}
      </section>
      {(scars.data?.data ?? []).length > 0 && (
        <section aria-labelledby="portal-scars" className="rounded-2xl border border-border-color bg-secondary-bg p-5">
          <h2 id="portal-scars" className="text-lg font-semibold">Corrective action requests</h2>
          <ScarList items={scars.data.data} organisationId={access.organisationId} label="Corrective action requests" />
        </section>
      )}
      {(shares.data?.data ?? []).length > 0 && (
        <section aria-labelledby="portal-shared" className="rounded-2xl border border-border-color bg-secondary-bg p-5">
          <h2 id="portal-shared" className="text-lg font-semibold">Shared with you</h2>
          <SharedList items={shares.data.data} organisationId={access.organisationId} label="Shared with you" />
        </section>
      )}
      {access.role === "admin" && <PortalPeople access={access} />}
    </>
  );
}


/** The shared records as a list: kind and reference, title, when, and what is new. */
function SharedList({ items, organisationId, label }) {
  return (
    <ul aria-label={label} className="mt-2 flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
      {items.map((i) => (
        <li key={i.id}>
          <Link to={sharedPath(i.id, organisationId)} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-primary-bg">
            <div className="min-w-0 grow">
              <p className="truncate font-medium text-primary-text">{i.reference} · {i.title}</p>
              <p className="text-xs text-secondary-text">{shareKindLabel(i.kind)} · shared {shortDate(i.sharedAt)} · {i.comments} {i.comments === 1 ? "comment" : "comments"}</p>
            </div>
            {i.needsAcknowledgement && <span className="rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">Please acknowledge</span>}
            {!i.viewed && <span className="rounded-full bg-brand-primary/15 px-2 py-0.5 text-xs font-medium text-brand-primary">New</span>}
            {i.newComments > 0 && <span className="rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">{i.newComments} new {i.newComments === 1 ? "reply" : "replies"}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}


/** Corrective action requests as a list: reference and title, what is asked of them, when it is due. */
function ScarList({ items, organisationId, label }) {
  return (
    <ul aria-label={label} className="mt-2 flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
      {items.map((c) => {
        const st = scarStatus(c.status);
        return (
          <li key={c.id}>
            <Link to={scarPath(c.id, organisationId)} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-primary-bg">
              <div className="min-w-0 grow">
                <p className="truncate font-medium text-primary-text">{c.reference} · {c.title}</p>
                <p className="text-xs text-secondary-text">{st.label}{dueWords(c) ? ` · ${dueWords(c)}` : ""}{c.extensionWaiting ? " · more time asked for" : ""}{c.openActions > 0 ? ` · ${c.openActions} ${c.openActions === 1 ? "action" : "actions"} to do` : ""}</p>
              </div>
              {(c.overdue || c.lateActions > 0) && <span className="rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">{c.overdue ? "Overdue" : "Action overdue"}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
