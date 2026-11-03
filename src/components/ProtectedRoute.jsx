import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthProvider";
import { useMe } from "../hooks/useQmsApi";

const Loading = () => (
  <div role="status" className="flex h-screen items-center justify-center bg-primary-bg text-secondary-text">
    Loading…
  </div>
);

/**
 * Signed-in area. Sends the user to the two-factor step when their account uses an authenticator
 * app but this session has not passed it, or when an organisation they belong to requires
 * two-factor. (The database enforces the requirement regardless; this keeps the app usable.)
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

  return <Outlet />;
};

export default ProtectedRoute;
