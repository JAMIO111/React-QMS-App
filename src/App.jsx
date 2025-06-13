import { Outlet } from "react-router-dom";
import "./App.css";
import Navbar from "./components/Navbar";
import Header from "./components/Header";
import { SearchProvider } from "./contexts/SearchProvider.jsx";

function App() {
  return (
    <SearchProvider>
      <div className="flex w-screen h-screen overflow-hidden">
        <div className="hidden md:block">
          <Navbar />
        </div>
        <main className="flex flex-col grow h-full">
          <Header />
          <div className="flex flex-col flex-grow overflow-hidden">
            <Outlet />
          </div>
        </main>
      </div>
    </SearchProvider>
  );
}

export default App;
