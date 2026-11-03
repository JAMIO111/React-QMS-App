import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const org = {
  id: "org-1",
  name: "Alpha Precision",
  slug: "alpha-precision",
  status: "active",
  settings: { baseCurrency: "GBP", vatRate: 0.2, ncrReferencePrefix: "NCM", themeColour: "purple" },
};
let details;
let permissions;
const mutate = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({
  useOrganisationDetails: () => details,
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useUpdateOrganisation: () => ({ mutate, isPending: false, error: null }),
}));
vi.mock("./SitesManager", () => ({ default: ({ canManage }) => <div>sites manager {String(canManage)}</div> }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import SettingsOrganisation from "./SettingsOrganisation";
import { ApiClientError } from "../../lib/api-client";

describe("SettingsOrganisation", () => {
  beforeEach(() => mutate.mockReset());

  it("lets an administrator save details with an audit reason", async () => {
    details = { data: org, isLoading: false, error: null };
    permissions = ["organisation.manage"];
    render(<SettingsOrganisation />);

    expect(screen.getByLabelText("VAT rate (%)")).toHaveValue(20);
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Alpha Precision Ltd");
    await userEvent.clear(screen.getByLabelText("VAT rate (%)"));
    await userEvent.type(screen.getByLabelText("VAT rate (%)"), "17.5");
    await userEvent.type(screen.getByLabelText("Reason for change (optional)"), "Rebrand");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(mutate).toHaveBeenCalledWith(
      {
        body: { name: "Alpha Precision Ltd", settings: { baseCurrency: "GBP", vatRate: 0.175, ncrReferencePrefix: "NCM" } },
        reason: "Rebrand",
      },
      expect.any(Object)
    );
    expect(screen.getByText("sites manager true")).toBeInTheDocument();
  });

  it("is read-only without organisation.manage", () => {
    details = { data: org, isLoading: false, error: null };
    permissions = ["ncr.read"];
    render(<SettingsOrganisation />);
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByText("sites manager false")).toBeInTheDocument();
  });

  it("explains when the API is not running", () => {
    details = { data: undefined, isLoading: false, error: new ApiClientError({ status: 0, code: "api_unreachable", message: "x" }) };
    permissions = [];
    render(<SettingsOrganisation />);
    expect(screen.getByRole("alert")).toHaveTextContent("npm run api:dev");
  });
});

describe("SettingsOrganisation with the theme picker", () => {
  it("keeps unsaved edits when only the theme colour changes", async () => {
    details = { data: org, isLoading: false, error: null };
    permissions = ["organisation.manage"];
    const { rerender } = render(<SettingsOrganisation />);
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Draft name");

    details = { data: { ...org, settings: { ...org.settings, themeColour: "green" } }, isLoading: false, error: null };
    rerender(<SettingsOrganisation />);
    expect(screen.getByLabelText("Name")).toHaveValue("Draft name");
  });
});
