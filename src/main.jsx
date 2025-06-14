import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./contexts/ToastProvider.jsx";
import { ConfirmProvider } from "./contexts/ConfirmationModalProvider.jsx";
import { AuthProvider } from "./contexts/AuthProvider.jsx";
import { UserProvider } from "./contexts/UserProvider.jsx";
import { OrganisationProvider } from "./contexts/OrganisationProvider.jsx";
import { ModalProvider } from "./contexts/ModalContext";
import "./index.css";
import LoadingSpinner from "./components/LoadingSpinner.jsx";

const App = lazy(() => import("./App.jsx"));
const Dashboard = lazy(() => import("./components/dashboard/Dashboard.jsx"));
const NonConformance = lazy(() => import("./components/NonConformance.jsx"));
const NonConformanceDashboard = lazy(() =>
  import("./components/dashboard/NonConformanceDashboard.jsx")
);
const Projects = lazy(() => import("./components/Projects.jsx"));
const NotFound = lazy(() => import("./components/NotFound.jsx"));
const Settings = lazy(() => import("./components/Settings/Settings.jsx"));
const SettingsSystemPreferences = lazy(() =>
  import("./components/Settings/SettingsSystemPreferences.jsx")
);
const SettingsDataManagement = lazy(() =>
  import("./components/Settings/SettingsDataManagement.jsx")
);
const SettingsAccount = lazy(() =>
  import("./components/Settings/SettingsAccount.jsx")
);
const Employees = lazy(() => import("./components/Employees.jsx"));
const NCEntryForm = lazy(() => import("./components/NCEntryForm.jsx"));
const AuthPage = lazy(() => import("./components/AuthPage.jsx"));
const Login = lazy(() => import("./components/Login.jsx"));
const SignUp = lazy(() => import("./components/SignUp.jsx"));
const HomeRedirect = lazy(() => import("./components/HomeRedirect.jsx"));
const ProtectedRoute = lazy(() => import("./components/ProtectedRoute.jsx"));

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const storedTheme = localStorage.getItem("theme");

if (storedTheme === "dark" || (!storedTheme && darkQuery.matches)) {
  document.documentElement.classList.add("dark");
} else {
  document.documentElement.classList.remove("dark");
}

const queryClient = new QueryClient();

const router = createBrowserRouter([
  {
    path: "/", // base route
    element: <HomeRedirect />,
    errorElement: <NotFound />,
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
            path: "Non-Conformance/Internal/:slug",
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
                element: (
                  <div>
                    <SettingsSystemPreferences />
                  </div>
                ),
              },
              {
                path: "Data-Management",
                element: (
                  <div>
                    <SettingsDataManagement />
                  </div>
                ),
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
              <OrganisationProvider>
                <ModalProvider>
                  <Suspense
                    fallback={
                      <div className="flex items-center justify-center h-screen bg-primary-bg">
                        <LoadingSpinner />
                      </div>
                    }>
                    <RouterProvider router={router} />
                  </Suspense>
                </ModalProvider>
              </OrganisationProvider>
            </UserProvider>
          </AuthProvider>
        </ToastProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>
);
