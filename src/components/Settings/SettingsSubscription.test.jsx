import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const catalogue = {
  plans: [
    { slug: "observer", name: "Observer", description: "Read-only", monthly: { unitAmount: 500, currency: "GBP" }, annual: { unitAmount: 5000, currency: "GBP" }, annualMonthlyEquivalent: 417, annualSaving: 1000, levels: { calibration: "view" } },
    { slug: "controller", name: "Controller", description: "Full", monthly: { unitAmount: 2500, currency: "GBP" }, annual: { unitAmount: 25000, currency: "GBP" }, annualMonthlyEquivalent: 2083, annualSaving: 5000, levels: { calibration: "full" } },
  ],
  modules: [{ slug: "calibration", name: "Calibration", status: "active", features: [{ slug: "record_calibration", name: "Record calibration", minLevel: "operational", includedIn: ["controller"] }] }],
};
const overview = {
  subscription: { status: "active", billingInterval: "month", currency: "GBP", currentPeriodEnd: "2026-01-01T00:00:00Z", cancelAtPeriodEnd: false, gracePeriodDays: 7 },
  items: [{ planSlug: "observer", planName: "Observer", purchased: 2, assigned: 1, available: 1, unitAmount: 500 }],
  totals: { seatsPurchased: 2, seatsAssigned: 1, seatsAvailable: 1, monthlyEquivalent: 1000, annual: 12000 },
};
const members = [{ membershipId: "m1", email: "a@x.test", firstName: "Ann", surname: "Quality", status: "active", roles: ["Quality Manager"], plan: null, unitAmount: null }];

let permissions;
const mutate = vi.fn();
const confirm = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../hooks/useSubscription", () => ({
  usePlanCatalogue: () => ({ data: catalogue }),
  useSubscriptionOverview: () => ({ data: overview }),
  useSeatAssignments: () => ({ data: members }),
  useInvoices: () => ({ data: [] }),
  useSubscriptionMutation: () => ({ mutate, isPending: false }),
}));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => confirm }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("./SettingsOrganisation", () => ({ ApiUnavailable: () => <p>api unavailable</p> }));

import SettingsSubscription from "./SettingsSubscription";

describe("SettingsSubscription", () => {
  beforeEach(() => {
    mutate.mockReset();
    confirm.mockReset();
  });

  it("shows costs from the API in pounds and role and package separately", () => {
    permissions = ["subscription.read"];
    render(<SettingsSubscription />);
    expect(screen.getAllByText("£10.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Quality Manager")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add seat" })).not.toBeInTheDocument();
  });

  it("switches to annual pricing and shows the saving", async () => {
    permissions = ["subscription.read"];
    render(<SettingsSubscription />);
    await userEvent.click(screen.getByRole("switch", { name: "Annual billing" }));
    const card = screen.getByRole("group", { name: "Controller package" });
    expect(within(card).getByText("£20.83")).toBeInTheDocument();
    expect(within(card).getByText(/saves £50\.00/)).toBeInTheDocument();
  });

  it("asks before assigning a package and refuses when no seat is free", async () => {
    permissions = ["subscription.read", "subscription.seats"];
    confirm.mockResolvedValue(true);
    render(<SettingsSubscription />);
    const select = screen.getByLabelText("Package for Ann Quality");
    await userEvent.selectOptions(select, "observer");
    expect(confirm).toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith({ action: "assign", membershipId: "m1", planSlug: "observer" }, expect.any(Object));

    mutate.mockReset();
    confirm.mockClear();
    await userEvent.selectOptions(select, "controller");
    expect(confirm).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
