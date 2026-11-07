import { useEffect, useState } from "react";
import { MailIcon } from "@/components/icons";
import { resendVerification } from "../../authService";
import { AuthNotice } from "./AuthCard";

const COOLDOWN_SECONDS = 60;

/**
 * "Check your email": shown after sign-up (and from the sign-in page when an account is not verified yet). Resend is rate limited here and by Supabase;
 * `onChangeEmail` returns to the form for a mistyped address.
 */
const VerifyEmail = ({ email, onChangeEmail, startCooldown = true }) => {
  const [seconds, setSeconds] = useState(startCooldown ? COOLDOWN_SECONDS : 0);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState(null); // "sent" | "limited" | "failed"

  useEffect(() => {
    if (seconds <= 0) return undefined;
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);

  const resend = async () => {
    setSending(true);
    setOutcome(null);
    try {
      await resendVerification(email);
      setOutcome("sent");
      setSeconds(COOLDOWN_SECONDS);
    } catch (error) {
      setOutcome(error?.status === 429 || /rate limit|too many/i.test(error?.message ?? "") ? "limited" : "failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-4" aria-live="polite">
      <div className="flex items-start gap-3 rounded-lg border border-border-color bg-tertiary-bg p-4 text-primary-text">
        <MailIcon className="mt-0.5 h-6 w-6 shrink-0 text-brand-primary" aria-hidden="true" />
        <div className="flex flex-col gap-1 text-sm">
          <p>
            We sent a verification link to <strong>{email}</strong>.
          </p>
          <p className="text-secondary-text">Open it to confirm your address, then sign in. The link works once and expires after a while. Check your spam folder if it doesn&apos;t arrive.</p>
        </div>
      </div>
      {outcome === "sent" && <AuthNotice>Verification email sent again.</AuthNotice>}
      {outcome === "limited" && <AuthNotice tone="error">Too many emails requested. Please wait a few minutes and try again.</AuthNotice>}
      {outcome === "failed" && <AuthNotice tone="error">We couldn&apos;t send the email. Please try again.</AuthNotice>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <button type="button" onClick={resend} disabled={sending || seconds > 0} className="font-medium text-link-color hover:underline disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer">
          {sending ? "Sending…" : seconds > 0 ? `Resend the email (${seconds}s)` : "Resend the email"}
        </button>
        {onChangeEmail && (
          <button type="button" onClick={onChangeEmail} className="text-secondary-text underline hover:text-primary-text cursor-pointer">
            Wrong address? Start again
          </button>
        )}
      </div>
    </div>
  );
};

export default VerifyEmail;
