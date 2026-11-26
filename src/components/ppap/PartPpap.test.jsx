import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
const dialog = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("./PpapDialogs", () => ({ NewPpapDialog: ({ defaults }) => { dialog(defaults); return <div role="dialog">Start dialog</div>; } }));

import { PartPpapBanner, PartPpapCard, PpapPrompts } from "./PartPpap";

const state = (over = {}) => ({
  available: true, part: { id: "p1", partNumber: "PN-1", name: "Bracket" }, revision: { id: "r1", label: "B", status: "released" },
  customers: [
    { id: "c1", name: "Wayne Ltd", code: "W", primary: true, requires: true, state: "none", submissionId: null, reference: null, interimExpiresOn: null, nextReviewOn: null, earlier: null },
    { id: "c2", name: "Stark Ltd", code: "S", primary: false, requires: false, state: "none", submissionId: null, reference: null, interimExpiresOn: null, nextReviewOn: null, earlier: null },
  ],
  attention: [{ code: "none", tone: "warning", message: "PN-1 rev B has no PPAP for Wayne Ltd", customerId: "c1", customerName: "Wayne Ltd", submissionId: null }],
  lastProducedOn: null, canRaise: true, ...over,
});
const draftBody = { partId: "p1", partRevisionId: "r1", customerId: "c1", customers: [{ id: "c1", code: "W", name: "Wayne Ltd" }], parts: [{ id: "p1", partNumber: "PN-1", name: "Bracket" }], reason: "engineering_change", notes: "Raised from part revision PN-1 rev B: Bracket", source: { kind: "part_revision", id: "r1", reference: "PN-1 rev B", title: "Bracket" } };
const route = (map) => apiFetch.mockImplementation(async (path) => { const k = path.split("?")[0]; if (!(k in map)) throw new Error(`unexpected ${path}`); return typeof map[k] === "function" ? map[k](path) : map[k]; });
const renderUi = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);

beforeEach(() => {
  permissions = ["ppap.read", "ppap.manage"];
  apiFetch.mockReset();
  dialog.mockReset();
});

describe("the PPAP banner", () => {
  it("says what is worth saying about the part, with a link to the package when there is one", async () => {
    route({ "/part-ppap-state": state({ attention: [
      { code: "rejected", tone: "critical", message: "Wayne Ltd rejected the PPAP for PN-1 rev B (PPAP-26-0003)", customerId: "c1", customerName: "Wayne Ltd", submissionId: "k3" },
      { code: "none", tone: "warning", message: "PN-1 rev B has no PPAP for Stark Ltd", customerId: "c2", customerName: "Stark Ltd", submissionId: null },
    ] }) });
    renderUi(<PartPpapBanner partId="p1" />);
    const list = await screen.findByRole("list", { name: "Part approval" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("rejected the PPAP");
    expect(within(items[0]).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/PPAP/k3");
    expect(within(items[1]).queryByRole("link")).not.toBeInTheDocument();
    expect(apiFetch.mock.calls[0][0]).toBe("/part-ppap-state?partId=p1");
  });

  it("asks for the given revision", async () => {
    route({ "/part-ppap-state": state() });
    renderUi(<PartPpapBanner partId="p1" partRevisionId="r9" />);
    await screen.findByRole("list", { name: "Part approval" });
    expect(apiFetch.mock.calls[0][0]).toBe("/part-ppap-state?partId=p1&partRevisionId=r9");
  });

  it("is absent when there is nothing to say, when it is unavailable, and without ppap.read (it does not even ask)", async () => {
    route({ "/part-ppap-state": state({ attention: [] }) });
    const { container, unmount } = renderUi(<PartPpapBanner partId="p1" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    route({ "/part-ppap-state": { available: false } });
    const second = renderUi(<PartPpapBanner partId="p1" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
    second.unmount();
    permissions = [];
    apiFetch.mockClear();
    const third = renderUi(<PartPpapBanner partId="p1" />);
    expect(third.container).toBeEmptyDOMElement();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("the part's PPAP card", () => {
  it("lists each customer with where the revision stands, and starts a PPAP from the revision with that customer", async () => {
    route({ "/part-ppap-state": state(), "/ppap-draft": draftBody });
    renderUi(<PartPpapCard partId="p1" />);
    const table = await screen.findByRole("table", { name: "PPAP by customer" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Wayne Ltd");
    expect(rows[0]).toHaveTextContent("No PPAP");
    expect(rows[1]).toHaveTextContent("Not asked for PPAP");
    // A person may still start one for a customer that has not asked: the card only says they have not.
    expect(within(rows[1]).getByRole("button", { name: "Start a PPAP" })).toBeInTheDocument();
    await userEvent.click(within(rows[0]).getByRole("button", { name: "Start a PPAP" }));
    await screen.findByRole("dialog");
    expect(apiFetch.mock.calls.some(([p]) => p === "/ppap-draft?kind=part_revision&id=r1")).toBe(true);
    expect(dialog).toHaveBeenLastCalledWith(expect.objectContaining({
      part: { id: "p1", name: "PN-1" }, partRevisionId: "r1", customer: { id: "c1", name: "Wayne Ltd" }, reason: "engineering_change", raisedFrom: { kind: "part_revision", id: "r1" },
    }));
  });

  it("shows the state, the package and the dates, and offers no start for a customer that has one", async () => {
    route({ "/part-ppap-state": state({ customers: [{ id: "c1", name: "Wayne Ltd", code: "W", primary: true, requires: true, state: "interim", submissionId: "k2", reference: "PPAP-26-0002", interimExpiresOn: "2026-12-31", nextReviewOn: null, earlier: null }] }) });
    renderUi(<PartPpapCard partId="p1" />);
    const table = await screen.findByRole("table", { name: "PPAP by customer" });
    expect(table).toHaveTextContent("Interim approval");
    expect(table).toHaveTextContent("Runs to");
    expect(within(table).getByRole("link", { name: "PPAP-26-0002" })).toHaveAttribute("href", "/PPAP/k2");
    expect(within(table).queryByRole("button", { name: "Start a PPAP" })).not.toBeInTheDocument();
  });

  it("offers no start without ppap.manage, and is quiet when no customer requires PPAP", async () => {
    permissions = ["ppap.read"];
    route({ "/part-ppap-state": state({ canRaise: false }) });
    const first = renderUi(<PartPpapCard partId="p1" />);
    await screen.findByRole("table", { name: "PPAP by customer" });
    expect(screen.queryByRole("button", { name: "Start a PPAP" })).not.toBeInTheDocument();
    first.unmount();
    route({ "/part-ppap-state": state({ customers: [{ id: "c2", name: "Stark Ltd", code: "S", primary: true, requires: false, state: "none", submissionId: null, reference: null, interimExpiresOn: null, nextReviewOn: null, earlier: null }], attention: [] }) });
    const second = renderUi(<PartPpapCard partId="p1" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });
});

describe("PPAP prompts on a change", () => {
  const prompts = (over = {}) => ({
    available: true, applies: true, reference: "CHG-26-0001", canRaise: true, raised: [],
    prompts: [{ code: "change_may_need_ppap", message: "Change CHG-26-0001 may need a new PPAP for PN-1 to Wayne Ltd", partId: "p1", partNumber: "PN-1", customerId: "c1", customerName: "Wayne Ltd" }], ...over,
  });

  it("suggests a PPAP and starts one from the change with the part and customer it names", async () => {
    route({ "/ppap-prompts": prompts(), "/ppap-draft": { ...draftBody, source: { kind: "change", id: "chg1", reference: "CHG-26-0001", title: "New drawing" } } });
    renderUi(<PpapPrompts kind="change" id="chg1" />);
    expect(await screen.findByRole("heading", { name: "PPAP likely needed" })).toBeInTheDocument();
    expect(screen.getByText(/may need a new PPAP for PN-1 to Wayne Ltd/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start a PPAP" }));
    await screen.findByRole("dialog");
    expect(apiFetch.mock.calls[0][0]).toBe("/ppap-prompts?kind=change&id=chg1");
    expect(dialog).toHaveBeenLastCalledWith(expect.objectContaining({ part: { id: "p1", name: "PN-1" }, customer: { id: "c1", name: "Wayne Ltd" }, raisedFrom: { kind: "change", id: "chg1" } }));
  });

  it("lists the PPAPs already raised from it, and drops the heading to match when nothing more is suggested", async () => {
    route({ "/ppap-prompts": prompts({ prompts: [], raised: [{ id: "k1", reference: "PPAP-26-0001", status: "in_preparation", part: { id: "p1", partNumber: "PN-1" }, customer: { id: "c1", name: "Wayne Ltd" } }] }) });
    renderUi(<PpapPrompts kind="change" id="chg1" />);
    expect(await screen.findByRole("heading", { name: "PPAP raised from this" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "PPAPs raised from this" });
    expect(within(list).getByRole("link", { name: "PPAP-26-0001" })).toHaveAttribute("href", "/PPAP/k1");
    expect(list).toHaveTextContent("PN-1 to Wayne Ltd · In preparation");
    expect(screen.queryByRole("button", { name: "Start a PPAP" })).not.toBeInTheDocument();
  });

  it("is absent when nothing is suggested or raised, when unavailable, and offers no start without ppap.manage", async () => {
    route({ "/ppap-prompts": prompts({ prompts: [], raised: [] }) });
    const first = renderUi(<PpapPrompts kind="control_plan_revision" id="cpr1" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    route({ "/ppap-prompts": { available: false } });
    const second = renderUi(<PpapPrompts kind="change" id="chg1" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
    second.unmount();
    route({ "/ppap-prompts": prompts({ canRaise: false }) });
    renderUi(<PpapPrompts kind="change" id="chg1" />);
    await screen.findByRole("heading", { name: "PPAP likely needed" });
    expect(screen.queryByRole("button", { name: "Start a PPAP" })).not.toBeInTheDocument();
  });
});
