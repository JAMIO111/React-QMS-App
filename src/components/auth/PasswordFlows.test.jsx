import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let authUser;
const resetFn = vi.fn();
const updateFn = vi.fn();
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: authUser }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../supabase-client", () => ({ default: {}, initialAuthLinkError: null }));
vi.mock("../../authService", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, requestPasswordReset: (...a) => resetFn(...a), updatePassword: (...a) => updateFn(...a) };
});

import ForgotPassword from "./ForgotPassword";
import SetPassword from "./SetPassword";
import { passwordProblems } from "../../authService";

const renderAt = (url, element) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/forgot-password" element={element} />
        <Route path="/set-password" element={element} />
        <Route path="/Dashboard" element={<p>dashboard</p>} />
        <Route path="/accept-invite" element={<p>accept invite page</p>} />
        <Route path="/mfa" element={<p>mfa step</p>} />
      </Routes>
    </MemoryRouter>
  );

describe("ForgotPassword", () => {
  beforeEach(() => {
    resetFn.mockReset();
  });

  it("sends the reset email and answers the same way for any address", async () => {
    resetFn.mockResolvedValue();
    renderAt("/forgot-password", <ForgotPassword />);
    await userEvent.type(screen.getByLabelText(/Email/), " someone@example.com ");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(resetFn).toHaveBeenCalledWith("someone@example.com");
    expect(screen.getByRole("status")).toHaveTextContent("If an account exists for someone@example.com");
  });

  it("validates the email before sending", async () => {
    renderAt("/forgot-password", <ForgotPassword />);
    await userEvent.type(screen.getByLabelText(/Email/), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(screen.getByText("Enter a valid email address")).toBeInTheDocument();
    expect(resetFn).not.toHaveBeenCalled();
  });

  it("explains rate limiting", async () => {
    resetFn.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }));
    renderAt("/forgot-password", <ForgotPassword />);
    await userEvent.type(screen.getByLabelText(/Email/), "a@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Too many requests");
  });
});

describe("SetPassword", () => {
  beforeEach(() => {
    updateFn.mockReset();
  });

  it("explains an expired invitation link", () => {
    authUser = null;
    renderAt("/set-password?mode=invite", <SetPassword linkError={{ code: "otp_expired", description: "Email link is invalid or has expired" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This link has expired or has already been used");
    expect(screen.getByRole("alert")).toHaveTextContent("send a new invitation");
  });

  it("offers a new reset link when opened without a session", () => {
    authUser = null;
    renderAt("/set-password?mode=reset", <SetPassword linkError={null} />);
    expect(screen.getByRole("link", { name: "Request a new reset link" })).toHaveAttribute("href", "/forgot-password");
  });

  it("enforces the password rules and matching confirmation", async () => {
    authUser = { email: "jamie@example.com" };
    renderAt("/set-password?mode=invite", <SetPassword linkError={null} />);
    expect(screen.getByRole("heading")).toHaveTextContent("Welcome — set your password");
    await userEvent.type(screen.getByLabelText(/New password/), "short1");
    await userEvent.type(screen.getByLabelText(/Confirm password/), "different1");
    await userEvent.click(screen.getByRole("button", { name: "Set password and continue" }));
    expect(screen.getByText("At least 10 characters")).toBeInTheDocument();
    expect(screen.getByText("The passwords don't match")).toBeInTheDocument();
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("saves the password and continues to the app", async () => {
    authUser = { email: "jamie@example.com" };
    updateFn.mockResolvedValue();
    renderAt("/set-password?mode=reset", <SetPassword linkError={null} />);
    await userEvent.type(screen.getByLabelText(/New password/), "correct horse 42");
    await userEvent.type(screen.getByLabelText(/Confirm password/), "correct horse 42");
    await userEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(updateFn).toHaveBeenCalledWith("correct horse 42");
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("takes an invited person on to see and accept their invitation, not to the app", async () => {
    authUser = { email: "jamie@example.com" };
    updateFn.mockResolvedValue();
    renderAt("/set-password?mode=invite", <SetPassword linkError={null} />);
    await userEvent.type(screen.getByLabelText(/New password/), "correct horse 42");
    await userEvent.type(screen.getByLabelText(/Confirm password/), "correct horse 42");
    await userEvent.click(screen.getByRole("button", { name: "Set password and continue" }));
    expect(await screen.findByText("accept invite page")).toBeInTheDocument();
    expect(screen.queryByText("dashboard")).toBeNull();
  });

  it("sends two-factor users to confirm their code first", async () => {
    authUser = { email: "jamie@example.com" };
    updateFn.mockRejectedValue(Object.assign(new Error("AAL2 required"), { code: "insufficient_aal" }));
    renderAt("/set-password", <SetPassword linkError={null} />);
    await userEvent.type(screen.getByLabelText(/New password/), "correct horse 42");
    await userEvent.type(screen.getByLabelText(/Confirm password/), "correct horse 42");
    await userEvent.click(screen.getByRole("button", { name: "Save new password" }));
    expect(screen.getByText("mfa step")).toBeInTheDocument();
  });

  it("shows and hides the password", async () => {
    authUser = { email: "jamie@example.com" };
    renderAt("/set-password", <SetPassword linkError={null} />);
    const input = screen.getByLabelText(/New password/);
    expect(input).toHaveAttribute("type", "password");
    await userEvent.click(screen.getAllByRole("button", { name: "Show password" })[0]);
    expect(input).toHaveAttribute("type", "text");
  });
});

describe("passwordProblems", () => {
  it("lists what is missing", () => {
    expect(passwordProblems("abc")).toEqual(["At least 10 characters", "At least one number"]);
    expect(passwordProblems("jamie12345678", "jamie@example.com")).toEqual(["Must not contain your email name"]);
    expect(passwordProblems("correct horse 42", "jamie@example.com")).toEqual([]);
  });
});
