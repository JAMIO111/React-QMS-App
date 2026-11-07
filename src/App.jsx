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
import { useEffect } from "react";

function App() {
  const { organisation, error } = useOrganisation();
  const { accessState, onboarding, isLoading: accessLoading } = useOrganisationAccess();
  const { can } = usePermissions();
  const { pathname } = useLocation();

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
              {!gated && <SubscriptionBanner />}
              {gated && !settingsRoute ? <SubscriptionNeeded /> : <Outlet />}
            </div>
          </main>
        </div>
      </NotificationProvider>
    </SearchProvider>
  );
}

export default App;
