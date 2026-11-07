import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signIn } from "../authService";
import { AtSignIcon, EyeIcon, EyeOffIcon, LockIcon } from "@/components/icons";
import { useForm } from "react-hook-form";
import { AuthNotice, authButtonClass } from "./auth/AuthCard";
import VerifyEmail from "./auth/VerifyEmail";

const Login = () => {
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [unverifiedEmail, setUnverifiedEmail] = useState(null);
  const navigate = useNavigate(null);
  const [loading, setLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm();

  const handleLogin = async (data) => {
    setLoading(true);
    setMessage("");
    setUnverifiedEmail(null);
    const { email, password } = data;
    try {
      await signIn(email, password);
      navigate("/Dashboard"); // Redirect to Dashboard on successful login
    } catch (error) {
      if (error.message.includes("Invalid login credentials")) {
        setMessage("Invalid email or password. Please try again.");
      } else if (/email not confirmed/i.test(error.message) || error.code === "email_not_confirmed") {
        setUnverifiedEmail(email.trim());
      } else if (error.status === 429 || /rate limit|too many/i.test(error.message)) {
        setMessage("Too many attempts. Please wait a few minutes and try again.");
      } else {
        setMessage("We couldn't sign you in. Please try again.");
      }
    } finally {
      setLoading(false); // Always stop loading
    }
  };

  return (
    <div className="flex w-full flex-col items-start justify-center gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl text-left text-primary-text font-semibold">Welcome back</h1>
        <p className="text-left text-md text-secondary-text">Sign in to Fortress QMS with your work email.</p>
      </div>
      <form
        onSubmit={handleSubmit(handleLogin)}
        className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="login-email" className="text-left text-sm font-medium text-primary-text">
            Email <span className="text-error-color">*</span>
          </label>
          <div className="w-full relative">
            <AtSignIcon className="absolute left-2 top-2 text-secondary-text w-6 h-6" />
            <input
              {...register("email", {
                required: "Email is required",
                pattern: {
                  value: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
                  message: "Invalid email address",
                },
              })}
              id="login-email"
              type="email"
              autoComplete="username"
              placeholder="you@company.com"
              className="border pl-10 w-full text-primary-text placeholder:text-secondary-text border-border-color hover:border-border-dark-color p-2 text-sm bg-text-input-color rounded-lg focus-within:border-brand-primary focus-within:hover:border-brand-primary"
            />
          </div>
          {errors.email && (
            <p className="text-error-color text-sm">{errors.email.message}</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="login-password" className="text-left text-sm font-medium text-primary-text">
            Password <span className="text-error-color">*</span>
          </label>
          <div className="w-full relative">
            <LockIcon className="absolute left-2 top-2 text-secondary-text w-6 h-6" />
            <input
              {...register("password", {
                required: "Password is required",
              })}
              id="login-password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Enter your password"
              className="pl-10 pr-10 w-full border border-border-color text-primary-text placeholder:text-secondary-text hover:border-border-dark-color p-2 text-sm bg-text-input-color rounded-lg focus-within:border-brand-primary focus-within:hover:border-brand-primary"
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute right-2 top-1.5 rounded-md p-1 text-secondary-text hover:text-primary-text cursor-pointer"
              onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? <EyeOffIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
            </button>
          </div>
          <div>
            <div className="flex flex-row justify-between items-center">
              {errors.password && (
                <p className="text-error-color text-sm">
                  {errors.password.message}
                </p>
              )}
              <Link
                to="/forgot-password"
                className={`${
                  errors.password?.message ? "w-fit" : "w-full text-right"
                } text-link-color hover:underline text-sm ${
                  loading ? "pointer-events-none opacity-50" : ""
                }`}>
                Forgot your password?
              </Link>
            </div>
          </div>
        </div>
        <button
          type="submit"
          disabled={loading}
          className={`mt-2 ${authButtonClass}`}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
        {message && (
          <p role="alert" className="text-error-color text-sm">
            {message}
          </p>
        )}
        {unverifiedEmail && (
          <div className="flex flex-col gap-3">
            <AuthNotice tone="error">Your email address has not been verified yet. Open the link we sent you, then sign in.</AuthNotice>
            <VerifyEmail email={unverifiedEmail} startCooldown={false} />
          </div>
        )}
        <div className="flex flex-row gap-2 text-sm">
          <p className="text-secondary-text">New to Fortress QMS?</p>
          <Link
            to="/signup"
            className={`font-medium text-link-color hover:underline ${
              loading ? "pointer-events-none opacity-50" : ""
            }`}>
            Create an account
          </Link>
        </div>
      </form>
    </div>
  );
};

export default Login;
