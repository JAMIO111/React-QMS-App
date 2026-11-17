import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthProvider";
import { useMe } from "../hooks/useQmsApi";
import LoadingScreen from "./ui/LoadingScreen";
import FirstSignIn from "./auth/FirstSignIn";
import SsoRequired from "./SsoRequired";
import { isCompanyAccount } from "../lib/sso";
import MemberWelcome, { WelcomeShell } from "./onboarding/MemberWelcome";
import SeatWaiting from "./onboarding/SeatWaiting";
import { waitingFor } from "../lib/memberOnboarding";

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
  // Every organisation the person belongs to requires its company sign-in, which this session did not use (docs/sso-plan.md SS6). The
  // two-factor page stays reachable for a break-glass member.
  const ssoRequiredBy = me.data?.sso?.requiredBy ?? [];
  if (ssoRequiredBy.length && !me.data.memberships?.length && !location.pathname.startsWith("/mfa")) return <SsoRequired organisations={ssoRequiredBy} fullPage />;
  // Someone who first arrived through their company's sign-in has not accepted Fortress's terms yet (docs/sso-plan.md SS10).
  if (isCompanyAccount(user) && me.data && !me.data.profile?.termsAcceptedAt) return <FirstSignIn profile={me.data.profile} />;
  // Someone who has just joined an organisation sets up their own profile first (seats plan SM6); without a seat it ends on the waiting screen.
  const welcome = me.data?.welcome ?? [];
  if (welcome.length && !location.pathname.startsWith("/mfa")) {
    return <MemberWelcome key={welcome[0].id} welcome={welcome[0]} wait={waitingFor(me.data, welcome[0].id)} />;
  }
  // Waiting for a seat everywhere they belong (seats plan SM4): nothing else to show until someone gives them one.
  const waitingIn = me.data?.seats?.waitingIn ?? [];
  if (waitingIn.length && !me.data.memberships?.length && !location.pathname.startsWith("/mfa")) {
    return (
      <WelcomeShell>
        <SeatWaiting wait={waitingIn[0]} />
      </WelcomeShell>
    );
  }

  return <Outlet />;
};

export default ProtectedRoute;
