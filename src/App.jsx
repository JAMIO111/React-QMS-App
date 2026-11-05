import { Outlet } from "react-router-dom";
import "./App.css";
import Navbar from "./components/Navbar";
import Header from "./components/Header";
import { SearchProvider } from "./contexts/SearchProvider.jsx";
import { NotificationProvider } from "./contexts/NotificationProvider";
import NotificationPane from "./components/NotificationPane";
import NoOrganisation from "./components/NoOrganisation";
import LoadingScreen from "./components/ui/LoadingScreen";
import { useOrganisation } from "./contexts/OrganisationProvider";
import ThemeColourSync from "./components/ThemeColourSync";
import { useEffect } from "react";

function App() {
  const { organisation, error } = useOrganisation();

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
              <Outlet />
            </div>
          </main>
        </div>
      </NotificationProvider>
    </SearchProvider>
  );
}

export default App;
