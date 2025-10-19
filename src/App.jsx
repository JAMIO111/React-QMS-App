import { Outlet } from "react-router-dom";
import "./App.css";
import Navbar from "./components/Navbar";
import Header from "./components/Header";
import { SearchProvider } from "./contexts/SearchProvider.jsx";
import { NotificationProvider } from "./contexts/NotificationProvider";
import NotificationPane from "./components/NotificationPane";
function App() {
  return (
    <SearchProvider>
      <NotificationProvider>
        <NotificationPane />
        <div className="flex w-screen h-screen overflow-hidden">
          <div className="hidden md:block">
            <Navbar />
          </div>
          <main className="flex flex-col flex-1 h-full">
            <Header />
            <div className="flex flex-col flex-1 overflow-hidden min-w-0">
              <Outlet />
            </div>
          </main>
        </div>
      </NotificationProvider>
    </SearchProvider>
  );
}

export default App;
