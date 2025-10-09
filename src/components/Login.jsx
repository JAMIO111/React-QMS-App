import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signIn } from "../authService";
import { IoEyeOutline, IoEyeOffOutline } from "react-icons/io5";
import { useForm } from "react-hook-form";
import { useToast } from "@/contexts/ToastProvider";
import { CiAt } from "react-icons/ci";
import { CiLock } from "react-icons/ci";

const Login = () => {
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const navigate = useNavigate(null);
  const [loading, setLoading] = useState(false);
  const { showToast } = useToast();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm();

  const handleLogin = async (data) => {
    setLoading(true);
    const { email, password } = data;
    try {
      const user = await signIn(email, password, showToast);
      navigate("/Dashboard"); // Redirect to Dashboard on successful login
      console.log("User logged in:", user);
    } catch (error) {
      if (error.message.includes("Invalid login credentials")) {
        setMessage("Invalid email or password. Please try again.");
      } else {
        alert(error.message);
        console.error("Login failed:", error.message);
      }
    } finally {
      setLoading(false); // Always stop loading
    }
  };

  return (
    <div className="flex flex-col items-start justify-center h-full w-fit p-10 gap-6">
      <img
        src="\Logo-black-on-yellow.png"
        alt="Logo"
        className="w-14 h-14 absolute top-5 left-5 rounded-lg mb-4 border border-primary-text/50"
      />
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl text-left text-primary-text font-semibold">
          Welcome back!
        </h1>
        <h2 className="text-left text-md font-light text-secondary-text">
          Enter email and password to access your account.
        </h2>
      </div>
      <form
        onSubmit={handleSubmit(handleLogin)}
        className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-1">
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
              className="border pl-10 w-full text-primary-text placeholder:text-secondary-text border-border-color hover:border-border-dark-color p-2 bg-text-input-color rounded-lg focus-within:border-brand-primary focus-within:hover:border-brand-primary"
            />
          </div>
          {errors.email && (
            <p className="text-error-color text-sm">{errors.email.message}</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-left text-primary-text">
            Password <span className="text-error-color">*</span>
          </label>
          <div className="w-full relative">
            <CiLock className="absolute left-2 top-2 text-secondary-text w-6 h-6" />
            <input
              {...register("password", {
                required: "Password is required",
              })}
              type={showPassword ? "text" : "password"}
              placeholder="Enter password"
              className="pl-10 w-full border border-border-color text-primary-text placeholder:text-secondary-text hover:border-border-dark-color p-2 bg-text-input-color rounded-lg focus-within:border-brand-primary focus-within:hover:border-brand-primary"
            />
            <button
              type="button"
              className="cursor-pointer"
              onMouseDown={() => setShowPassword(true)}
              onMouseUp={() => setShowPassword(false)}
              onMouseLeave={() => setShowPassword(false)}>
              {showPassword ? (
                <IoEyeOutline className="text-secondary-text w-5 h-5 absolute right-5 top-2.5" />
              ) : (
                <IoEyeOffOutline className="text-secondary-text w-5 h-5 absolute right-5 top-2.5" />
              )}
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
          className="bg-cta-btn-bg border border-cta-btn-border hover:border-cta-btn-border-hover hover:bg-cta-btn-bg-hover text-primary-text p-2 rounded-lg cursor-pointer text-lg disabled:opacity-50 disabled:cursor-not-allowed">
          {loading ? "Logging in..." : "Login"}
        </button>
        {message && <p className="text-error-color text-sm">{message}</p>}
        <div className="flex flex-row gap-2 text-sm">
          <p className="font-semibold text-primary-text">
            Don't have an account?
          </p>
          <Link
            to="/signup"
            className={`text-link-color underline ${
              loading ? "pointer-events-none opacity-50" : ""
            }`}>
            Sign Up here.
          </Link>
        </div>
      </form>
    </div>
  );
};

export default Login;
