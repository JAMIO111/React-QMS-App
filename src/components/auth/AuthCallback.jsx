import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthProvider";
import { initialAuthLinkError } from "../../supabase-client";
import { AuthCard, AuthNotice } from "./AuthCard";

/**
 * Where a company sign-in comes back to (docs/sso-plan.md SS2). The Supabase client reads the session from the address by itself; this page
 * waits for it, then goes on into Fortress (where a first company sign-in is asked to accept the terms, and someone with no organisation sees
 * their invitations). An error from the company's sign-in is shown in words.
 */
export default function AuthCallback() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  const failed = initialAuthLinkError;

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    const t = setTimeout(() => setWaitedTooLong(true), 10_000);
    return () => clearTimeout(t);
  }, []);

  if (failed || (waitedTooLong && !user)) {
    return (
      <AuthCard title="You are not signed in" subtitle="Your company's sign-in did not complete.">
        <AuthNotice tone="error">
          {failed?.description ?? "We did not receive a sign-in from your company. Please try again, or ask your administrator."}
        </AuthNotice>
        <div className="flex flex-col gap-2 text-sm">
          <Link to="/sso" className="font-medium text-link-color hover:underline">Try your company sign-in again</Link>
          <Link to="/login" className="font-medium text-link-color hover:underline">Sign in with your email and password</Link>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Signing you in…" subtitle="Finishing your company sign-in.">
      <div role="status" className="text-sm text-secondary-text">One moment.</div>
    </AuthCard>
  );
}
