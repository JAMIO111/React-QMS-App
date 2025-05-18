import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App.jsx";
import Dashboard from "./components/Dashboard.jsx";
import NonConformance from "./components/NonConformance.jsx";
import NonConformanceDashboard from "./components/NonConformanceDashboard.jsx";
import Projects from "./components/Projects.jsx";
import NotFound from "./components/NotFound.jsx";
import Settings from "./components/Settings.jsx";
import NCEntryForm from "./components/NCEntryForm.jsx";
import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./contexts/ToastProvider.jsx";
import { ConfirmProvider } from "./contexts/ConfirmationModalProvider.jsx";

const queryClient = new QueryClient();

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
        element: <NonConformanceDashboard />,
      },
      {
        path: "Non-Conformance/Internal",
        element: <NonConformance />,
      },
      {
        path: "Non-Conformance/Internal/NC-Form",
        element: <NCEntryForm />,
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
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>
);
