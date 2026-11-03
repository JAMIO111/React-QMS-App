import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { useAuth } from "../../contexts/AuthProvider";
import { initialAuthLinkError } from "../../supabase-client";
import { PASSWORD_MIN_LENGTH, passwordProblems, updatePassword } from "../../authService";
import { useToast } from "../../contexts/ToastProvider";
import { AuthCard, AuthNotice, authButtonClass } from "./AuthCard";
import PasswordInput from "./PasswordInput";

const describeUpdateError = (error) => {
  const code = error?.code ?? "";
  if (code === "same_password") return "Choose a password you haven't used for this account before.";
  if (code === "weak_password") return error.message || "That password is too weak. Choose a longer one.";
  return "We couldn't save your password. Please try again.";
};

/**
 * Landing page for invitation and password-reset emails. Supabase signs the user in from the link
 * (the session comes from the URL); this page then sets their password.
 */
const SetPassword = ({ linkError = initialAuthLinkError }) => {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const invited = params.get("mode") === "invite";
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [failure, setFailure] = useState(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm({ mode: "onTouched" });

  const title = invited ? "Welcome — set your password" : "Choose a new password";

  if (user === undefined) {
    return (
      <AuthCard title={title}>
        <p className="text-secondary-text" role="status">
          Checking your link…
        </p>
      </AuthCard>
    );
  }

  if (!user) {
    const expired = linkError && /expired|invalid|denied/i.test(`${linkError.code} ${linkError.description ?? ""}`);
    return (
      <AuthCard title={title}>
        <AuthNotice tone="error">
          {expired || linkError
            ? "This link has expired or has already been used."
            : "Open this page from the link in your email."}{" "}
          {invited
            ? "Ask the person who invited you to send a new invitation."
            : "You can request a new link below."}
        </AuthNotice>
        {!invited && (
          <Link to="/forgot-password" className="text-link-color hover:underline">
            Request a new reset link
          </Link>
        )}
        <Link to="/login" className="text-link-color hover:underline text-sm">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  const submit = async ({ password }) => {
    setFailure(null);
    try {
      await updatePassword(password);
      showToast?.({ type: "success", title: "Password saved", message: "You're signed in." });
      navigate("/Dashboard", { replace: true });
    } catch (error) {
      if (error?.code === "insufficient_aal") {
        // The account uses two-factor authentication: confirm the code first, then come back.
        navigate("/mfa?next=/set-password", { replace: true });
        return;
      }
      setFailure(describeUpdateError(error));
    }
  };

  return (
    <AuthCard
      title={title}
      subtitle={invited ? `You've been invited to the QMS as ${user.email}.` : `For ${user.email}.`}>
      <form onSubmit={handleSubmit(submit)} className="flex w-full flex-col gap-4" noValidate>
        <PasswordInput
          label="New password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters, with letters and numbers.`}
          error={errors.password?.message}
          {...register("password", {
            validate: (value) => passwordProblems(value, user.email)[0] ?? true,
          })}
        />
        <PasswordInput
          label="Confirm password"
          error={errors.confirm?.message}
          {...register("confirm", {
            validate: (value) => value === watch("password") || "The passwords don't match",
          })}
        />
        {failure && <AuthNotice tone="error">{failure}</AuthNotice>}
        <button type="submit" disabled={isSubmitting} className={authButtonClass}>
          {isSubmitting ? "Saving…" : invited ? "Set password and continue" : "Save new password"}
        </button>
      </form>
    </AuthCard>
  );
};

export default SetPassword;
