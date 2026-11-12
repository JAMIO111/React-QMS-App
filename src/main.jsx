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
import RouteError from "./components/RouteError.jsx";
import { reloadPage, shouldReloadForChunkError } from "./lib/chunkErrors";
import "./index.css";
import { applyStoredThemeColour } from "./lib/theme-colours";

applyStoredThemeColour();

// A page file that cannot be loaded because the app was updated while this tab was open: reload once to get the new version.
window.addEventListener("vite:preloadError", (event) => {
  if (shouldReloadForChunkError()) {
    event.preventDefault();
    reloadPage();
  }
});

const App = lazy(() => import("./App.jsx"));
const NonConformance = lazy(() => import("./components/NonConformance.jsx"));
const Dashboard = lazy(() => import("./components/dashboard/Dashboard.jsx"));
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
const Employees = lazy(() => import("./components/master-data/EmployeesPage.jsx"));
const MasterDataDashboard = lazy(() => import("./components/master-data/MasterDataDashboard.jsx"));
const PartsPage = lazy(() => import("./components/master-data/PartsPage.jsx"));
const LegacyNcrRedirect = lazy(() => import("./components/ncr/LegacyNcrRedirect.jsx"));
const LegacyAuditRedirect = lazy(() => import("./components/audits/LegacyAuditRedirect.jsx"));
const NcrPage = lazy(() => import("./components/ncr/NcrPage.jsx"));
const NcDashboard = lazy(() => import("./components/ncr/NcDashboard.jsx"));
const CalibrationDashboard = lazy(() => import("./components/calibration/CalibrationDashboard.jsx"));
const GaugeRegister = lazy(() => import("./components/calibration/GaugeRegister.jsx"));
const GaugePage = lazy(() => import("./components/calibration/GaugePage.jsx"));
const CalibrationRecordPage = lazy(() => import("./components/calibration/CalibrationRecordPage.jsx"));
const SettingsNotifications = lazy(() => import("./components/Settings/SettingsNotifications.jsx"));
const SettingsSubscription = lazy(() => import("./components/Settings/SettingsSubscription.jsx"));
const RequireModule = lazy(() => import("./components/RequireModule.jsx"));
const PartDetailPage = lazy(() => import("./components/master-data/PartDetailPage.jsx"));
const PartiesPage = lazy(() => import("./components/master-data/PartiesPage.jsx"));
const SuppliersRegisterPage = lazy(() => import("./components/supplier-quality/SuppliersRegisterPage.jsx"));
const SupplierProfilePage = lazy(() => import("./components/supplier-quality/SupplierProfilePage.jsx"));
const AssessmentPage = lazy(() => import("./components/supplier-quality/AssessmentPage.jsx"));
const ExpiryWatchlistPage = lazy(() => import("./components/supplier-quality/ExpiryWatchlistPage.jsx"));
const SupplierDashboard = lazy(() => import("./components/supplier-quality/SupplierDashboard.jsx"));
const CompetenceHome = lazy(() => import("./components/competence/CompetenceHome.jsx"));
const CompetenceDashboard = lazy(() => import("./components/competence/CompetenceDashboard.jsx"));
const CompetenceMatrix = lazy(() => import("./components/competence/MatrixPage.jsx"));
const CompetencePerson = lazy(() => import("./components/competence/PersonPage.jsx"));
const CompetenceTraining = lazy(() => import("./components/competence/TrainingPage.jsx"));
const CompetenceTrainingSession = lazy(() => import("./components/competence/TrainingSessionPage.jsx"));
const MyCompetence = lazy(() => import("./components/competence/MyCompetencePage.jsx"));
const PurchaseOrdersPage = lazy(() => import("./components/supplier-quality/PurchaseOrdersPage.jsx"));
const PurchaseOrderPage = lazy(() => import("./components/supplier-quality/PurchaseOrderPage.jsx"));
const GoodsReceiptsPage = lazy(() => import("./components/supplier-quality/GoodsReceiptsPage.jsx"));
const GoodsReceiptPage = lazy(() => import("./components/supplier-quality/GoodsReceiptPage.jsx"));
const MaterialCertificatesPage = lazy(() => import("./components/supplier-quality/MaterialCertificatesPage.jsx"));
const WatchlistPage = lazy(() => import("./components/supplier-quality/WatchlistPage.jsx"));
const RequirementsPage = lazy(() => import("./components/supplier-quality/RequirementsPage.jsx"));
const ScarsPage = lazy(() => import("./components/supplier-quality/ScarsPage.jsx"));
const ScarPage = lazy(() => import("./components/supplier-quality/ScarPage.jsx"));
const SettingsIntegrations = lazy(() => import("./components/Settings/SettingsIntegrations.jsx"));
const CsvImportWizard = lazy(() => import("./components/integrations/CsvImportWizard.jsx"));
const ImportTemplatesPage = lazy(() => import("./components/integrations/TemplatesPage.jsx"));
const IntegrationReviewPage = lazy(() => import("./components/integrations/ReviewPage.jsx"));
const ImportTemplatePage = lazy(() => import("./components/integrations/TemplatesPage.jsx").then((m) => ({ default: m.TemplatePage })));
const ConnectionPage = lazy(() => import("./components/integrations/ConnectionPage.jsx"));
const IntegrationRunPage = lazy(() => import("./components/integrations/RunPage.jsx"));
const IntegrationMappingPage = lazy(() => import("./components/integrations/MappingPage.jsx"));
const ApiMappingPage = lazy(() => import("./components/integrations/ApiMappingPage.jsx"));
const MachinesPage = lazy(() => import("./components/master-data/MachinesPage.jsx"));
const ProductionOrdersPage = lazy(() => import("./components/production/OrdersPage.jsx"));
const ProductionOrderPage = lazy(() => import("./components/production/OrderPage.jsx"));
const TraceabilityPage = lazy(() => import("./components/production/TraceabilityPage.jsx"));
const AuditsPage = lazy(() => import("./components/audits/AuditsPage.jsx"));
const AuditPage = lazy(() => import("./components/audits/AuditPage.jsx"));
const AuditForm = lazy(() => import("./components/audits/AuditForm.jsx"));
const AuditsDashboard = lazy(() => import("./components/audits/AuditsDashboard.jsx"));
const AuditSchedulePage = lazy(() => import("./components/audits/AuditSchedulePage.jsx"));
const AuditRecordsPage = lazy(() => import("./components/audits/AuditRecordsPage.jsx"));
const AuditRecordPage = lazy(() => import("./components/audits/AuditRecordPage.jsx"));
const AuditFindingsPage = lazy(() => import("./components/audits/AuditFindingsPage.jsx"));
const AuditFindingPage = lazy(() => import("./components/audits/AuditFindingPage.jsx"));
const LotsPage = lazy(() => import("./components/production/LotsPage.jsx"));
const SerialsPage = lazy(() => import("./components/production/SerialsPage.jsx"));
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
const DocumentsPage = lazy(() => import("./components/documents/DocumentsPage.jsx"));
const MyDocumentsPage = lazy(() => import("./components/documents/MyDocumentsPage.jsx"));
const RiskRegisterPage = lazy(() => import("./components/risk/RiskRegisterPage.jsx"));
const RiskPage = lazy(() => import("./components/risk/RiskPage.jsx"));
const RiskDashboard = lazy(() => import("./components/risk/RiskDashboard.jsx"));
const RiskHeatMapPage = lazy(() => import("./components/risk/RiskHeatMapPage.jsx"));
const MyRiskWorkPage = lazy(() => import("./components/risk/MyRiskWorkPage.jsx"));
const ObjectivesPage = lazy(() => import("./components/management-review/ObjectivesPage.jsx"));
const ObjectivePage = lazy(() => import("./components/management-review/ObjectivePage.jsx"));
const ReviewsPage = lazy(() => import("./components/management-review/ReviewsPage.jsx"));
const ReviewPage = lazy(() => import("./components/management-review/ReviewPage.jsx"));
const ReviewReportPage = lazy(() => import("./components/management-review/ReviewReportPage.jsx"));
const MyTasksPage = lazy(() => import("./components/workflows/MyTasksPage.jsx"));
const MyReviewActionsPage = lazy(() => import("./components/management-review/MyReviewActionsPage.jsx"));
const RemindersPage = lazy(() => import("./components/reminders/RemindersPage.jsx"));
const DocumentsDashboard = lazy(() => import("./components/documents/DocumentsDashboard.jsx"));
const ChangeRequestsPage = lazy(() => import("./components/documents/ChangeRequestsPage.jsx"));
const DocumentPage = lazy(() => import("./components/documents/DocumentPage.jsx"));
const DocumentRevisionPage = lazy(() => import("./components/documents/RevisionPage.jsx"));
const QualityAlertPage = lazy(() => import("./components/documentation/QualityAlertPage.jsx"));
const MyAlertsPage = lazy(() => import("./components/documentation/MyAlertsPage.jsx"));
const QualityAlertForm = lazy(() => import("./components/documentation/QualityAlertForm.jsx"));
const CapaRegisterPage = lazy(() => import("./components/capa/CapaRegisterPage.jsx"));
const CapaPage = lazy(() => import("./components/capa/CapaPage.jsx"));
const CapaReportPage = lazy(() => import("./components/capa/CapaReportPage.jsx"));
const MyActionsPage = lazy(() => import("./components/capa/MyActionsPage.jsx"));
const PlatformPage = lazy(() => import("./components/platform/PlatformPage.jsx"));
const SetupWizard = lazy(() => import("./components/onboarding/SetupWizard.jsx"));
const AcceptInvite = lazy(() => import("./components/onboarding/AcceptInvite.jsx"));
const JobPage = lazy(() => import("./components/jobs/JobPage.jsx"));
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
    errorElement: <RouteError />,
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
    errorElement: <RouteError />,
    children: [
      // The operator area spans organisations, so it lives outside <App /> (which needs one) and checks access itself.
      { path: "platform", element: <PlatformPage /> },
      // The owner's first-run wizard is full-screen too (it needs the organisation, not the app shell).
      { path: "setup", element: <SetupWizard /> },
      { path: "setup/:step", element: <SetupWizard /> },
      // The invitee's page: they may belong to no organisation yet.
      { path: "accept-invite", element: <AcceptInvite /> },
      {
        element: <App />, // App contains the Navbar/Header + <Outlet />
        children: [
          { index: true, element: <Dashboard /> },
          { path: "Dashboard", element: <Dashboard /> },
          {
            element: <RequireModule module="nonconformance" />,
            children: [
            { path: "Non-Conformance", element: <NcDashboard /> },
            { path: "Non-Conformance/Register", element: <NonConformance /> },
            { path: "Non-Conformance/Register/:id", element: <NcrPage /> },
            // The three old registers became one; bookmarks and old links still work.
            { path: "Non-Conformance/:type", element: <LegacyNcrRedirect /> },
            { path: "Non-Conformance/:type/:id", element: <LegacyNcrRedirect /> },
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
              { path: "Data-Management", element: <SettingsDataManagement /> },
              // These settings are tabs of Data Management now; the old addresses open the right tab.
              { path: "Calibration", element: <Navigate to="../Data-Management?tab=calibration" replace /> },
              { path: "Process-Control", element: <Navigate to="../Data-Management?tab=process-control" replace /> },
              { path: "Audits", element: <Navigate to="../Data-Management?tab=audits" replace /> },
              { path: "Supplier-Quality", element: <Navigate to="../Data-Management?tab=supplier-quality" replace /> },
              { path: "Integrations", element: <SettingsIntegrations /> },
              { path: "Integrations/csv", element: <CsvImportWizard /> },
              { path: "Integrations/Templates", element: <ImportTemplatesPage /> },
              { path: "Integrations/Review", element: <IntegrationReviewPage /> },
              { path: "Integrations/Templates/:templateId", element: <ImportTemplatePage /> },
              { path: "Integrations/:id", element: <ConnectionPage /> },
              { path: "Integrations/:id/runs/:runId", element: <IntegrationRunPage /> },
              { path: "Integrations/:id/mapping", element: <IntegrationMappingPage /> },
              { path: "Integrations/:id/map", element: <ApiMappingPage /> },
              {
                path: "Notifications",
                element: <SettingsNotifications />,
              },
              { path: "Admin", element: <div>Admin Settings</div> },
            ],
          },
          { path: "Employees", element: <Employees /> },
          // The old Human Resources page now lives under Master Data.
          { path: "Human-Resources", element: <Navigate to="/Employees" replace /> },
          { path: "Master-Data", element: <MasterDataDashboard /> },
          { path: "Parts", element: <PartsPage /> },
          { path: "Parts/:id", element: <PartDetailPage /> },
          { path: "Customers", element: <PartiesPage key="customers" kind="customers" /> },
          { path: "Suppliers", element: <SuppliersRegisterPage /> },
          { path: "Suppliers/:id", element: <SupplierProfilePage /> },
          { path: "Suppliers/:supplierId/assessments/:id", element: <AssessmentPage /> },
          { path: "Supplier-Quality", element: <SupplierDashboard /> },
          { path: "Supplier-Quality/Expiry", element: <ExpiryWatchlistPage /> },
          { path: "Risk", element: <RiskDashboard /> },
          { path: "Risk/Heat-map", element: <RiskHeatMapPage /> },
          { path: "Risk/My-Work", element: <MyRiskWorkPage /> },
          { path: "Management-Review", element: <Navigate to="/Management-Review/Reviews" replace /> },
          { path: "Management-Review/Reviews", element: <ReviewsPage /> },
          { path: "Management-Review/My-Actions", element: <MyReviewActionsPage /> },
          { path: "Reminders", element: <RemindersPage /> },
          { path: "Tasks", element: <MyTasksPage /> },
          { path: "Management-Review/Reviews/:id", element: <ReviewPage /> },
          { path: "Management-Review/Reviews/:id/report", element: <ReviewReportPage /> },
          { path: "Management-Review/Objectives", element: <ObjectivesPage /> },
          { path: "Management-Review/Objectives/:id", element: <ObjectivePage /> },
          { path: "Risk/Register", element: <RiskRegisterPage /> },
          { path: "Risk/Register/:id", element: <RiskPage /> },
          { path: "Competence", element: <CompetenceDashboard /> },
          { path: "Competence/Skills", element: <CompetenceHome /> },
          { path: "Competence/Matrix", element: <CompetenceMatrix /> },
          { path: "Competence/People/:employeeId", element: <CompetencePerson /> },
          { path: "Competence/Training", element: <CompetenceTraining /> },
          { path: "Competence/Training/:id", element: <CompetenceTrainingSession /> },
          { path: "Competence/Mine", element: <MyCompetence /> },
          { path: "Supplier-Quality/Purchase-Orders", element: <PurchaseOrdersPage /> },
          { path: "Supplier-Quality/Purchase-Orders/:id", element: <PurchaseOrderPage /> },
          { path: "Supplier-Quality/Material-Certificates", element: <MaterialCertificatesPage /> },
          { path: "Supplier-Quality/Watchlist", element: <WatchlistPage /> },
          { path: "Supplier-Quality/Inspection-Requirements", element: <RequirementsPage /> },
          { path: "Supplier-Quality/Goods-Receipts", element: <GoodsReceiptsPage /> },
          { path: "Supplier-Quality/Goods-Receipts/:id", element: <GoodsReceiptPage /> },
          { path: "Supplier-Quality/SCARs", element: <ScarsPage /> },
          { path: "Supplier-Quality/SCARs/:id", element: <ScarPage /> },
          { path: "Machines", element: <MachinesPage /> },
          { path: "Production", element: <Navigate to="/Production/Orders" replace /> },
          { path: "Production/Orders", element: <ProductionOrdersPage /> },
          { path: "Production/Orders/:id", element: <ProductionOrderPage /> },
          { path: "Production/Lots", element: <LotsPage /> },
          { path: "Production/Serials", element: <SerialsPage /> },
          { path: "Production/Traceability", element: <TraceabilityPage /> },
          { path: "Audits/Templates", element: <AuditsPage /> },
          { path: "Audits/Templates/new", element: <AuditForm /> },
          { path: "Audits/Templates/:id", element: <AuditPage /> },
          { path: "Audits/Templates/:id/edit", element: <AuditForm /> },
          { path: "Audits", element: <AuditsDashboard /> },
          { path: "Audits/Schedule", element: <AuditSchedulePage /> },
          { path: "Audits/Records", element: <AuditRecordsPage /> },
          { path: "Audits/Records/:id", element: <AuditRecordPage /> },
          { path: "Audits/Findings", element: <AuditFindingsPage /> },
          { path: "Audits/Findings/:id", element: <AuditFindingPage /> },
          // The audit pages used to be under Documentation.
          { path: "Documentation/Audit-Dashboard", element: <LegacyAuditRedirect /> },
          { path: "Documentation/Audit-Schedule", element: <LegacyAuditRedirect /> },
          { path: "Documentation/Audit-Records/*", element: <LegacyAuditRedirect /> },
          { path: "Documentation/Audit-Findings/*", element: <LegacyAuditRedirect /> },
          { path: "Documentation/Audits/*", element: <LegacyAuditRedirect /> },
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
            { path: "Documentation", element: <DocumentsDashboard /> },
            { path: "Documentation/My-Documents", element: <MyDocumentsPage /> },
            { path: "Documentation/Documents", element: <DocumentsPage /> },
            { path: "Documentation/Change-Requests", element: <ChangeRequestsPage /> },
            { path: "Documentation/Documents/:id", element: <DocumentPage /> },
            { path: "Documentation/Documents/:id/revisions/:revisionId", element: <DocumentRevisionPage /> },
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
            { path: "Jobs/:id", element: <JobPage /> },
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
