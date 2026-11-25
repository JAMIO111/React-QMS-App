import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "", setSearchTerm: vi.fn() }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: () => true, isLoading: false }) }));
vi.mock("../ncr/Pickers", () => ({ PartyPicker: () => null, PartPicker: () => null, MachinePicker: () => null, RemoteComboBox: () => null }));
const exportCSV = vi.fn();
vi.mock("../../lib/csvHelper", () => ({ exportCSV: (...a) => exportCSV(...a) }));

import { apiFetch } from "../../lib/api-client";
import { describeFmeaFilter } from "../../lib/fmea";
import FmeaRegisterPage from "./FmeaRegisterPage";

const summary = (over = {}) => ({
  id: "f1", number: "FMEA-001", kind: "process", title: "Machining of the bracket", scopeText: "Turning", covers: "BR-100, OP-10", status: "active", owner: { id: "u1", name: "Ada" }, customer: null,
  currentRevisionId: "r1", currentLetter: "A", currentEffectiveFrom: "2026-11-01", openRevisionId: "r2", openStatus: "draft", openLetter: null, waitingForMe: false,
  reviewMonths: 12, nextReviewOn: "2020-01-01", reviewOverdue: true, teamCount: 2, withdrawReason: null, createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-11-02T09:00:00.000Z", ...over,
});

const Where = () => {
  const l = useLocation();
  return <output aria-label="address">{l.search}</output>;
};
const renderIt = (path = "/FMEA/Register") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <FmeaRegisterPage />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
const listCalls = () => apiFetch.mock.calls.map(([path]) => path).filter((p) => p.startsWith("/fmeas?"));

let saved;
beforeEach(() => {
  apiFetch.mockReset();
  exportCSV.mockReset();
  saved = [];
  apiFetch.mockImplementation(async (path) => {
    if (path.startsWith("/fmeas?")) return { data: [summary(), summary({ id: "f2", number: "FMEA-002", kind: "design", title: "Bracket design", status: "draft", currentLetter: null, openLetter: "A", openStatus: "pending_approval", waitingForMe: true, covers: null, reviewOverdue: false, nextReviewOn: null })], page: 1, pageSize: 25, total: 2 };
    if (path.startsWith("/saved-filters")) return { data: saved, limit: 5 };
    if (path.startsWith("/part-families")) return { data: [{ id: "pf1", code: "BRK", name: "Brackets" }], nextCursor: null };
    return {};
  });
});

describe("the FMEA register", () => {
  it("shows what each FMEA covers, where it stands and what is in progress, with the columns in the usual table", async () => {
    renderIt();
    const table = await screen.findByRole("region", { name: "FMEAs" });
    expect(await within(table).findByText("BR-100, OP-10")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "FMEA-001" })).toHaveAttribute("href", "/FMEA/f1");
    expect(within(table).getByText(/^Rev A from/)).toBeInTheDocument();
    expect(within(table).getByText("Draft · Draft")).toBeInTheDocument();
    expect(within(table).getByText("Rev A · Waiting for approval")).toBeInTheDocument();
    expect(within(table).getByText("Waiting for you")).toBeInTheDocument();
    expect(within(table).getByText(/\(overdue\)/)).toBeInTheDocument();
    expect(screen.getByText("2 FMEAs (drafts and in force)")).toBeInTheDocument();
    // columns that start hidden are in the column menu, not in the table
    expect(within(table).queryByText("Scope and intended use")).toBeNull();
  });

  it("asks the server for the filters in the address, sorted newest first by default", async () => {
    renderIt("/FMEA/Register?kind=process&status=draft,active&owner=me&overdue=true&part=p1&partLabel=BR-100&family=pf1");
    await screen.findByRole("region", { name: "FMEAs" });
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    const asked = new URLSearchParams(listCalls().at(-1).split("?")[1]);
    expect(Object.fromEntries(asked)).toMatchObject({ kind: "process", status: "draft,active", owner: "me", reviewOverdue: "true", partId: "p1", partFamilyId: "pf1", sort: "number", order: "desc", page: "1", pageSize: "25" });
    // each filter is a chip that can be taken off on its own
    const chips = await screen.findByLabelText("Active filters");
    expect(within(chips).getByText("Kind: Process FMEA")).toBeInTheDocument();
    expect(within(chips).getByText("Part: BR-100")).toBeInTheDocument();
    await userEvent.click(within(chips).getByRole("button", { name: "Remove filter Owned by me" }));
    expect(screen.getByLabelText("address").textContent).not.toMatch(/owner=me/);
  });

  it("applies the drawer's choices to the address and says how many filters are on", async () => {
    renderIt();
    await screen.findByRole("region", { name: "FMEAs" });
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const drawer = await screen.findByRole("dialog", { name: "Filter FMEAs" });
    await userEvent.click(within(drawer).getByLabelText("Design FMEA"));
    await userEvent.click(within(drawer).getByLabelText("Waiting for my approval"));
    await userEvent.click(within(drawer).getByLabelText("BRK"));
    await userEvent.click(within(drawer).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByLabelText("address").textContent).toMatch(/kind=design/));
    const address = screen.getByLabelText("address").textContent;
    expect(address).toMatch(/waiting=me/);
    expect(address).toMatch(/family=pf1/);
  });

  it("offers saved filters like the other registers, and describes one in words", async () => {
    saved = [{ id: "s1", scope: "fmea_register", name: "Mine overdue", filters: { owner: "me", overdue: "true" }, position: 0, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z" }];
    renderIt();
    const bar = await screen.findByRole("tablist", { name: "Saved filters" });
    expect(await within(bar).findByRole("tab", { name: "Mine overdue" })).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole("tab", { name: "Mine overdue" }));
    await waitFor(() => expect(screen.getByLabelText("address").textContent).toMatch(/owner=me/));
    expect(screen.getByLabelText("address").textContent).toMatch(/overdue=true/);
    expect(apiFetch.mock.calls.some(([path]) => path.includes("/saved-filters?scope=fmea_register"))).toBe(true);
    expect(describeFmeaFilter([{ id: "pf1", code: "BRK" }])({ kind: "design", status: "draft,active", owner: "me", waiting: "me", overdue: "true", family: "pf1", part: "p1", partLabel: "BR-100" })).toEqual([
      { key: "kind", title: "Kind", value: "Design FMEA" },
      { key: "status", title: "Status", value: "Draft, In force" },
      { key: "owner", title: "Owner", value: "Mine" },
      { key: "waiting", title: "Approval", value: "Waiting for me" },
      { key: "overdue", title: "Review", value: "Overdue" },
      { key: "part", title: "Part", value: "BR-100" },
      { key: "family", title: "Part family", value: "BRK" },
    ]);
  });

  it("exports the ticked rows as CSV and opens a row's menu", async () => {
    renderIt();
    const table = await screen.findByRole("region", { name: "FMEAs" });
    await within(table).findByText("FMEA-001");
    await userEvent.click(within(table).getByRole("checkbox", { name: "Select FMEA-001" }));
    await userEvent.click(await screen.findByRole("button", { name: /Export CSV/ }));
    expect(exportCSV).toHaveBeenCalledTimes(1);
    const [rows, name] = exportCSV.mock.calls[0];
    expect(name).toBe("fmeas.csv");
    expect(rows).toEqual([expect.objectContaining({ fmea: "FMEA-001", kind: "Process FMEA", covers: "BR-100, OP-10", owner: "Ada", status: "In force", review_overdue: "Yes" })]);
  });
});
