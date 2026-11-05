import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../contexts/AuthProvider";
import { useMe } from "../../hooks/useQmsApi";
import { signOut } from "../../authService";
import { describeMfaError, verifiedTotpFactors, verifyCode } from "../../lib/mfa";
import { AuthCard, AuthNotice } from "../auth/AuthCard";
import CodeForm from "./CodeForm";
import EnrolAuthenticator from "./EnrolAuthenticator";
import LoadingScreen from "../ui/LoadingScreen";

/** Only same-site paths, so ?next= cannot send people to another website. */
export const safeNext = (value) => (value && value.startsWith("/") && !value.startsWith("//") ? value : "/Dashboard");

/**
 * Second sign-in step. With an authenticator app already set up: ask for the code. Without one,
 * when an organisation requires two-factor: set one up now.
 */
const MfaPage = () => {
  const { user, assurance, refreshAssurance } = useAuth();
  const me = useMe();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [factors, setFactors] = useState(undefined);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    verifiedTotpFactors()
      .then((f) => active && setFactors(f))
      .catch((err) => active && setLoadError(describeMfaError(err)));
    return () => {
      active = false;
    };
  }, [user]);

  if (user === null) return <Navigate to="/login" replace />;
  if (user === undefined || assurance === undefined) {
    return (
      <AuthCard title="Two-factor authentication">
        <LoadingScreen size="sm" />
      </AuthCard>
    );
  }
  if (assurance?.currentLevel === "aal2") return <Navigate to={next} replace />;

  const complete = async () => {
    await refreshAssurance({});
    // Data hidden from the password-only session is visible now.
    await queryClient.invalidateQueries({ queryKey: ["api"] });
    await queryClient.invalidateQueries({ queryKey: ["memberships"] });
    navigate(next, { replace: true });
  };

  const requiredBy = me.data?.mfa?.requiredBy ?? [];
  const signOutLink = (
    <button
      type="button"
      onClick={async () => {
        await signOut();
        navigate("/login", { replace: true });
      }}
      className="text-sm text-link-color hover:underline cursor-pointer">
      Sign out
    </button>
  );

  if (loadError) {
    return (
      <AuthCard title="Two-factor authentication">
        <AuthNotice tone="error">{loadError}</AuthNotice>
        {signOutLink}
      </AuthCard>
    );
  }
  if (factors === undefined) {
    return (
      <AuthCard title="Two-factor authentication">
        <LoadingScreen size="sm" />
      </AuthCard>
    );
  }

  if (factors.length > 0) {
    return (
      <AuthCard title="Enter your code" subtitle={`Open your authenticator app and enter the code for ${user.email}.`}>
        <CodeForm submitLabel="Continue" describeError={describeMfaError} onSubmit={async (code) => {
          await verifyCode(factors[0].id, code);
          await complete();
        }} />
        {signOutLink}
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set up two-factor authentication"
      subtitle={
        requiredBy.length
          ? `${requiredBy.map((o) => o.name).join(", ")} requires two-factor authentication. It takes about a minute.`
          : "Add an authenticator app to protect your account."
      }>
      <EnrolAuthenticator onDone={complete} />
      {signOutLink}
    </AuthCard>
  );
};

export default MfaPage;
