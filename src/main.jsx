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
import LoadingScreen from "./components/ui/LoadingScreen.jsx";
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
const SettingsNotifications = lazy(() => import("./components/Settings/SettingsNotifications.jsx"));
const SettingsSubscription = lazy(() => import("./components/Settings/SettingsSubscription.jsx"));
const RequireModule = lazy(() => import("./components/RequireModule.jsx"));
const SettingsCalibration = lazy(() => import("./components/Settings/SettingsCalibration.jsx"));
const SettingsProcessControl = lazy(() => import("./components/Settings/SettingsProcessControl.jsx"));
const PartDetailPage = lazy(() => import("./components/master-data/PartDetailPage.jsx"));
const PartiesPage = lazy(() => import("./components/master-data/PartiesPage.jsx"));
const MachinesPage = lazy(() => import("./components/master-data/MachinesPage.jsx"));
const PartFamiliesPage = lazy(() => import("./components/master-data/PartFamiliesPage.jsx"));
const PartFamilyPage = lazy(() => import("./components/master-data/PartFamilyPage.jsx"));
const ControlPlansPage = lazy(() => import("./components/process-control/ControlPlansPage.jsx"));
const ControlPlanPage = lazy(() => import("./components/process-control/ControlPlanPage.jsx"));
const RevisionPage = lazy(() => import("./components/process-control/RevisionPage.jsx"));
const ProcessControlDashboard = lazy(() => import("./components/process-control/ProcessControlDashboard.jsx"));
const SpcPage = lazy(() => import("./components/spc/SpcPage.jsx"));
const AnalysisPage = lazy(() => import("./components/spc/AnalysisPage.jsx"));
const AlertsPage = lazy(() => import("./components/spc/AlertsPage.jsx"));
const QualityAlertsPage = lazy(() => import("./components/documentation/QualityAlertsPage.jsx"));
const QualityAlertPage = lazy(() => import("./components/documentation/QualityAlertPage.jsx"));
const MyAlertsPage = lazy(() => import("./components/documentation/MyAlertsPage.jsx"));
const QualityAlertForm = lazy(() => import("./components/documentation/QualityAlertForm.jsx"));
const CapaRegisterPage = lazy(() => import("./components/capa/CapaRegisterPage.jsx"));
const CapaPage = lazy(() => import("./components/capa/CapaPage.jsx"));
const CapaReportPage = lazy(() => import("./components/capa/CapaReportPage.jsx"));
const MyActionsPage = lazy(() => import("./components/capa/MyActionsPage.jsx"));
const PlatformPage = lazy(() => import("./components/platform/PlatformPage.jsx"));
const SetupWizard = lazy(() => import("./components/onboarding/SetupWizard.jsx"));
const InspectionsPage = lazy(() => import("./components/inspection/InspectionsPage.jsx"));
const StartInspectionPage = lazy(() => import("./components/inspection/StartInspectionPage.jsx"));
const InspectionPage = lazy(() => import("./components/inspection/InspectionPage.jsx"));
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
      // The operator area spans organisations, so it lives outside <App /> (which needs one) and checks access itself.
      { path: "platform", element: <PlatformPage /> },
      // The owner's first-run wizard is full-screen too (it needs the organisation, not the app shell).
      { path: "setup", element: <SetupWizard /> },
      { path: "setup/:step", element: <SetupWizard /> },
      {
        element: <App />, // App contains the Navbar/Header + <Outlet />
        children: [
          { index: true, element: <Dashboard /> },
          { path: "Dashboard", element: <Dashboard /> },
          {
            element: <RequireModule module="nonconformance" />,
            children: [
            { path: "Non-Conformance", element: <NcDashboard /> },
            { path: "Non-Conformance/:type", element: <NonConformance /> },
            { path: "Non-Conformance/:type/:id", element: <NcrPage /> },
            ],
          },
          {
            element: <RequireModule module="calibration" />,
            children: [
            { path: "Calibration", element: <CalibrationDashboard /> },
            { path: "Calibration/Gauges", element: <GaugeRegister /> },
            { path: "Calibration/Gauges/:id", element: <GaugePage key="gauge" /> },
            { path: "Calibration/Gauges/:gaugeId/calibrations/:calibrationId", element: <CalibrationRecordPage /> },
            ],
          },
          {
            path: "Settings",
            element: <Settings />,
            children: [
              { index: true, element: <Navigate to="Organisation" replace /> },
              { path: "Organisation", element: <SettingsOrganisation /> },
              { path: "Users", element: <SettingsUsers /> },
              { path: "General", element: <Navigate to="../Organisation" replace /> },
              { path: "Subscription", element: <SettingsSubscription /> },
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
              { path: "Process-Control", element: <SettingsProcessControl /> },
              {
                path: "Notifications",
                element: <SettingsNotifications />,
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
          {
            element: <RequireModule module="control_plans" />,
            children: [
            { path: "Process-Control", element: <ProcessControlDashboard /> },
            { path: "Process-Control/Plans", element: <ControlPlansPage /> },
            { path: "Process-Control/SPC", element: <SpcPage /> },
            { path: "Process-Control/Analysis", element: <AnalysisPage /> },
            { path: "Process-Control/Alerts", element: <AlertsPage /> },
            { path: "CAPA", element: <CapaRegisterPage /> },
            { path: "CAPA/My-Actions", element: <MyActionsPage /> },
            { path: "CAPA/:id", element: <CapaPage /> },
            { path: "CAPA/:id/report", element: <CapaReportPage /> },
            { path: "CAPA/:id/:step", element: <CapaPage /> },
            { path: "Documentation/My-Alerts", element: <MyAlertsPage /> },
            { path: "Documentation/Quality-Alerts", element: <QualityAlertsPage /> },
            { path: "Documentation/Quality-Alerts/new", element: <QualityAlertForm /> },
            { path: "Documentation/Quality-Alerts/:id", element: <QualityAlertPage /> },
            { path: "Documentation/Quality-Alerts/:id/edit", element: <QualityAlertForm /> },
            { path: "Process-Control/Plans/:id", element: <ControlPlanPage /> },
            { path: "Process-Control/Plans/:planId/revisions/:revisionId", element: <RevisionPage /> },
            ],
          },
          {
            element: <RequireModule module="inspections" />,
            children: [
            { path: "Inspections", element: <InspectionsPage /> },
            { path: "Inspections/new", element: <StartInspectionPage /> },
            { path: "Inspections/:id", element: <InspectionPage /> },
            ],
          },
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
                      <div className="h-screen bg-primary-bg"><LoadingScreen fullscreen /></div>
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
