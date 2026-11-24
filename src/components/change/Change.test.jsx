import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
const permissions = new Set(["change.read", "change.manage"]);
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.has(p), isLoading: false }) }));
vi.mock("../../lib/breadcrumbs", () => ({ useBreadcrumbNames: () => {} }));

import { apiFetch } from "../../lib/api-client";
import { draftProblems, linksBody, linkWords, sameLink, stageLabel } from "../../lib/change";
import ChangePage from "./ChangePage";
import ChangeRegisterPage from "./ChangeRegisterPage";

const type = { id: "t1", key: "process", label: "Process", description: null, sequence: 1, active: true, needsCustomerApproval: true, changes: 1 };
const summary = {
  id: "c1", reference: "ECR-26-0001", title: "Move bracket to CNC 7", stage: "draft", urgency: "expedited", type: { id: "t1", label: "Process", needsCustomerApproval: true },
  raisedBy: { id: "u1", name: "Ada Owner" }, originKind: "ncr", linkCount: 1, fileCount: 0, createdAt: "2026-11-24T10:00:00Z", updatedAt: "2026-11-24T10:00:00Z",
};
const detail = {
  ...summary, description: "Run it on machine 7", reason: null, rowVersion: "1",
  links: [{ kind: "part", id: "p1", code: null, reference: "BR-100", name: "Bracket", readable: true }],
  origin: { kind: "ncr", id: "n1", reference: "NC-26-0012", name: "Cracked weld", readable: true },
  attachments: [], cancelReason: null, cancelledAt: null, cancelledBy: null, canManage: true, canEdit: true, canCancel: true, canAddFiles: true,
};

const renderAt = (path, element, route = path) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  apiFetch.mockReset();
  permissions.clear();
  ["change.read", "change.manage"].forEach((p) => permissions.add(p));
  apiFetch.mockImplementation(async (path) => {
    if (path.startsWith("/change-types")) return { data: [type] };
    if (path.startsWith("/changes/c1/attachments")) return { data: [] };
    if (path.startsWith("/changes/c1")) return detail;
    if (path.startsWith("/changes?")) return { data: [summary], page: 1, pageSize: 50, total: 1 };
    return {};
  });
});

describe("the change register", () => {
  it("lists changes with their stage, type and where they came from", async () => {
    renderAt("/Change", <ChangeRegisterPage />);
    const table = await screen.findByRole("table", { name: "Changes" });
    expect(within(table).getByRole("link", { name: "ECR-26-0001" })).toHaveAttribute("href", "/Change/c1");
    expect(within(table).getByText("Move bracket to CNC 7")).toBeInTheDocument();
    expect(within(table).getByText("Expedited")).toBeInTheDocument();
    expect(within(table).getByText("Non-conformance")).toBeInTheDocument();
    expect(within(table).getByText("Draft")).toBeInTheDocument();
  });

  it("offers to raise a change only to people who may manage them", async () => {
    renderAt("/Change", <ChangeRegisterPage />);
    expect(await screen.findByRole("button", { name: "Raise a change" })).toBeInTheDocument();
  });

  it("hides that button from a reader", async () => {
    permissions.delete("change.manage");
    renderAt("/Change", <ChangeRegisterPage />);
    await screen.findByRole("table", { name: "Changes" });
    expect(screen.queryByRole("button", { name: "Raise a change" })).not.toBeInTheDocument();
  });

  it("asks the server for in-progress changes by default and for all when chosen", async () => {
    renderAt("/Change", <ChangeRegisterPage />);
    await screen.findByRole("table", { name: "Changes" });
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(apiFetch.mock.calls.some(([path]) => path.startsWith("/changes?") && path.includes("stage=all"))).toBe(true));
  });
});

describe("the change page", () => {
  it("shows what is changing, where it came from, what it covers and what is still needed", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByRole("heading", { name: "ECR-26-0001" })).toBeInTheDocument();
    expect(screen.getByText("Run it on machine 7")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /NC-26-0012 · Cracked weld/ })).toHaveAttribute("href", "/Non-Conformance/Register/n1");
    expect(screen.getByRole("link", { name: /BR-100 · Bracket/ })).toHaveAttribute("href", "/Parts/p1");
    const needed = screen.getByRole("list", { name: "Still needed" });
    expect(within(needed).getByText("Say why")).toBeInTheDocument();
    expect(within(needed).queryByText("Say what is changing")).not.toBeInTheDocument();
  });

  it("offers editing and cancelling to a manager, and neither to a reader", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByRole("button", { name: "Edit details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel change" })).toBeInTheDocument();
  });

  it("offers nothing to change on a change that has left draft", async () => {
    apiFetch.mockImplementation(async (path) => {
      if (path.startsWith("/changes/c1/attachments")) return { data: [] };
      if (path.startsWith("/changes/c1")) return { ...detail, stage: "cancelled", canEdit: false, canCancel: false, canAddFiles: false, cancelReason: "Raised twice", cancelledAt: "2026-11-24T11:00:00Z" };
      return {};
    });
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByText(/Raised twice/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel change" })).not.toBeInTheDocument();
  });

  it("cancels with a reason sent to the server", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel change" }));
    const reason = screen.getByLabelText("Why is it cancelled?");
    await userEvent.type(reason, "Raised twice");
    await userEvent.click(screen.getByRole("button", { name: "Cancel the change" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/changes/c1/cancel", expect.objectContaining({ method: "POST", body: { reason: "Raised twice" } })));
  });
});

describe("helpers", () => {
  it("names what a draft still needs", () => {
    expect(draftProblems({ description: null, reason: null, links: [] })).toHaveLength(3);
    expect(draftProblems({ description: "a", reason: "b", links: [{}] })).toEqual([]);
  });
  it("words and compares links, and builds the body the server wants", () => {
    const part = { kind: "part", id: "p1", code: null, reference: "BR-100", name: "Bracket", readable: true };
    expect(linkWords(part)).toBe("BR-100 · Bracket");
    expect(linkWords({ ...part, readable: false })).toBe("a record you cannot open");
    expect(linkWords({ kind: "operation_code", code: "OP10" })).toBe("OP10");
    expect(sameLink({ kind: "operation_code", code: "op10" }, { kind: "operation_code", code: "OP10" })).toBe(true);
    expect(linksBody([part, { kind: "operation_code", id: null, code: "OP10" }])).toEqual([{ kind: "part", id: "p1" }, { kind: "operation_code", code: "OP10" }]);
  });
  it("labels stages", () => {
    expect(stageLabel("cancelled")).toBe("Cancelled");
    expect(stageLabel("whatever")).toBe("whatever");
  });
});
