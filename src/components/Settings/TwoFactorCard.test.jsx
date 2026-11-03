import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mfa = { verifiedTotpFactors: vi.fn(), removeFactor: vi.fn(), startEnrolment: vi.fn(), verifyCode: vi.fn() };
const refreshAssurance = vi.fn();
let confirmAnswer = true;
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ refreshAssurance }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => async () => confirmAnswer }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../supabase-client", () => ({ default: {} }));
vi.mock("../../lib/mfa", async (importOriginal) => ({
  ...(await importOriginal()),
  verifiedTotpFactors: (...a) => mfa.verifiedTotpFactors(...a),
  removeFactor: (...a) => mfa.removeFactor(...a),
  startEnrolment: (...a) => mfa.startEnrolment(...a),
  verifyCode: (...a) => mfa.verifyCode(...a),
}));

import TwoFactorCard from "./TwoFactorCard";

const renderCard = () => render(<QueryClientProvider client={new QueryClient()}><TwoFactorCard /></QueryClientProvider>);

describe("TwoFactorCard", () => {
  beforeEach(() => {
    Object.values(mfa).forEach((f) => f.mockReset());
    refreshAssurance.mockReset();
    confirmAnswer = true;
  });

  it("sets up an authenticator app", async () => {
    mfa.verifiedTotpFactors.mockResolvedValueOnce([]).mockResolvedValue([{ id: "f1" }]);
    mfa.startEnrolment.mockResolvedValue({ factorId: "f1", qrCode: "data:image/svg+xml;base64,PHN2Zy8+", secret: "KEY" });
    mfa.verifyCode.mockResolvedValue();
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "Set up two-factor" }));
    await userEvent.type(await screen.findByLabelText(/6-digit code/), "654321");
    await userEvent.click(screen.getByRole("button", { name: "Turn on two-factor" }));
    expect(mfa.verifyCode).toHaveBeenCalledWith("f1", "654321");
    expect(refreshAssurance).toHaveBeenCalled();
    expect(await screen.findByText("On")).toBeInTheDocument();
  });

  it("turns two-factor off after confirmation", async () => {
    mfa.verifiedTotpFactors.mockResolvedValueOnce([{ id: "f1" }]).mockResolvedValue([]);
    mfa.removeFactor.mockResolvedValue();
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "Turn off two-factor" }));
    expect(mfa.removeFactor).toHaveBeenCalledWith("f1");
    expect(await screen.findByRole("button", { name: "Set up two-factor" })).toBeInTheDocument();
  });

  it("keeps two-factor when the confirmation is cancelled", async () => {
    confirmAnswer = false;
    mfa.verifiedTotpFactors.mockResolvedValue([{ id: "f1" }]);
    renderCard();
    await userEvent.click(await screen.findByRole("button", { name: "Turn off two-factor" }));
    expect(mfa.removeFactor).not.toHaveBeenCalled();
  });
});
