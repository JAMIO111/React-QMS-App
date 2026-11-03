import { useState } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { AtSignIcon } from "@/components/icons";
import { requestPasswordReset } from "../../authService";
import { AuthCard, AuthNotice, authButtonClass, authInputClass } from "./AuthCard";

const ForgotPassword = () => {
  const [sentTo, setSentTo] = useState(null);
  const [failure, setFailure] = useState(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm();

  const submit = async ({ email }) => {
    setFailure(null);
    try {
      await requestPasswordReset(email.trim());
      setSentTo(email.trim());
    } catch (error) {
      // Rate limits and outages are worth telling; "no such user" is never reported by Supabase.
      setFailure(error?.status === 429 ? "Too many requests. Please wait a minute and try again." : "We couldn't send the email. Please try again.");
    }
  };

  return (
    <AuthCard title="Reset your password" subtitle="Enter your account email and we'll send you a link to choose a new password.">
      {sentTo ? (
        <AuthNotice>
          If an account exists for <strong>{sentTo}</strong>, you'll get an email with a link shortly. The link can be used
          once and expires after a while. Check your spam folder if it doesn't arrive.
        </AuthNotice>
      ) : (
        <form onSubmit={handleSubmit(submit)} className="flex w-full flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1">
            <label htmlFor="reset-email" className="text-left text-primary-text">
              Email <span className="text-error-color">*</span>
            </label>
            <div className="relative w-full">
              <AtSignIcon className="absolute left-2.5 top-2.5 h-5 w-5 text-secondary-text pointer-events-none" />
              <input
                id="reset-email"
                type="email"
                autoComplete="email"
                placeholder="Enter your email address"
                aria-invalid={errors.email ? true : undefined}
                className={`${authInputClass} pl-10`}
                {...register("email", {
                  required: "Email is required",
                  pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, message: "Enter a valid email address" },
                })}
              />
            </div>
            {errors.email && <p className="text-error-color text-sm">{errors.email.message}</p>}
          </div>
          {failure && <AuthNotice tone="error">{failure}</AuthNotice>}
          <button type="submit" disabled={isSubmitting} className={authButtonClass}>
            {isSubmitting ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
      <Link to="/login" className="text-link-color hover:underline text-sm">
        Back to sign in
      </Link>
    </AuthCard>
  );
};

export default ForgotPassword;
