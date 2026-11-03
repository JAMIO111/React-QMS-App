import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let auth;
let me;
const mfa = { verifiedTotpFactors: vi.fn(), verifyCode: vi.fn(), startEnrolment: vi.fn() };
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => auth }));
vi.mock("../../hooks/useQmsApi", () => ({ useMe: () => me }));
vi.mock("../../authService", () => ({ signOut: vi.fn() }));
vi.mock("../../lib/mfa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    verifiedTotpFactors: (...a) => mfa.verifiedTotpFactors(...a),
    verifyCode: (...a) => mfa.verifyCode(...a),
    startEnrolment: (...a) => mfa.startEnrolment(...a),
  };
});
vi.mock("../../supabase-client", () => ({ default: {} }));

import MfaPage, { safeNext } from "./MfaPage";
import ProtectedRoute from "../ProtectedRoute";

const Where = () => {
  const l = useLocation();
  return <p>at {l.pathname + l.search}</p>;
};
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/mfa" element={<MfaPage />} />
          <Route path="/login" element={<Where />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/Dashboard" element={<p>dashboard</p>} />
            <Route path="/Settings/Users" element={<p>users page</p>} />
          </Route>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  Object.values(mfa).forEach((f) => f.mockReset());
  me = { data: { mfa: { level: "aal1", requiredBy: [] } } };
});

describe("ProtectedRoute two-factor gate", () => {
  it("lets a session without two-factor requirements through", () => {
    auth = { user: { id: "u" }, assurance: { currentLevel: "aal1", nextLevel: "aal1" } };
    renderAt("/Dashboard");
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("asks for the code when the account uses an authenticator app", async () => {
    auth = { user: { id: "u", email: "a@b.c" }, assurance: { currentLevel: "aal1", nextLevel: "aal2" } };
    mfa.verifiedTotpFactors.mockResolvedValue([{ id: "f1" }]);
    renderAt("/Settings/Users");
    expect(await screen.findByRole("heading", { name: "Enter your code" })).toBeInTheDocument();
  });

  it("sends members of an organisation that requires two-factor to set it up", async () => {
    auth = { user: { id: "u", email: "a@b.c" }, assurance: { currentLevel: "aal1", nextLevel: "aal1" } };
    me = { data: { mfa: { level: "aal1", requiredBy: [{ id: "o1", name: "Strict Ltd" }] } } };
    mfa.verifiedTotpFactors.mockResolvedValue([]);
    mfa.startEnrolment.mockResolvedValue({ factorId: "new", qrCode: "data:image/svg+xml;base64,PHN2Zy8+", secret: "ABCDEF" });
    renderAt("/Dashboard");
    expect(await screen.findByRole("heading", { name: "Set up two-factor authentication" })).toBeInTheDocument();
    expect(screen.getByText(/Strict Ltd requires two-factor/)).toBeInTheDocument();
    expect(await screen.findByAltText("QR code for your authenticator app")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Can't scan? Show the key" }));
    expect(screen.getByText("ABCDEF")).toBeInTheDocument();
  });

  it("lets a session that passed two-factor through", () => {
    auth = { user: { id: "u" }, assurance: { currentLevel: "aal2", nextLevel: "aal2" } };
    me = { data: { mfa: { level: "aal2", requiredBy: [] } } };
    renderAt("/Dashboard");
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("sends signed-out visitors to sign in", () => {
    auth = { user: null, assurance: null };
    renderAt("/Dashboard");
    expect(screen.getByText("at /login")).toBeInTheDocument();
  });
});

describe("MfaPage", () => {
  it("verifies the code and returns to the page that was asked for", async () => {
    const refreshAssurance = vi.fn(async () => {
      auth = { ...auth, assurance: { currentLevel: "aal2", nextLevel: "aal2" } };
    });
    auth = { user: { id: "u", email: "a@b.c" }, assurance: { currentLevel: "aal1", nextLevel: "aal2" }, refreshAssurance };
    mfa.verifiedTotpFactors.mockResolvedValue([{ id: "f1" }]);
    mfa.verifyCode.mockResolvedValue();
    renderAt("/mfa?next=%2FSettings%2FUsers");
    await userEvent.type(await screen.findByLabelText(/6-digit code/), "123 456");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(mfa.verifyCode).toHaveBeenCalledWith("f1", "123456");
    expect(refreshAssurance).toHaveBeenCalled();
    expect(await screen.findByText("users page")).toBeInTheDocument();
  });

  it("explains a wrong code and lets the user try again", async () => {
    auth = { user: { id: "u", email: "a@b.c" }, assurance: { currentLevel: "aal1", nextLevel: "aal2" }, refreshAssurance: vi.fn() };
    mfa.verifiedTotpFactors.mockResolvedValue([{ id: "f1" }]);
    mfa.verifyCode.mockRejectedValue(Object.assign(new Error("Invalid TOTP code entered"), { code: "mfa_verification_failed" }));
    renderAt("/mfa");
    await userEvent.type(await screen.findByLabelText(/6-digit code/), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code isn't right");
    expect(screen.getByLabelText(/6-digit code/)).toHaveValue("");
  });

  it("only allows a 6-digit code", async () => {
    auth = { user: { id: "u", email: "a@b.c" }, assurance: { currentLevel: "aal1", nextLevel: "aal2" }, refreshAssurance: vi.fn() };
    mfa.verifiedTotpFactors.mockResolvedValue([{ id: "f1" }]);
    renderAt("/mfa");
    const input = await screen.findByLabelText(/6-digit code/);
    await userEvent.type(input, "12ab3");
    expect(input).toHaveValue("123");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("only returns to same-site pages", () => {
    expect(safeNext("/Settings/Users")).toBe("/Settings/Users");
    expect(safeNext("//evil.example")).toBe("/Dashboard");
    expect(safeNext("https://evil.example")).toBe("/Dashboard");
    expect(safeNext(null)).toBe("/Dashboard");
  });
});
