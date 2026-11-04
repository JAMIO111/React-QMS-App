import { Outlet } from "react-router-dom";
import "./App.css";
import Navbar from "./components/Navbar";
import Header from "./components/Header";
import { SearchProvider } from "./contexts/SearchProvider.jsx";
import { NotificationProvider } from "./contexts/NotificationProvider";
import NotificationPane from "./components/NotificationPane";
import NoOrganisation from "./components/NoOrganisation";
import LoadingSpinner from "./components/LoadingSpinner";
import { useOrganisation } from "./contexts/OrganisationProvider";
import ThemeColourSync from "./components/ThemeColourSync";

function App() {
  const { organisation, error } = useOrganisation();

  if (organisation === undefined) {
    return (
      <div className="flex items-center justify-center h-screen bg-primary-bg">
        <LoadingSpinner />
      </div>
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
