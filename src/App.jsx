import { Outlet } from "react-router-dom";
import { useState } from "react";
import "./App.css";
import Navbar from "./components/Navbar";
import Header from "./components/Header";
import { SearchProvider } from "./contexts/SearchProvider.jsx";

function App() {
  return (
    <SearchProvider>
      <div className="flex w-screen overflow-hidden">
        <Navbar />
        <main className="flex flex-col grow h-dvh">
          <Header />
          <Outlet />
        </main>
      </div>
    </SearchProvider>
  );
}

export default App;
