import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { AtSignIcon } from "@/components/icons";
import { PASSWORD_MIN_LENGTH, passwordProblems, signUp } from "../authService";
import { PRIVACY_URL, TERMS_URL, TERMS_VERSION } from "../lib/terms";
import { AuthCard, AuthNotice, authButtonClass, authInputClass } from "./auth/AuthCard";
import PasswordInput from "./auth/PasswordInput";
import VerifyEmail from "./auth/VerifyEmail";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const Doc = ({ href, children }) =>
  href ? (
    <a href={href} target="_blank" rel="noreferrer" className="text-link-color underline">
      {children}
    </a>
  ) : (
    <span className="font-medium">{children}</span>
  );

/** What went wrong, in words a person can act on (never whether an address is already registered: that case looks like success). */
const describeFailure = (error) => {
  const message = error?.message ?? "";
  if (error?.status === 429 || /rate limit|too many/i.test(message)) return "Too many attempts. Please wait a few minutes and try again.";
  if (/password/i.test(message) && /(weak|short|least|pwned|breach|common|leaked)/i.test(message)) return message;
  if (/valid email|invalid email/i.test(message)) return "Enter a valid email address.";
  if (/signups? (are )?(disabled|not allowed)/i.test(message)) return "Sign-up is not available right now. Please contact us.";
  return "We couldn't create your account. Please check your details and try again.";
};

/** Step one of getting started: create the account. The organisation, the subscription and the set-up come after the email is verified. */
const SignUp = () => {
  const navigate = useNavigate();
  const [sentTo, setSentTo] = useState(null);
  const [failure, setFailure] = useState(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm({ defaultValues: { firstName: "", surname: "", email: "", password: "", terms: false } });

  const email = watch("email");
  const password = watch("password");
  const problems = password ? passwordProblems(password, EMAIL.test(email ?? "") ? email : "") : [];

  const submit = async (values) => {
    setFailure(null);
    try {
      const result = await signUp(values.email.trim(), values.password, { firstName: values.firstName.trim(), surname: values.surname.trim(), termsVersion: TERMS_VERSION });
      if (!result.confirmationSent) navigate("/Dashboard"); // a project that does not require verification
      else setSentTo(values.email.trim());
    } catch (error) {
      setFailure(describeFailure(error));
    }
  };

  if (sentTo) {
    return (
      <AuthCard title="Check your email" subtitle="One more step before you can sign in.">
        <VerifyEmail email={sentTo} onChangeEmail={() => setSentTo(null)} />
        <Link to="/login" className="text-link-color hover:underline text-sm">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your account" subtitle="Start using Fortress QMS with your work email. You'll set up your organisation next.">
      <form onSubmit={handleSubmit(submit)} className="flex w-full flex-col gap-4" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="signup-first" className="text-left text-primary-text">
              First name <span className="text-error-color">*</span>
            </label>
            <input id="signup-first" autoComplete="given-name" aria-invalid={errors.firstName ? true : undefined} className={authInputClass} {...register("firstName", { required: "Enter your first name", maxLength: { value: 100, message: "Too long" } })} />
            {errors.firstName && <p className="text-error-color text-sm">{errors.firstName.message}</p>}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="signup-surname" className="text-left text-primary-text">
              Surname <span className="text-error-color">*</span>
            </label>
            <input id="signup-surname" autoComplete="family-name" aria-invalid={errors.surname ? true : undefined} className={authInputClass} {...register("surname", { required: "Enter your surname", maxLength: { value: 100, message: "Too long" } })} />
            {errors.surname && <p className="text-error-color text-sm">{errors.surname.message}</p>}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="signup-email" className="text-left text-primary-text">
            Work email <span className="text-error-color">*</span>
          </label>
          <div className="relative w-full">
            <AtSignIcon className="absolute left-2.5 top-2.5 h-5 w-5 text-secondary-text pointer-events-none" />
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              aria-invalid={errors.email ? true : undefined}
              className={`${authInputClass} pl-10`}
              {...register("email", { required: "Email is required", pattern: { value: EMAIL, message: "Enter a valid email address" } })}
            />
          </div>
          {errors.email && <p className="text-error-color text-sm">{errors.email.message}</p>}
        </div>

        <div className="flex flex-col gap-2">
          <PasswordInput
            label="Password"
            autoComplete="new-password"
            error={errors.password?.message}
            {...register("password", { required: "Choose a password", validate: (v) => passwordProblems(v, EMAIL.test(email ?? "") ? email : "").length === 0 || "Your password does not meet the rules below" })}
          />
          <ul aria-label="Password rules" className="flex flex-col gap-0.5 text-sm text-secondary-text">
            {[
              [`At least ${PASSWORD_MIN_LENGTH} characters`, (password ?? "").length >= PASSWORD_MIN_LENGTH],
              ["A letter and a number", /[A-Za-z]/.test(password ?? "") && /[0-9]/.test(password ?? "")],
              ["Not your email name", !problems.includes("Must not contain your email name")],
            ].map(([rule, ok]) => (
              <li key={rule} className={password && ok ? "text-success-color" : ""}>
                {password && ok ? "✓" : "•"} {rule}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-1">
          <label className="flex items-start gap-2 text-sm text-primary-text">
            <input type="checkbox" className="mt-1" aria-invalid={errors.terms ? true : undefined} {...register("terms", { validate: (v) => v || "You need to accept the terms to create an account" })} />
            <span>
              I agree to the <Doc href={TERMS_URL}>Terms of Service</Doc> and have read the <Doc href={PRIVACY_URL}>Privacy Policy</Doc>. <span className="text-error-color">*</span>
            </span>
          </label>
          {errors.terms && <p className="text-error-color text-sm">{errors.terms.message}</p>}
        </div>

        {failure && <AuthNotice tone="error">{failure}</AuthNotice>}
        <button type="submit" disabled={isSubmitting} className={authButtonClass}>
          {isSubmitting ? "Creating your account…" : "Create account"}
        </button>
        <div className="flex flex-row gap-2 text-sm">
          <p className="text-secondary-text">Already have an account?</p>
          <Link to="/login" className="font-medium text-link-color hover:underline">
            Sign in
          </Link>
        </div>
      </form>
    </AuthCard>
  );
};

export default SignUp;
