import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthProvider";
import { useMe } from "../hooks/useQmsApi";
import LoadingScreen from "./ui/LoadingScreen";
import FirstSignIn from "./auth/FirstSignIn";
import { isCompanyAccount } from "../lib/sso";

const Loading = () => (
  <LoadingScreen fullscreen />
);

/**
 * Signed-in area. Sends the user to the two-factor step when their account uses an authenticator
 * app but this session has not passed it, or when an organisation they belong to requires
 * two-factor. (The database enforces the requirement regardless; this keeps the app usable.) A first company sign-in is asked for the
 * terms (and a name when the company sent none) before anything else.
 */
const ProtectedRoute = () => {
  const { user, assurance } = useAuth();
  const location = useLocation();
  const me = useMe();

  if (user === undefined || (user && assurance === undefined)) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;

  const here = `${location.pathname}${location.search}`;
  const toMfa = <Navigate to={`/mfa?next=${encodeURIComponent(here)}`} replace />;
  if (assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2") return toMfa;
  if (assurance.currentLevel !== "aal2" && me.data?.mfa?.requiredBy?.length) return toMfa;
  // Someone who first arrived through their company's sign-in has not accepted Fortress's terms yet (docs/sso-plan.md SS10).
  if (isCompanyAccount(user) && me.data && !me.data.profile?.termsAcceptedAt) return <FirstSignIn profile={me.data.profile} />;

  return <Outlet />;
};

export default ProtectedRoute;
