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
import Employees from "./components/Employees.jsx";
import NCEntryForm from "./components/NCEntryForm.jsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./contexts/ToastProvider.jsx";
import { ConfirmProvider } from "./contexts/ConfirmationModalProvider.jsx";
import SettingsAccount from "./components/SettingsAccount.jsx";
import AuthPage from "./components/AuthPage.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { AuthProvider } from "./contexts/AuthProvider.jsx";
import { UserProvider } from "./contexts/UserProvider.jsx";
import Login from "./components/Login.jsx";
import SignUp from "./components/SignUp.jsx";
import HomeRedirect from "./components/HomeRedirect.jsx";
import "./index.css";

const queryClient = new QueryClient();

const router = createBrowserRouter([
  {
    path: "/", // base route
    element: <HomeRedirect />,
  },
  {
    element: <AuthPage />,
    children: [
      {
        path: "signup",
        element: <SignUp />,
      },
      {
        path: "login",
        element: <Login />,
      },
    ],
  },
  {
    path: "/QMS", // base path for protected routes
    element: <ProtectedRoute />, // MUST render <Outlet /> inside!
    errorElement: <NotFound />,
    children: [
      {
        element: <App />, // App contains the Navbar/Header + <Outlet />
        children: [
          { index: true, element: <Dashboard /> },
          { path: "Dashboard", element: <Dashboard /> },
          { path: "Non-Conformance", element: <NonConformanceDashboard /> },
          { path: "Non-Conformance/Internal", element: <NonConformance /> },
          {
            path: "Non-Conformance/Internal/New-NC",
            element: <NCEntryForm />,
          },
          {
            path: "Non-Conformance/Internal/:slug",
            element: <NCEntryForm />,
          },
          { path: "Projects", element: <Projects /> },
          {
            path: "Settings",
            element: <Settings />,
            children: [
              {
                path: "General",
                element: <div>General Settings</div>,
              },
              { path: "Account", element: <SettingsAccount /> },
              {
                path: "System-Preferences",
                element: <div>System Preferences</div>,
              },
              {
                path: "Data-Management",
                element: <div>Data Management</div>,
              },
              {
                path: "Notifications",
                element: <div>Notifications</div>,
              },
              { path: "Admin", element: <div>Admin Settings</div> },
            ],
          },
          { path: "Human-Resources", element: <Employees /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <ToastProvider>
          <AuthProvider>
            <UserProvider>
              <RouterProvider router={router} />
            </UserProvider>
          </AuthProvider>
        </ToastProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>
);
