import { BrowserRouter as Link, Outlet } from "react-router-dom";
import { useState } from "react";
import "./App.css";
import Navbar from "./components/Navbar";
import Header from "./components/Header";

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="flex w-screen">
      <Navbar />
      <main className="flex flex-col w-full h-dvh">
        <Header />
        <Outlet />
      </main>
    </div>
  );
}

export default App;
