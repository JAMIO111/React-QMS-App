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
import LoadingSpinner from "./components/LoadingSpinner.jsx";
import "./index.css";

const App = lazy(() => import("./App.jsx"));
const Dashboard = lazy(() => import("./components/dashboard/Dashboard.jsx"));
const NonConformance = lazy(() => import("./components/NonConformance.jsx"));
const BookingsDashboard = lazy(() =>
  import("./components/dashboard/BookingsDashboard.jsx")
);
const ClientManagementDashboard = lazy(() =>
  import("./components/dashboard/ClientManagementDashboard.jsx")
);
const Properties = lazy(() => import("./components/Properties.jsx"));
const PropertyForm = lazy(() => import("./components/PropertyForm.jsx"));
const OwnerForm = lazy(() => import("./components/OwnerForm.jsx"));
const Owners = lazy(() => import("./components/Owners.jsx"));
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
const BookingForm = lazy(() => import("./components/BookingForm.jsx"));
const FullScreenCalendar = lazy(() =>
  import("./components/FullScreenCalendar.jsx")
);
const LeadDetails = lazy(() => import("./components/LeadDetails.jsx"));
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
    path: "/", // base path for protected routes
    element: <ProtectedRoute />, // MUST render <Outlet /> inside!
    errorElement: <NotFound />,
    children: [
      {
        element: <App />, // App contains the Navbar/Header + <Outlet />
        children: [
          { index: true, element: <Dashboard /> },
          { path: "Dashboard", element: <Dashboard /> },
          { path: "Bookings", element: <BookingsDashboard /> },
          {
            path: "Bookings/New-Booking",
            element: <BookingForm />,
          },
          {
            path: "Bookings/:id",
            element: <BookingForm />,
          },
          {
            path: "Client-Management",
            element: <ClientManagementDashboard />,
          },
          {
            path: "Client-Management/Properties",
            element: <Properties />,
          },
          {
            path: "Client-Management/Properties/:id",
            element: <PropertyForm />,
          },
          {
            path: "Client-Management/Properties/New-Property",
            element: <PropertyForm />,
          },
          {
            path: "Client-Management/Owners/:id",
            element: <OwnerForm />,
          },
          {
            path: "Client-Management/Owners/New-Owner",
            element: <OwnerForm />,
          },
          {
            path: "Client-Management/Owners",
            element: <Owners />,
          },
          {
            path: "Client-Management/Owners/:id",
            element: <OwnerForm />,
          },
          {
            path: "Client-Management/Leads/:id",
            element: <LeadDetails />,
          },
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
          { path: "Calendar", element: <FullScreenCalendar /> },
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
console.trace("createRoot called");
