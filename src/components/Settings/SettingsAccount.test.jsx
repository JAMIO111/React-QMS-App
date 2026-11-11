import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

const profileAsync = vi.fn().mockResolvedValue({});
const signInMock = vi.fn();
const updatePasswordMock = vi.fn();
vi.mock("@/contexts/UserProvider", () => ({
  useUser: () => ({ profile: { first_name: "Ann", surname: "Lee", job_title: "", email: "ann.lee@example.com" }, refreshProfile: vi.fn() }),
}));
vi.mock("@/contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/hooks/useQmsApi", () => ({ useUpdateProfile: () => ({ mutateAsync: profileAsync, isPending: false }) }));
vi.mock("@/authService", async (orig) => ({ ...(await orig()), signIn: (...a) => signInMock(...a), updatePassword: (...a) => updatePasswordMock(...a) }));
vi.mock("../ProfileImageSection", () => ({ default: () => null }));
vi.mock("./TwoFactorCard", () => ({ default: () => null }));

import SettingsAccount from "./SettingsAccount";

describe("Settings → Account", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves personal details through the API", async () => {
    render(<SettingsAccount />);
    const first = screen.getByLabelText("First Name");
    await userEvent.clear(first);
    await userEvent.type(first, "Anna");
    await userEvent.click(screen.getByRole("button", { name: /save details/i }));
    await waitFor(() => expect(profileAsync).toHaveBeenCalledWith({ firstName: "Anna", surname: "Lee", jobTitle: null }));
  });

  it("masks the password boxes and checks the current password first", async () => {
    signInMock.mockRejectedValue(new Error("bad"));
    render(<SettingsAccount />);
    expect(screen.getByLabelText("Current password")).toHaveAttribute("type", "password");
    await userEvent.type(screen.getByLabelText("Current password"), "wrongpass1");
    await userEvent.type(screen.getByLabelText("New password"), "Brand-new-pass1");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "Brand-new-pass1");
    await userEvent.click(screen.getByRole("button", { name: /change password/i }));
    expect(await screen.findByText(/current password is not right/i)).toBeInTheDocument();
    expect(updatePasswordMock).not.toHaveBeenCalled();
  });

  it("changes the password once the current one is confirmed", async () => {
    signInMock.mockResolvedValue({});
    updatePasswordMock.mockResolvedValue();
    render(<SettingsAccount />);
    await userEvent.type(screen.getByLabelText("Current password"), "oldpass-123");
    await userEvent.type(screen.getByLabelText("New password"), "Brand-new-pass1");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "Brand-new-pass1");
    await userEvent.click(screen.getByRole("button", { name: /change password/i }));
    await waitFor(() => expect(updatePasswordMock).toHaveBeenCalledWith("Brand-new-pass1"));
  });
});
