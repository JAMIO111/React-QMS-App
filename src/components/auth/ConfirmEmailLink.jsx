import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../contexts/AuthProvider";
import { initialAuthLinkError } from "../../supabase-client";
import { verifyEmailLink } from "../../authService";
import { AuthCard, AuthNotice, authButtonClass } from "./AuthCard";

/**
 * Where every link in a Fortress QMS email lands (invitation, sign-in link, password reset, email confirmation).
 *
 * The link carries a one-time token (`token_hash`), and **the token is only used when the person presses Continue**. Company email security
 * (Microsoft Defender Safe Links, Mimecast, Proofpoint…) opens every link in an email to check it before the person sees it; when the link itself
 * used the token, that check used it up and the person's own click then said "expired or already used". A scanner that opens this page uses
 * nothing.
 *
 * `next` is where to go once signed in (an address inside the app only). A link from an older email that still carries the session in the
 * address (Supabase's own link) is handled too: the person is already signed in and goes straight on.
 */
const COPY = {
  invite: {
    title: "You've been invited to Fortress QMS",
    subtitle: "Continue to set your password and join your team.",
    button: "Continue",
    expired: "Ask the person who invited you to send the invitation again (Settings → Users → Resend).",
  },
  magiclink: {
    title: "Sign in to Fortress QMS",
    subtitle: "Continue to sign in and see what is waiting for you.",
    button: "Continue to sign in",
    expired: "Ask the person who invited you to send the invitation again, or sign in with your password.",
  },
  recovery: {
    title: "Reset your password",
    subtitle: "Continue to choose a new password for your Fortress QMS account.",
    button: "Continue",
    expired: "You can ask for a new reset link below.",
  },
  email: {
    title: "Confirm your email address",
    subtitle: "Continue to confirm your address and start using Fortress QMS.",
    button: "Confirm my email",
    expired: "Sign in and we will offer to send a new confirmation email.",
  },
};
const TYPES = { invite: "invite", magiclink: "magiclink", recovery: "recovery", email: "email", signup: "email" };

/** Only an address inside the app: "/…" but not "//host" or a full URL. */
export const safeNext = (next, fallback = "/") => (typeof next === "string" && /^\/(?!\/)/.test(next) && !next.includes("\\") ? next : fallback);

const ConfirmEmailLink = ({ linkError = initialAuthLinkError }) => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const tokenHash = params.get("token_hash");
  const type = TYPES[params.get("type")] ?? null;
  const next = safeNext(params.get("next"), type === "recovery" ? "/set-password?mode=reset" : type === "invite" ? "/set-password?mode=invite" : "/");
  const copy = COPY[type] ?? COPY.email;
  const [state, setState] = useState("ready"); // ready | working | failed
  const [failure, setFailure] = useState(null);

  // An older link that signed the person in by itself: nothing to press.
  useEffect(() => {
    if (!tokenHash && user) navigate(next, { replace: true });
  }, [tokenHash, user, next, navigate]);

  const confirm = async () => {
    setState("working");
    setFailure(null);
    try {
      await verifyEmailLink(tokenHash, type);
      navigate(next, { replace: true });
    } catch (error) {
      setState("failed");
      setFailure(error);
    }
  };

  if (!tokenHash || !type) {
    if (user === undefined || user) {
      return (
        <AuthCard title="Fortress QMS">
          <p className="text-secondary-text" role="status">
            Checking your link…
          </p>
        </AuthCard>
      );
    }
    return (
      <AuthCard title="This link can't be used">
        <AuthNotice tone="error">
          {linkError ? "This link has expired or has already been used." : "Open this page from the link in your email."} If your company's email
          security checks links, open the newest email and press its button once.
        </AuthNotice>
        <Link to="/login" className="text-link-color hover:underline text-sm">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  const expired = state === "failed" && /expired|invalid|not found|otp/i.test(`${failure?.code ?? ""} ${failure?.message ?? ""}`);
  return (
    <AuthCard title={copy.title} subtitle={copy.subtitle}>
      {state === "failed" && (
        <AuthNotice tone="error">
          {expired ? "This link has expired or has already been used." : "We couldn't confirm this link. Please try again."} {expired && copy.expired}
        </AuthNotice>
      )}
      {state !== "failed" || !expired ? (
        <button type="button" className={authButtonClass} onClick={confirm} disabled={state === "working"} aria-busy={state === "working"}>
          {state === "working" ? "Just a moment…" : copy.button}
        </button>
      ) : null}
      {state === "failed" && type === "recovery" && (
        <Link to="/forgot-password" className="text-link-color hover:underline">
          Request a new reset link
        </Link>
      )}
      <p className="text-sm text-secondary-text">
        This step keeps your link safe: it is only used when you press the button, so email security that checks links can't use it up first.
      </p>
      <Link to="/login" className="text-link-color hover:underline text-sm">
        Back to sign in
      </Link>
    </AuthCard>
  );
};

export default ConfirmEmailLink;
