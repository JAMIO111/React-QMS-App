import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signUp } from "../authService";
import { IoEyeOutline, IoEyeOffOutline } from "react-icons/io5";
import { useForm } from "react-hook-form";
import { useToast } from "@/contexts/ToastProvider";
import { CiAt } from "react-icons/ci";
import { CiLock } from "react-icons/ci";

const SignUp = () => {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm();

  const handleSignUp = async (data) => {
    setLoading(true);
    const { email, password } = data;
    try {
      const { user, error } = await signUp(email, password, showToast);
      if (error) {
        alert(error.message);
      } else {
        console.log("User signed up:", user);
        setMessage(
          "Account created successfully! Please check your email to verify your account."
        );
        setTimeout(() => {
          navigate("/login");
        }, 5000); // Redirect after 5 seconds
      }
    } catch (err) {
      alert("Unexpected error: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-start justify-center h-full w-120 p-10 gap-6">
      <img
        src="/Logo-black-on-yellow.png"
        alt="Logo"
        className="w-14 absolute top-5 left-5 rounded-lg mb-4 border border-primary-text/50"
      />
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl text-left text-primary-text font-semibold">
          Getting Started!
        </h1>
        <h2 className="text-left text-md font-light text-secondary-text">
          Enter an email and password to create an account.
        </h2>
      </div>
      <form
        onSubmit={handleSubmit(handleSignUp)}
        className="flex w-full flex-col gap-2">
        <div className="flex relative flex-col gap-1">
          <label className="text-left text-primary-text">
            Email <span className="text-error-color">*</span>
          </label>
          <div className="w-full relative">
            <CiAt className="absolute left-2 top-2 text-secondary-text w-6 h-6" />
            <input
              {...register("email", {
                required: "Email is required",
                pattern: {
                  value: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
                  message: "Invalid email address",
                },
              })}
              type="text"
              placeholder="Enter your email address"
              className="w-full pl-10 border text-primary-text border-border-color h-10 hover:border-border-dark-color p-2 bg-text-input-color rounded-lg focus-within:border-brand-primary focus-within:hover:border-brand-primary"
            />
          </div>
          {errors.email ? (
            <p className="text-error-color text-xs">{errors.email.message}</p>
          ) : (
            <div className="h-4 w-full"></div>
          )}
        </div>
        <div className="flex relative flex-col gap-1">
          <label className="text-left text-primary-text">
            Password <span className="text-error-color">*</span>
          </label>
          <div className="w-full relative">
            <CiLock className="absolute left-2 top-2 text-secondary-text w-6 h-6" />
            <input
              {...register("password", {
                required: "Password is required",
                minLength: {
                  value: 8,
                  message: "Password must be at least 8 characters",
                },
                maxLength: {
                  value: 64,
                  message: "Password must be less than 64 characters",
                },
                pattern: {
                  value: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/,
                  message:
                    "Password must include uppercase, lowercase, a number, and a special character",
                },
              })}
              type={showPassword ? "text" : "password"}
              placeholder="Enter password"
              className="border w-full pl-10 text-primary-text border-border-color h-10 hover:border-border-dark-color p-2 bg-text-input-color rounded-lg focus-within:border-brand-primary focus-within:hover:border-brand-primary"
            />
          </div>
          {errors.password ? (
            <p className="text-error-color text-xs">
              {errors.password.message}
            </p>
          ) : (
            <div className="h-4 w-full"></div>
          )}
          <button
            type="button"
            className="cursor-pointer"
            onMouseDown={() => setShowPassword(true)}
            onMouseUp={() => setShowPassword(false)}
            onMouseLeave={() => setShowPassword(false)}>
            {showPassword ? (
              <IoEyeOutline className="text-secondary-text w-5 h-5 absolute right-5 top-9.5" />
            ) : (
              <IoEyeOffOutline className="text-secondary-text w-5 h-5 absolute right-5 top-9.5" />
            )}
          </button>
        </div>
        <div className="flex relative flex-col gap-1">
          <label className="text-left text-primary-text">
            Confirm Password <span className="text-error-color">*</span>
          </label>
          <div className="w-full relative">
            <CiLock className="absolute left-2 top-2 text-secondary-text w-6 h-6" />
            <input
              {...register("confirmPassword", {
                required: "Confirm your password",
                validate: (value) =>
                  value === watch("password") || "Passwords do not match",
              })}
              type={showConfirmPassword ? "text" : "password"}
              placeholder="Confirm password"
              className="w-full pl-10 border text-primary-text border-border-color h-10 hover:border-border-dark-color p-2 bg-text-input-color rounded-lg focus-within:border-brand-primary focus-within:hover:border-brand-primary"
            />
          </div>
          {errors.confirmPassword ? (
            <p className="text-error-color text-xs">
              {errors.confirmPassword.message}
            </p>
          ) : (
            <div className="h-4 w-full"></div>
          )}
          <button
            type="button"
            className="cursor-pointer"
            onMouseDown={() => setShowConfirmPassword(true)}
            onMouseUp={() => setShowConfirmPassword(false)}
            onMouseLeave={() => setShowConfirmPassword(false)}>
            {showConfirmPassword ? (
              <IoEyeOutline className="text-secondary-text w-5 h-5 absolute right-5 top-9.5" />
            ) : (
              <IoEyeOffOutline className="text-secondary-text w-5 h-5 absolute right-5 top-9.5" />
            )}
          </button>
        </div>
        <button
          type="submit"
          disabled={loading}
          className={`bg-cta-btn-bg border border-cta-btn-border hover:border-cta-btn-border-hover hover:bg-cta-btn-bg-hover text-primary-text p-2 rounded-lg cursor-pointer text-lg ${
            loading ? "opacity-50 cursor-not-allowed" : ""
          }`}>
          {loading ? "Signing up..." : "Sign Up"}
        </button>
        {message && <p className="text-success-color text-md">{message}</p>}
        <div className="flex flex-row gap-2 text-sm">
          <p className="text-primary-text font-semibold">
            Already have an account?
          </p>
          <Link
            to="/login"
            className={`text-link-color underline ${
              loading ? "pointer-events-none opacity-50" : ""
            }`}>
            Login here.
          </Link>
        </div>
      </form>
    </div>
  );
};

export default SignUp;
