import { Navigate, Outlet, useLocation } from "react-router-dom";
import "./App.css";
import Navbar from "./components/Navbar";
import Header from "./components/Header";
import { SearchProvider } from "./contexts/SearchProvider.jsx";
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
import { useEffect, useState } from "react";
import NetworkBlocked from "./components/NetworkBlocked";
import SsoRequired from "./components/SsoRequired";
import { useNetworkAccess } from "./hooks/useSecurity";
import { NETWORK_BLOCKED_EVENT, REAUTH_EVENT, REAUTH_NOTE_KEY, SSO_REQUIRED_EVENT } from "./lib/security";
import useSignOut from "./hooks/useSignOut";

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
  if (organisation === null) return <NoOrganisation error={error} />;

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
      <NotificationProvider>
        <ThemeColourSync />
        <NotificationPane />
        <div className="relative flex w-screen h-dvh overflow-clip bg-primary-bg">
          <div className="hidden md:block">
            <Navbar />
          </div>
          <main className="flex flex-col flex-1 h-full min-w-0 min-h-0">
            <Header />
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
    </SearchProvider>
  );
}

export default App;
