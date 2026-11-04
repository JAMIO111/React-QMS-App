import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./contexts/ToastProvider.jsx";
import { ConfirmProvider } from "./contexts/ConfirmationModalProvider.jsx";
import { AuthProvider } from "./contexts/AuthProvider.jsx";
import { UserProvider } from "./contexts/UserProvider.jsx";
import { OrganisationProvider } from "./contexts/OrganisationProvider.jsx";
import { ModalProvider } from "./contexts/ModalContext";
import LoadingSpinner from "./components/LoadingSpinner.jsx";
import "./index.css";
import { applyStoredThemeColour } from "./lib/theme-colours";

applyStoredThemeColour();

const App = lazy(() => import("./App.jsx"));
const NonConformance = lazy(() => import("./components/NonConformance.jsx"));
const Dashboard = lazy(() => import("./components/dashboard/Dashboard.jsx"));
const NotFound = lazy(() => import("./components/NotFound.jsx"));
const Settings = lazy(() => import("./components/Settings/Settings.jsx"));
const SettingsSystemPreferences = lazy(() =>
  import("./components/Settings/SettingsSystemPreferences.jsx")
);
const SettingsDataManagement = lazy(() =>
  import("./components/Settings/SettingsDataManagement.jsx")
);
const SettingsOrganisation = lazy(() =>
  import("./components/Settings/SettingsOrganisation.jsx")
);
const SettingsUsers = lazy(() => import("./components/Settings/SettingsUsers.jsx"));
const SettingsAccount = lazy(() =>
  import("./components/Settings/SettingsAccount.jsx")
);
const Employees = lazy(() => import("./components/Employees.jsx"));
const PartsPage = lazy(() => import("./components/master-data/PartsPage.jsx"));
const NcrPage = lazy(() => import("./components/ncr/NcrPage.jsx"));
const NcDashboard = lazy(() => import("./components/ncr/NcDashboard.jsx"));
const CalibrationDashboard = lazy(() => import("./components/calibration/CalibrationDashboard.jsx"));
const GaugeRegister = lazy(() => import("./components/calibration/GaugeRegister.jsx"));
const GaugePage = lazy(() => import("./components/calibration/GaugePage.jsx"));
const CalibrationRecordPage = lazy(() => import("./components/calibration/CalibrationRecordPage.jsx"));
const SettingsCalibration = lazy(() => import("./components/Settings/SettingsCalibration.jsx"));
const PartDetailPage = lazy(() => import("./components/master-data/PartDetailPage.jsx"));
const PartiesPage = lazy(() => import("./components/master-data/PartiesPage.jsx"));
const MachinesPage = lazy(() => import("./components/master-data/MachinesPage.jsx"));
const PartFamiliesPage = lazy(() => import("./components/master-data/PartFamiliesPage.jsx"));
const PartFamilyPage = lazy(() => import("./components/master-data/PartFamilyPage.jsx"));
const ControlPlansPage = lazy(() => import("./components/process-control/ControlPlansPage.jsx"));
const ControlPlanPage = lazy(() => import("./components/process-control/ControlPlanPage.jsx"));
const RevisionPage = lazy(() => import("./components/process-control/RevisionPage.jsx"));
const AuthPage = lazy(() => import("./components/AuthPage.jsx"));
const Login = lazy(() => import("./components/Login.jsx"));
const SignUp = lazy(() => import("./components/SignUp.jsx"));
const ForgotPassword = lazy(() => import("./components/auth/ForgotPassword.jsx"));
const SetPassword = lazy(() => import("./components/auth/SetPassword.jsx"));
const MfaPage = lazy(() => import("./components/mfa/MfaPage.jsx"));
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
      { path: "forgot-password", element: <ForgotPassword /> },
      { path: "set-password", element: <SetPassword /> },
      { path: "mfa", element: <MfaPage /> },
    ],
  },
  {
    path: "/", // base path for protected routes
    element: <ProtectedRoute />, // MUST render <Outlet /> inside!
    errorElement: <NotFound />,
    children: [
      {
        element: <App />, // App contains the Navbar/Header + <Outlet />
        children: [
          { index: true, element: <Dashboard /> },
          { path: "Dashboard", element: <Dashboard /> },
          { path: "Non-Conformance", element: <NcDashboard /> },
          { path: "Non-Conformance/:type", element: <NonConformance /> },
          { path: "Non-Conformance/:type/:id", element: <NcrPage /> },
          { path: "Calibration", element: <CalibrationDashboard /> },
          { path: "Calibration/Gauges", element: <GaugeRegister /> },
          { path: "Calibration/Gauges/:id", element: <GaugePage key="gauge" /> },
          { path: "Calibration/Gauges/:gaugeId/calibrations/:calibrationId", element: <CalibrationRecordPage /> },
          {
            path: "Settings",
            element: <Settings />,
            children: [
              { index: true, element: <Navigate to="Organisation" replace /> },
              { path: "Organisation", element: <SettingsOrganisation /> },
              { path: "Users", element: <SettingsUsers /> },
              { path: "General", element: <Navigate to="../Organisation" replace /> },
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
              { path: "Calibration", element: <SettingsCalibration /> },
              {
                path: "Notifications",
                element: <div>Notifications</div>,
              },
              { path: "Admin", element: <div>Admin Settings</div> },
            ],
          },
          { path: "Human-Resources", element: <Employees /> },
          { path: "Parts", element: <PartsPage /> },
          { path: "Parts/:id", element: <PartDetailPage /> },
          { path: "Customers", element: <PartiesPage key="customers" kind="customers" /> },
          { path: "Suppliers", element: <PartiesPage key="suppliers" kind="suppliers" /> },
          { path: "Machines", element: <MachinesPage /> },
          { path: "Part-Families", element: <PartFamiliesPage /> },
          { path: "Part-Families/:id", element: <PartFamilyPage /> },
          { path: "Process-Control", element: <Navigate to="Plans" replace /> },
          { path: "Process-Control/Plans", element: <ControlPlansPage /> },
          { path: "Process-Control/Plans/:id", element: <ControlPlanPage /> },
          { path: "Process-Control/Plans/:planId/revisions/:revisionId", element: <RevisionPage /> },
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
