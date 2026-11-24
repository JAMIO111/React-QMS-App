import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
let rights = () => true;
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => rights(p), isLoading: false }) }));

import { apiFetch } from "../../lib/api-client";
import { ORIGIN_KINDS, recordPath, viaWords } from "../../lib/change";
import LinkedChanges, { RaiseChangeButton } from "./LinkedChanges";

const linked = {
  canRaise: true,
  data: [
    { id: "c1", reference: "ECR-26-0001", title: "Move bracket to CNC 7", stage: "implementing", urgency: "expedited", via: { origin: true, scope: true, task: false } },
    { id: "c2", reference: "ECR-26-0002", title: "New gauge", stage: "closed", urgency: "normal", via: { origin: false, scope: false, task: true } },
  ],
};
const draft = {
  title: "Change from NC-1: Cracked castings", description: "Cracks at the gate", reason: null, typeId: "t-material", urgency: "normal",
  links: [{ kind: "part", id: "p1", code: null, reference: "BR-100", name: "Bracket", readable: true }, { kind: "supplier", id: "s1", code: null, reference: "S1", name: "Castings Ltd", readable: true }],
  source: { kind: "ncr", id: "n1", reference: "NC-1", title: "Cracked castings" },
};

const renderIt = (ui) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  rights = () => true;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path, opts = {}) => {
    if (path.startsWith("/changes/linked")) return linked;
    if (path.startsWith("/change-draft")) return draft;
    if (path.startsWith("/change-types")) return { data: [{ id: "t-material", label: "Material", needsCustomerApproval: false, active: true }] };
    if (path === "/changes" && opts.method === "POST") return { id: "c9", reference: "ECR-26-0009" };
    return {};
  });
});

describe("lib/change origin words", () => {
  it("names the two new origin kinds and links an action or decision through its parent", () => {
    expect(ORIGIN_KINDS.capa_action).toBe("8D action");
    expect(ORIGIN_KINDS.management_review_decision).toBe("Management review decision");
    expect(recordPath("capa_action", "a1", "cap1")).toBe("/CAPA/cap1");
    expect(recordPath("management_review_decision", "d1", "r1")).toBe("/Management-Review/Reviews/r1");
    expect(recordPath("capa_action", "a1")).toBeNull();
  });
  it("says how a change relates to a record", () => {
    expect(viaWords({ origin: true, scope: true, task: false })).toBe("Raised from this · Covers this");
    expect(viaWords({ task: true })).toBe("Has a task on this");
  });
});

describe("LinkedChanges", () => {
  it("lists the changes on a record with their stage and how they relate", async () => {
    renderIt(<LinkedChanges kind="ncr" id="n1" />);
    const list = await screen.findByRole("list", { name: "Linked changes" });
    expect(within(list).getByRole("link", { name: "ECR-26-0001" })).toHaveAttribute("href", "/Change/c1");
    expect(within(list).getByText("Raised from this · Covers this")).toBeInTheDocument();
    expect(within(list).getByText("Expedited")).toBeInTheDocument();
    expect(within(list).getByText("Has a task on this")).toBeInTheDocument();
  });

  it("says so when nothing names the record, and shows nothing to someone who may not read changes", async () => {
    apiFetch.mockImplementation(async () => ({ canRaise: false, data: [] }));
    const first = renderIt(<LinkedChanges kind="part" id="p1" />);
    expect(await screen.findByText("No change names this yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Raise a change" })).not.toBeInTheDocument();
    first.unmount();
    apiFetch.mockClear();
    rights = (p) => p !== "change.read";
    const second = renderIt(<LinkedChanges kind="part" id="p1" />);
    expect(second.container).toBeEmptyDOMElement();
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/changes/linked"), expect.anything());
  });

  it("raises a change from the record: the suggestion fills the dialog, the origin and covered records are sent, and a record can be taken off", async () => {
    renderIt(<LinkedChanges kind="ncr" id="n1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Raise a change" }));
    const dialog = await screen.findByRole("dialog", { name: "Raise a change from NC-1" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Change from NC-1: Cracked castings");
    expect(within(dialog).getByText(/Castings Ltd/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Do not cover .*Castings Ltd/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Raise change" }));
    await waitFor(() => {
      const call = apiFetch.mock.calls.find(([p, o]) => p === "/changes" && o?.method === "POST");
      expect(call[1].body).toMatchObject({ title: "Change from NC-1: Cracked castings", typeId: "t-material", origin: { kind: "ncr", id: "n1" }, links: [{ kind: "part", id: "p1" }] });
    });
  });

  it("offers no Raise a change on a record that cannot be an origin", async () => {
    apiFetch.mockImplementation(async () => ({ canRaise: false, data: linked.data }));
    renderIt(<LinkedChanges kind="part" id="p1" />);
    await screen.findByRole("list", { name: "Linked changes" });
    expect(screen.queryByRole("button", { name: "Raise a change" })).not.toBeInTheDocument();
  });
});

describe("RaiseChangeButton", () => {
  it("opens the same prefilled dialog from a row, and is hidden without change.manage", async () => {
    const first = renderIt(<RaiseChangeButton kind="capa_action" id="a1" ariaLabel="Raise a change from: Fix the gate" />);
    await userEvent.click(screen.getByRole("button", { name: "Raise a change from: Fix the gate" }));
    expect(await screen.findByRole("dialog", { name: "Raise a change from NC-1" })).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("/change-draft?kind=capa_action&id=a1"), expect.anything());
    first.unmount();
    rights = (p) => p !== "change.manage";
    const second = renderIt(<RaiseChangeButton kind="capa_action" id="a1" />);
    expect(second.container).toBeEmptyDOMElement();
  });
});
