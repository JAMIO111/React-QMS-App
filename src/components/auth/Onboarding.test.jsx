import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const signUpFn = vi.fn();
const signInFn = vi.fn();
const resendFn = vi.fn();
vi.mock("../../supabase-client", () => ({ default: {}, initialAuthLinkError: null }));
vi.mock("../../authService", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, signUp: (...a) => signUpFn(...a), signIn: (...a) => signInFn(...a), resendVerification: (...a) => resendFn(...a) };
});

import SignUp from "../SignUp";
import Login from "../Login";
import VerifyEmail from "./VerifyEmail";
import { TERMS_VERSION } from "../../lib/terms";

const renderAt = (url, routes) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        {routes}
        <Route path="/Dashboard" element={<p>dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  );

const fill = async (overrides = {}) => {
  const v = { first: "Ada", surname: "Owner", email: "ada@acme.test", password: "a-long-password-1", terms: true, ...overrides };
  if (v.first) await userEvent.type(screen.getByLabelText(/First name/), v.first);
  if (v.surname) await userEvent.type(screen.getByLabelText(/Surname/), v.surname);
  if (v.email) await userEvent.type(screen.getByLabelText(/Work email/), v.email);
  if (v.password) await userEvent.type(screen.getByLabelText(/^Password/, { selector: "input" }), v.password);
  if (v.terms) await userEvent.click(screen.getByRole("checkbox"));
};

beforeEach(() => {
  signUpFn.mockReset();
  signInFn.mockReset();
  resendFn.mockReset();
});

describe("sign-up", () => {
  it("asks for the name, a valid email, a password that meets the rules and the terms", async () => {
    renderAt("/signup", <Route path="/signup" element={<SignUp />} />);
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Enter your first name")).toBeInTheDocument();
    expect(screen.getByText("Enter your surname")).toBeInTheDocument();
    expect(screen.getByText("Email is required")).toBeInTheDocument();
    expect(screen.getByText("Choose a password")).toBeInTheDocument();
    expect(screen.getByText("You need to accept the terms to create an account")).toBeInTheDocument();
    expect(signUpFn).not.toHaveBeenCalled();
  });

  it("shows which password rules are met as you type, and refuses a weak password", async () => {
    renderAt("/signup", <Route path="/signup" element={<SignUp />} />);
    const rules = screen.getByRole("list", { name: "Password rules" });
    await userEvent.type(screen.getByLabelText(/^Password/, { selector: "input" }), "short1");
    expect(within(rules).getByText(/At least 10 characters/).textContent).toMatch(/^•/);
    await userEvent.type(screen.getByLabelText(/^Password/, { selector: "input" }), "-enough-now");
    expect(within(rules).getByText(/At least 10 characters/).textContent).toMatch(/^✓/);
    await userEvent.clear(screen.getByLabelText(/^Password/, { selector: "input" }));
    await fill({ password: "weakpass" , terms: true});
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Your password does not meet the rules below")).toBeInTheDocument();
    expect(signUpFn).not.toHaveBeenCalled();
  });

  it("sends the name and the accepted terms version, then asks the person to check their email", async () => {
    signUpFn.mockResolvedValue({ user: { id: "u1" }, confirmationSent: true });
    renderAt("/signup", <Route path="/signup" element={<SignUp />} />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(signUpFn).toHaveBeenCalledWith("ada@acme.test", "a-long-password-1", { firstName: "Ada", surname: "Owner", termsVersion: TERMS_VERSION }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByText("ada@acme.test")).toBeInTheDocument();
  });

  it("goes straight in when the project does not need email verification", async () => {
    signUpFn.mockResolvedValue({ user: { id: "u1" }, session: {}, confirmationSent: false });
    renderAt("/signup", <Route path="/signup" element={<SignUp />} />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  it("explains a rate limit and a refused address in words, never with an alert", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    signUpFn.mockRejectedValueOnce(Object.assign(new Error("email rate limit exceeded"), { status: 429 }));
    renderAt("/signup", <Route path="/signup" element={<SignUp />} />);
    await fill();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
    signUpFn.mockRejectedValueOnce(new Error("something odd"));
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("We couldn't create your account"));
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it("lets a person with a mistyped address start again", async () => {
    signUpFn.mockResolvedValue({ user: { id: "u1" }, confirmationSent: true });
    renderAt("/signup", <Route path="/signup" element={<SignUp />} />);
    await fill({ email: "ada@acme.tset" });
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await userEvent.click(await screen.findByRole("button", { name: "Wrong address? Start again" }));
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
  });
});

describe("check your email", () => {
  it("resends, says so, and makes the person wait before sending again", async () => {
    resendFn.mockResolvedValue(true);
    render(<VerifyEmail email="ada@acme.test" startCooldown={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Resend the email" }));
    expect(await screen.findByText("Verification email sent again.")).toBeInTheDocument();
    expect(resendFn).toHaveBeenCalledWith("ada@acme.test");
    expect(screen.getByRole("button", { name: /Resend the email \(60s\)/ })).toBeDisabled();
  });

  it("explains a rate limit and a failure", async () => {
    resendFn.mockRejectedValueOnce(Object.assign(new Error("rate limit"), { status: 429 }));
    const { unmount } = render(<VerifyEmail email="ada@acme.test" startCooldown={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Resend the email" }));
    expect(await screen.findByText(/Too many emails requested/)).toBeInTheDocument();
    unmount();
    resendFn.mockRejectedValueOnce(new Error("boom"));
    render(<VerifyEmail email="ada@acme.test" startCooldown={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Resend the email" }));
    expect(await screen.findByText(/couldn't send the email/)).toBeInTheDocument();
  });

  it("starts with a wait after sign-up, so the first email is not sent twice", () => {
    render(<VerifyEmail email="ada@acme.test" />);
    expect(screen.getByRole("button", { name: /Resend the email \(60s\)/ })).toBeDisabled();
  });
});

describe("sign-in with an unverified account", () => {
  it("says the address is not verified and offers to resend, instead of an alert", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    signInFn.mockRejectedValue(Object.assign(new Error("Email not confirmed"), { code: "email_not_confirmed" }));
    renderAt("/login", <Route path="/login" element={<Login />} />);
    await userEvent.type(screen.getByLabelText(/^Email/), "ada@acme.test");
    await userEvent.type(screen.getByLabelText(/^Password/, { selector: "input" }), "whatever-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/has not been verified yet/)).toBeInTheDocument();
    resendFn.mockResolvedValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Resend the email" }));
    await waitFor(() => expect(resendFn).toHaveBeenCalledWith("ada@acme.test"));
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it("a wrong password is still a plain message", async () => {
    signInFn.mockRejectedValue(new Error("Invalid login credentials"));
    renderAt("/login", <Route path="/login" element={<Login />} />);
    await userEvent.type(screen.getByLabelText(/^Email/), "ada@acme.test");
    await userEvent.type(screen.getByLabelText(/^Password/, { selector: "input" }), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });
});
