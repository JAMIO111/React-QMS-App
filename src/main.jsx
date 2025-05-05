import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App.jsx";
import Dashboard from "./components/Dashboard.jsx";
import NonConformance from "./components/Nonconformance.jsx";
import Projects from "./components/Projects.jsx";
import NotFound from "./components/NotFound.jsx";
import Settings from "./components/Settings.jsx";
import "./index.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    errorElement: <NotFound />,
    children: [
      {
        index: true,
        path: "Dashboard",
        element: <Dashboard />,
      },
      {
        path: "Non-Conformance",
        element: null,
        children: [
          {
            path: "Internal",
            element: <NonConformance />,
          },
        ],
      },
      {
        path: "Projects",
        element: <Projects />,
      },
      {
        path: "Settings",
        element: <Settings />,
      },
    ],
  },
]);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
