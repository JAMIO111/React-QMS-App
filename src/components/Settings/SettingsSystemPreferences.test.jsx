import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const updateMutate = vi.fn();
let details = { data: { settings: { includeLegacyCalibrations: false } }, isLoading: false, error: null };
let permissions = ["organisation.manage"];
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  useUpdateOrganisation: () => ({ mutate: updateMutate, isPending: false }),
  useOrganisationDetails: () => details,
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
}));

import SettingsSystemPreferences from "./SettingsSystemPreferences";

beforeEach(() => {
  updateMutate.mockReset();
  details = { data: { settings: { includeLegacyCalibrations: false } }, isLoading: false, error: null };
  permissions = ["organisation.manage"];
});

describe("system preferences", () => {
  it("offers legacy calibrations in the dashboard, off by default", () => {
    render(<SettingsSystemPreferences />);
    expect(screen.getByRole("switch", { name: "Include legacy calibrations in the dashboard" })).not.toBeChecked();
  });

  it("saves the choice at once", async () => {
    render(<SettingsSystemPreferences />);
    await userEvent.click(screen.getByRole("switch", { name: "Include legacy calibrations in the dashboard" }));
    expect(updateMutate).toHaveBeenCalledWith(
      { body: { settings: { includeLegacyCalibrations: true } }, reason: "Legacy calibrations in the dashboard: on" },
      expect.any(Object),
    );
    expect(screen.getByRole("switch", { name: "Include legacy calibrations in the dashboard" })).toBeChecked();
  });

  it("shows it as on when the organisation chose so, and is read-only without organisation.manage", () => {
    details = { data: { settings: { includeLegacyCalibrations: true } }, isLoading: false, error: null };
    permissions = [];
    render(<SettingsSystemPreferences />);
    const sw = screen.getByRole("switch", { name: "Include legacy calibrations in the dashboard" });
    expect(sw).toBeChecked();
    expect(sw).toBeDisabled();
  });

  it("offers whether the person who raised a change may sign it off, off by default, and saves it at once", async () => {
    render(<SettingsSystemPreferences />);
    const sw = screen.getByRole("switch", { name: "Let the person who raised a change sign it off" });
    expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    expect(updateMutate).toHaveBeenCalledWith(
      { body: { settings: { changeAllowSelfApproval: true } }, reason: "Raiser may sign off their own change: on" },
      expect.any(Object),
    );
    expect(sw).toBeChecked();
  });

  it("shows that switch as read-only without organisation.manage", () => {
    details = { data: { settings: { changeAllowSelfApproval: true } }, isLoading: false, error: null };
    permissions = [];
    render(<SettingsSystemPreferences />);
    const sw = screen.getByRole("switch", { name: "Let the person who raised a change sign it off" });
    expect(sw).toBeChecked();
    expect(sw).toBeDisabled();
  });
});
