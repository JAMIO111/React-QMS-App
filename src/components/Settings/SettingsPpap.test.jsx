import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../ncr/Pickers", () => ({ PartyPicker: () => null }));

import { apiFetch } from "../../lib/api-client";
import { ELEMENTS } from "../../lib/ppap";
import SettingsPpap from "./SettingsPpap";

const config = () => ({
  rows: Object.fromEntries(ELEMENTS.map((e) => [e.key, { 1: "none", 2: "retain", 3: "submit", 4: "submit", 5: "submit" }])),
  minCpkInitial: 1.67,
  minCpkOngoing: 1.33,
  minReadings: 100,
  maxGrrPercent: 10,
  defaultLevel: 3,
});
let canChange;

beforeEach(() => {
  apiFetch.mockReset();
  canChange = true;
  apiFetch.mockImplementation(async (path, opts) => {
    if (path === "/ppap-requirements" && opts?.method === "PUT") return { current: { id: "s2", version: 2, config: opts.body.config, reason: opts.body.reason }, versions: [], canChange: true };
    if (path === "/ppap-requirements") return { current: { id: "s1", version: 1, config: config(), reason: null }, versions: [{ id: "s1", version: 1, current: true, reason: null, by: null, at: "2026-11-25T09:00:00.000Z" }], canChange };
    if (path === "/ppap-customer-rules") return { data: [{ customerId: "c1", customerName: "Acme", customerCode: "ACM", defaultLevel: 4, extraElements: ["master_sample"], minCpkInitial: null, minCpkOngoing: null, minReadings: null, maxGrrPercent: null, note: null, updatedAt: "2026-11-25T09:00:00.000Z" }], canChange };
    return {};
  });
});

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsPpap />
    </QueryClientProvider>,
  );

describe("Settings → PPAP", () => {
  it("shows which elements each level sends, the minimums and each customer's own rules", async () => {
    renderIt();
    const matrix = await screen.findByRole("table", { name: "Elements by level" });
    expect(within(matrix).getByRole("row", { name: /Design records/ })).toBeInTheDocument();
    expect(screen.getByText("Level 3: 18 sent")).toBeInTheDocument();
    expect(screen.getByText("1.67")).toBeInTheDocument();
    const rules = screen.getByRole("list", { name: "Customer rules" });
    expect(within(rules).getByText("Acme")).toBeInTheDocument();
    expect(within(rules).getByText(/Level 4 · 1 extra element/)).toBeInTheDocument();
  });

  it("changes nothing until something is changed and a reason is given", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Change the requirements" }));
    const dialog = await screen.findByRole("dialog", { name: "Change the requirements" });
    const save = within(dialog).getByRole("button", { name: "Save as version 2" });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Why are the requirements changing/), "Customer manual updated");
    expect(save).toBeDisabled(); // still unchanged
  });

  it("is view-only without the right to change", async () => {
    canChange = false;
    renderIt();
    await screen.findByRole("table", { name: "Elements by level" });
    expect(screen.queryByRole("button", { name: "Change the requirements" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a customer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("saves a customer's rules as the server takes them", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: /Rules for Acme/ });
    await userEvent.click(within(dialog).getByLabelText("Design FMEA"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/ppap-customer-rules/c1", expect.objectContaining({ method: "PUT", body: expect.objectContaining({ defaultLevel: 4, extraElements: ["master_sample", "dfmea"], minCpkInitial: null }) })));
  });
});
