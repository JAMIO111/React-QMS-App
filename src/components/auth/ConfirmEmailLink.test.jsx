import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let authUser;
const verifyFn = vi.fn();
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: authUser }) }));
vi.mock("../../supabase-client", () => ({ default: {}, initialAuthLinkError: null }));
vi.mock("../../authService", () => ({ verifyEmailLink: (...a) => verifyFn(...a) }));

import ConfirmEmailLink, { safeNext } from "./ConfirmEmailLink";

const renderAt = (url, props = {}) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/auth/confirm" element={<ConfirmEmailLink linkError={null} {...props} />} />
        <Route path="/set-password" element={<p>set password page</p>} />
        <Route path="/accept-invite" element={<p>accept invite page</p>} />
        <Route path="/forgot-password" element={<p>forgot password page</p>} />
        <Route path="/" element={<p>home</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe("ConfirmEmailLink (where email links land)", () => {
  beforeEach(() => {
    authUser = null;
    verifyFn.mockReset();
  });

  it("does not use the one-time token until the person presses Continue (so a link scanner cannot use it up)", async () => {
    verifyFn.mockResolvedValue();
    renderAt("/auth/confirm?token_hash=abc&type=invite&next=%2Fset-password%3Fmode%3Dinvite");
    expect(screen.getByRole("heading", { name: "You've been invited to Fortress QMS" })).toBeInTheDocument();
    expect(verifyFn).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(verifyFn).toHaveBeenCalledWith("abc", "invite");
    expect(await screen.findByText("set password page")).toBeInTheDocument();
  });

  it("an existing account's sign-in link goes on to the invitation", async () => {
    verifyFn.mockResolvedValue();
    renderAt("/auth/confirm?token_hash=def&type=magiclink&next=%2Faccept-invite");
    await userEvent.click(screen.getByRole("button", { name: "Continue to sign in" }));
    expect(verifyFn).toHaveBeenCalledWith("def", "magiclink");
    expect(await screen.findByText("accept invite page")).toBeInTheDocument();
  });

  it("an expired or used link says so and what to do", async () => {
    verifyFn.mockRejectedValue(Object.assign(new Error("Email link is invalid or has expired"), { code: "otp_expired" }));
    renderAt("/auth/confirm?token_hash=old&type=recovery&next=%2Fset-password%3Fmode%3Dreset");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This link has expired or has already been used.");
    expect(screen.getByRole("link", { name: "Request a new reset link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("an older link that already signed the person in goes straight on", async () => {
    authUser = { id: "u1" };
    renderAt("/auth/confirm?next=%2Faccept-invite");
    expect(await screen.findByText("accept invite page")).toBeInTheDocument();
  });

  it("goes only to addresses inside the app", () => {
    expect(safeNext("/accept-invite")).toBe("/accept-invite");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext(null, "/x")).toBe("/x");
  });
});
