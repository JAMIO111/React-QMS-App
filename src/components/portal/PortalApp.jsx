import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useSearchParams } from "react-router-dom";
import FortressMark from "../../assets/fortress-qms.png";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import { useMe } from "../../hooks/useQmsApi";
import { usePortalHome, usePortalMutation } from "../../hooks/usePortal";
import PortalNavbar from "./PortalNavbar";
import useSignOut from "../../hooks/useSignOut";
import { describeApiError } from "../../lib/api-client";
import { accessFor, portalPageTitle, rememberPortalOrganisation, rememberedPortalOrganisation } from "../../lib/portal";

/**
 * The supplier and customer portal (docs/external-portal-plan.md), at /portal: for people who act for a supplier or customer of an organisation and
 * are not members of it. It looks and moves like the main app (side menu, top bar, registers) with only the menu items their kind of party has, and
 * no staff menu. This shell holds the menu with what is waiting per item, the organisation chooser, pending invitations and the pages' outlet.
 */
const PortalApp = () => {
  const me = useMe();
  const [signOut] = useSignOut();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const [chosen, setChosen] = useState(params.get("org") || rememberedPortalOrganisation());
  const portal = useMemo(() => me.data?.portal ?? [], [me.data]);
  const current = useMemo(() => accessFor(portal, chosen), [portal, chosen]);
  // What is waiting per menu item: the same answer the dashboard uses, so the badges cost no extra request there.
  const home = usePortalHome(current && !current.mfaRequired ? current.organisationId : undefined);
  const badges = useMemo(() => {
    const d = home.data;
    if (!d || !current || current.mfaRequired) return {};
    const kindOf = (...kinds) => d.attention.filter((i) => kinds.includes(i.kind)).length;
    return {
      ncrs: kindOf("ncr"),
      capas: kindOf("capa"),
      documents: kindOf("document", "quality_alert"),
      changeApprovals: d.changesToApprove ?? 0,
      ppaps: d.ppapsToAnswer ?? 0,
      ppapPackages: d.ppapPackagesToPrepare ?? 0,
      scars: new Set([...d.scarsAwaiting, ...(d.scarsWithActions ?? [])].map((c) => c.id)).size,
    };
  }, [home.data, current]);

  useEffect(() => {
    if (current) rememberPortalOrganisation(current.organisationId);
  }, [current]);

  useEffect(() => {
    const title = portalPageTitle(pathname);
    document.title = current ? `${title} | ${current.organisationName} portal` : "Fortress QMS portal";
    return () => {
      document.title = "Fortress QMS";
    };
  }, [pathname, current]);

  if (me.isLoading) return <div className="h-screen bg-primary-bg"><LoadingScreen fullscreen /></div>;
  const invitations = me.data?.portalInvitations ?? [];
  const isMember = (me.data?.memberships ?? []).length > 0;

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-primary-bg text-primary-text">
      {current && <PortalNavbar access={current} badges={badges} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-border-color bg-secondary-bg px-4 py-2">
          {!current && <img src={FortressMark} alt="" className="h-8 w-8 rounded-lg" />}
          <div className="min-w-0 grow">
            <p className="text-sm font-semibold">{current ? portalPageTitle(pathname) : "Fortress QMS"}</p>
            <p className="truncate text-xs text-secondary-text">{current ? `${current.partyName} · ${current.organisationName}` : "Supplier and customer portal"}</p>
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
        {current && <PortalNavbar access={current} badges={badges} mobile />}
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {invitations.length > 0 && <div className="mx-auto w-full max-w-5xl p-4"><Invitations invitations={invitations} /></div>}
          {current ? <Outlet context={{ access: current }} /> : invitations.length === 0 && <div className="mx-auto w-full max-w-5xl p-4"><Nothing email={me.data?.profile?.email} /></div>}
        </main>
      </div>
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
