import { Navigate, Outlet, useLocation } from "react-router-dom";
import "./App.css";
import Navbar from "./components/Navbar";
import Header from "./components/Header";
import { SearchProvider } from "./contexts/SearchProvider.jsx";
import { CommandPaletteProvider } from "./contexts/CommandPaletteProvider.jsx";
import { NotificationProvider } from "./contexts/NotificationProvider";
import NotificationPane from "./components/NotificationPane";
import NoOrganisation from "./components/NoOrganisation";
import LoadingScreen from "./components/ui/LoadingScreen";
import { useOrganisation } from "./contexts/OrganisationProvider";
import { useOrganisationAccess, usePermissions } from "./hooks/useQmsApi";
import SubscriptionBanner from "./components/SubscriptionBanner";
import SubscriptionNeeded from "./components/onboarding/SubscriptionNeeded";
import { setupDeferred } from "./lib/onboarding";
import ThemeColourSync from "./components/ThemeColourSync";
import { useCallback, useEffect, useState } from "react";
import MobileNav from "./components/MobileNav";
import NetworkBlocked from "./components/NetworkBlocked";
import SsoRequired from "./components/SsoRequired";
import { useNetworkAccess } from "./hooks/useSecurity";
import { NETWORK_BLOCKED_EVENT, REAUTH_EVENT, REAUTH_NOTE_KEY, SSO_REQUIRED_EVENT } from "./lib/security";
import useSignOut from "./hooks/useSignOut";
import { useQueryClient } from "@tanstack/react-query";
import { useMe } from "./hooks/useQmsApi";
import SeatWaiting from "./components/onboarding/SeatWaiting";
import Suspended from "./components/onboarding/Suspended";
import { WelcomeShell } from "./components/onboarding/MemberWelcome";
import { SEAT_REQUIRED_EVENT, suspendedFrom, waitingFor } from "./lib/memberOnboarding";

function App() {
  const { organisation, error } = useOrganisation();
  const { accessState, onboarding, isLoading: accessLoading } = useOrganisationAccess();
  const { can } = usePermissions();
  const { pathname } = useLocation();
  const network = useNetworkAccess();
  // A request refused with 403 network_not_allowed (security plan SE4) switches to the blocked screen at once, before /me is read again.
  const [blockedBy, setBlockedBy] = useState(null); // { organisationId, address }
  const [retrying, setRetrying] = useState(false);
  // A request refused with 403 sso_required (sso plan SS6), e.g. after an owner required single sign-on during this session.
  const [ssoRequired, setSsoRequired] = useState(null); // { organisationId, providerId, breakGlass }
  const [signOutNow] = useSignOut();
  // The phone's menu drawer (below the md width the side rail is hidden).
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);
  // The organisation's maximum session age (security plan SE6): sign out, and the sign-in page says why.
  useEffect(() => {
    const onReauth = (e) => {
      try {
        sessionStorage.setItem(REAUTH_NOTE_KEY, e.detail?.message || "Please sign in again.");
      } catch {
        /* storage may be unavailable; signing out still happens */
      }
      signOutNow();
    };
    window.addEventListener(REAUTH_EVENT, onReauth);
    return () => window.removeEventListener(REAUTH_EVENT, onReauth);
  }, [signOutNow]);
  useEffect(() => {
    const onBlocked = (e) => {
      setBlockedBy(e.detail ?? {});
      network.refetch?.();
    };
    window.addEventListener(NETWORK_BLOCKED_EVENT, onBlocked);
    return () => window.removeEventListener(NETWORK_BLOCKED_EVENT, onBlocked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A request refused with 403 seat_required (seats plan SM3): read /me again, which lists the organisation under seats.waitingIn.
  const queryClient = useQueryClient();
  const me = useMe();
  // A suspended person may still look for another organisation (an invitation waiting for them, or one of their own to start).
  const [lookElsewhere, setLookElsewhere] = useState(false);
  useEffect(() => {
    const onSeat = () => queryClient.invalidateQueries({ queryKey: ["api", "me"] });
    window.addEventListener(SEAT_REQUIRED_EVENT, onSeat);
    return () => window.removeEventListener(SEAT_REQUIRED_EVENT, onSeat);
  }, [queryClient]);

  useEffect(() => {
    const onSso = (e) => setSsoRequired(e.detail ?? {});
    window.addEventListener(SSO_REQUIRED_EVENT, onSso);
    return () => window.removeEventListener(SSO_REQUIRED_EVENT, onSso);
  }, []);

  // Browser tab: "Fortress QMS | <organisation>".
  useEffect(() => {
    document.title = organisation?.name ? `Fortress QMS | ${organisation.name}` : "Fortress QMS";
    return () => {
      document.title = "Fortress QMS";
    };
  }, [organisation?.name]);

  if (organisation === undefined) {
    return (
      <div className="h-screen bg-primary-bg"><LoadingScreen fullscreen /></div>
    );
  }
  if (organisation === null) {
    // Suspended from an organisation and not in another: say so, instead of offering to start one (their /me must have answered first).
    if (me.isLoading) return <div className="h-screen bg-primary-bg"><LoadingScreen fullscreen /></div>;
    // Someone who acts for a supplier or customer (or has a portal invitation) and belongs to no organisation of their own goes to the portal.
    if ((me.data?.portal?.length || me.data?.portalInvitations?.length) && !me.data?.memberships?.length) return <Navigate to="/portal" replace />;
    const suspended = suspendedFrom(me.data);
    if (suspended.length && !lookElsewhere) return <Suspended entries={suspended} onElsewhere={() => setLookElsewhere(true)} />;
    return <NoOrganisation error={error} />;
  }
  // The person belongs here but has no seat yet (seats plan SM4): the waiting screen instead of the organisation.
  const seatWait = waitingFor(me.data, organisation.id);
  if (seatWait) {
    return (
      <WelcomeShell>
        <SeatWaiting wait={seatWait} />
      </WelcomeShell>
    );
  }

  // An owner who has not finished the set-up wizard is taken to it (once per session: "Finish later" lets them into the app).
  if (!accessLoading && onboarding === "in_progress" && can("organisation.manage") && !setupDeferred() && !pathname.startsWith("/setup")) {
    return <Navigate to="/setup" replace />;
  }
  // An organisation without a valid subscription leaves only billing and set-up (the database refuses the rest too).
  const gated = !accessLoading && accessState !== "open";
  const settingsRoute = pathname.startsWith("/Settings");
  const blockedHere = blockedBy && (!blockedBy.organisationId || blockedBy.organisationId === organisation.id);
  const networkBlocked = network.state === "denied" || blockedHere;
  const ssoHere = ssoRequired && (!ssoRequired.organisationId || ssoRequired.organisationId === organisation.id);
  const retry = async () => {
    setRetrying(true);
    try {
      const fresh = await network.refetch?.();
      const m = fresh?.data?.memberships?.find((x) => x.organisation.id === organisation.id);
      if (m?.network?.state !== "denied") setBlockedBy(null);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <SearchProvider>
      <CommandPaletteProvider>
        <NotificationProvider>
          <ThemeColourSync />
          <NotificationPane />
          <div className="relative flex w-screen h-dvh overflow-clip bg-primary-bg">
            <div className="hidden md:block">
              <Navbar />
            </div>
            <MobileNav open={navOpen} onClose={closeNav} />
            <main className="flex flex-col flex-1 h-full min-w-0 min-h-0">
              <Header onOpenMenu={() => setNavOpen(true)} />
              <div className="relative flex flex-col flex-1 overflow-clip min-w-0 min-h-0">
                {ssoHere ? (
                  <SsoRequired organisations={[{ id: organisation.id, name: organisation.name, providerId: ssoRequired.providerId, breakGlass: ssoRequired.breakGlass }]} />
                ) : networkBlocked ? (
                  <NetworkBlocked address={network.address ?? blockedBy?.address ?? null} onRetry={retry} retrying={retrying} />
                ) : (
                  <>
                    {!gated && <SubscriptionBanner />}
                    {gated && !settingsRoute ? <SubscriptionNeeded /> : <Outlet />}
                  </>
                )}
              </div>
            </main>
          </div>
        </NotificationProvider>
      </CommandPaletteProvider>
    </SearchProvider>
  );
}

export default App;
