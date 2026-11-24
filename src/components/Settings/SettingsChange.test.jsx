import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
const permissions = new Set(["change.read", "change.manage"]);
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.has(p), isLoading: false }) }));

import { apiFetch } from "../../lib/api-client";
import SettingsChange from "./SettingsChange";

const item = (over) => ({ id: "x", key: "x", label: "X", description: null, sequence: 1, active: true, ...over });

beforeEach(() => {
  apiFetch.mockReset();
  permissions.clear();
  ["change.read", "change.manage"].forEach((p) => permissions.add(p));
  apiFetch.mockImplementation(async (path, opts) => {
    if (opts?.method === "PATCH") return {};
    if (path.startsWith("/change-types")) return { data: [item({ id: "t1", label: "Process", needsCustomerApproval: true, changes: 2 }), item({ id: "t2", label: "Tooling", needsCustomerApproval: false, changes: 0, active: false })] };
    if (path.startsWith("/change-functions")) return { data: [item({ id: "f1", label: "Quality" })] };
    if (path.startsWith("/change-areas")) return { data: [item({ id: "a1", label: "Design and drawing" })] };
    return {};
  });
});

const renderIt = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsChange />
    </QueryClientProvider>,
  );
};

describe("Settings → Change", () => {
  it("lists types with their count and whether they need the customer, functions and areas", async () => {
    renderIt();
    const types = await screen.findByRole("list", { name: "Types of change" });
    expect(within(types).getByText(/Usually needs the customer · 2 changes/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Functions that sign off" })).getByText("Quality")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Areas a change is assessed for" })).getByText("Design and drawing")).toBeInTheDocument();
  });

  it("switches a type off at once and sends only that change", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("switch", { name: "Switch Process off" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/change-types/t1", expect.objectContaining({ method: "PATCH", body: { active: false } })));
  });

  it("adds a type with the customer flag", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Add type" }));
    await userEvent.type(screen.getByLabelText("Name"), "Packaging");
    await userEvent.click(screen.getByRole("switch", { name: /Usually needs the customer/ }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add type" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/change-types", expect.objectContaining({ method: "POST", body: { label: "Packaging", description: null, needsCustomerApproval: true } })));
  });

  it("shows no controls to someone who can only read", async () => {
    permissions.delete("change.manage");
    renderIt();
    await screen.findByRole("list", { name: "Types of change" });
    expect(screen.queryByRole("button", { name: "Add type" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
