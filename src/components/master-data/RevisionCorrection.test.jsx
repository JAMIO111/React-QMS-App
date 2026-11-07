import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let revisions;
let impact;
const apiFetch = vi.fn();
const confirmCalls = [];
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => async (opts) => (confirmCalls.push(opts), true) }));

import PartDetailPage from "./PartDetailPage";

const rev = (over) => ({
  id: "r1",
  partId: "p1",
  revision: "B",
  drawingRef: "DRG-100 iss B",
  changeSummary: "Hole moved",
  status: "released",
  releasedAt: "2026-10-01T10:00:00Z",
  createdAt: "2026-09-01T10:00:00Z",
  version: 1,
  correctsId: null,
  correctionReason: null,
  correctedAt: null,
  ...over,
});
const part = () => ({
  id: "p1",
  partNumber: "BRK-100",
  name: "Bracket",
  description: null,
  customer: null,
  partFamily: null,
  active: true,
  currentRevision: revisions.find((r) => r.status === "released")?.revision ?? null,
  currentVersion: revisions.find((r) => r.status === "released")?.version ?? null,
  customers: [],
  revisions,
});

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/Parts/p1"]}>
        <Routes>
          <Route path="/Parts/:id" element={<PartDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
const row = (name) => within(screen.getByRole("table", { name: "Revisions" })).getAllByRole("row").find((r) => r.textContent.includes(name));

beforeEach(() => {
  permissions = ["master_data.read", "master_data.manage", "process_control.approve", "inspection.read", "ncr.read"];
  confirmCalls.length = 0;
  revisions = [rev({})];
  impact = {
    corrected: { id: "r1", revision: "B", version: 1, status: "released" },
    correction: { id: "r2", version: 2, status: "draft", reason: "Upper limit is 100.2 on the drawing" },
    canReadInspections: true,
    canReadNcrs: true,
    inspectionsTotal: 3,
    inspections: [
      { id: "i1", reference: "IPI-26-0001", status: "in_progress", result: null, startedAt: "2026-11-05T08:00:00Z", startedBy: "Sam", operationCode: null },
      { id: "i2", reference: "IPI-26-0002", status: "completed", result: "pass", startedAt: "2026-11-04T08:00:00Z", startedBy: "Ada", operationCode: null },
      { id: "i3", reference: "IPI-26-0003", status: "completed", result: "fail", startedAt: "2026-11-03T08:00:00Z", startedBy: "Ada", operationCode: null },
    ],
    ncrsTotal: 1,
    ncrs: [{ id: "n1", reference: "NCM-26-001", stage: "open", source: "supplier", title: "Hole off", detectedAt: "2026-11-02" }],
  };
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path, opts = {}) => {
    if (path === "/parts/p1") return part();
    if (path.startsWith("/customers") || path.startsWith("/part-families")) return { data: [], items: [] };
    if (path.endsWith("/correction") && opts.method === "POST") return rev({ id: "r2", status: "draft", version: 2, correctsId: "r1", correctionReason: opts.body.reason, releasedAt: null });
    if (path.endsWith("/correction-impact")) return impact;
    if (path.endsWith("/release") && opts.method === "POST") return rev({ id: "r2", version: 2 });
    throw new Error(`unexpected ${opts.method ?? "GET"} ${path}`);
  });
});

describe("starting a correction", () => {
  it("offers Correct on the current released revision, explains what it does and needs a reason", async () => {
    const user = userEvent.setup();
    renderIt();
    await user.click(await screen.findByRole("button", { name: "Correct revision B" }));
    const dialog = screen.getByRole("dialog", { name: "Correct revision B" });
    expect(within(dialog).getByText(/The revision stays/)).toBeInTheDocument();
    const start = within(dialog).getByRole("button", { name: "Start correction" });
    expect(start).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/What is wrong in the system/), "  Upper limit is 100.2 on the drawing ");
    await user.click(start);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/part-revisions/r1/correction", expect.objectContaining({ method: "POST", body: { reason: "Upper limit is 100.2 on the drawing" } })));
  });

  it("is not offered to someone who cannot manage master data, on a draft, or while a correction is open", async () => {
    permissions = ["master_data.read"];
    renderIt();
    await screen.findByRole("table", { name: "Revisions" });
    expect(screen.queryByRole("button", { name: /Correct revision/ })).toBeNull();
  });

  it("hides Correct while a correction of the released revision is already open", async () => {
    revisions = [rev({ id: "r2", status: "draft", version: 2, correctsId: "r1", correctionReason: "Limit wrong", releasedAt: null }), rev({})];
    renderIt();
    await screen.findByRole("table", { name: "Revisions" });
    expect(screen.queryByRole("button", { name: /Correct revision/ })).toBeNull();
  });
});

describe("the revision table with a correction", () => {
  beforeEach(() => {
    revisions = [rev({ id: "r2", status: "draft", version: 2, correctsId: "r1", correctionReason: "Upper limit is 100.2 on the drawing", releasedAt: null }), rev({})];
  });

  it("shows the version, what it corrects and why, and keeps the letter", async () => {
    renderIt();
    await screen.findByRole("table", { name: "Revisions" });
    const draft = row("v2");
    expect(within(draft).getByText("B v2")).toBeInTheDocument();
    expect(within(draft).getByText(/Correction of B v1: Upper limit is 100.2 on the drawing/)).toBeInTheDocument();
    expect(screen.getByText("Current revision:")).toHaveTextContent("Current revision: B");
  });

  it("offers Approve and release to approvers only, and says others need approval", async () => {
    const { unmount } = renderIt();
    expect(await screen.findByRole("button", { name: "Approve and release" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull(); // a correction is never released the ordinary way
    unmount();
    permissions = ["master_data.read", "master_data.manage"];
    renderIt();
    await screen.findByRole("table", { name: "Revisions" });
    expect(screen.queryByRole("button", { name: "Approve and release" })).toBeNull();
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
  });

  it("says what the release replaces and how much used the earlier version, then releases", async () => {
    const user = userEvent.setup();
    renderIt();
    await user.click(await screen.findByRole("button", { name: "Approve and release" }));
    const dialog = screen.getByRole("dialog", { name: "Approve and release B v2" });
    expect(await within(dialog).findByText(/3 inspections used it, 1 still running\. They keep it\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 non-conformance refer to it/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Reason: Upper limit is 100.2 on the drawing/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Approve and release" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/part-revisions/r2/release", expect.objectContaining({ method: "POST" })));
  });

  it("explains an empty view for someone without inspection or NC access", async () => {
    permissions = ["master_data.read", "master_data.manage", "process_control.approve"];
    impact = { ...impact, canReadInspections: false, canReadNcrs: false, inspectionsTotal: 0, inspections: [], ncrsTotal: 0, ncrs: [] };
    const user = userEvent.setup();
    renderIt();
    await user.click(await screen.findByRole("button", { name: "Approve and release" }));
    expect(await screen.findByText(/You do not have access to inspections or non-conformances/)).toBeInTheDocument();
  });

  it("discards a correction with its own wording", async () => {
    const user = userEvent.setup();
    renderIt();
    await user.click(await screen.findByRole("button", { name: "Discard correction B v2" }));
    expect(confirmCalls[0]).toMatchObject({ title: "Discard the correction B v2?", confirmText: "Discard", message: expect.stringContaining("B v1 stays the released version") });
  });
});

describe("after the correction is released", () => {
  beforeEach(() => {
    revisions = [
      rev({ id: "r2", version: 2, correctsId: "r1", correctionReason: "Upper limit is 100.2 on the drawing" }),
      rev({ status: "corrected", correctedAt: "2026-11-06T09:00:00Z" }),
    ];
    impact = { ...impact, corrected: { id: "r1", revision: "B", version: 1, status: "corrected" }, correction: { id: "r2", version: 2, status: "released", reason: "Upper limit is 100.2 on the drawing" } };
  });

  it("shows the corrected version frozen with no actions, and B v2 as the current revision", async () => {
    renderIt();
    await screen.findByRole("table", { name: "Revisions" });
    expect(screen.getByText("Current revision:")).toHaveTextContent("Current revision: B v2");
    const old = row("Replaced");
    expect(within(old).getByText("corrected")).toBeInTheDocument();
    expect(within(old).queryByRole("button")).toBeNull();
  });

  it("lists what used the earlier version for review, with links, and says nothing was changed", async () => {
    renderIt();
    const card = await screen.findByRole("region", { name: "Revision B was corrected" });
    expect(within(card).getByText(/It stays on record\. Work that used it is listed here to review; nothing was changed for you\./)).toBeInTheDocument();
    const table = await within(card).findByRole("table", { name: "Inspections that used the earlier version" });
    expect(within(table).getByRole("link", { name: "IPI-26-0001" })).toHaveAttribute("href", "/Inspections/i1");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(card).getByRole("link", { name: "NCM-26-001" })).toHaveAttribute("href", "/Non-Conformance/Supplier/n1");
  });

  it("offers Obsolete, not Discard, on the released correction", async () => {
    renderIt();
    await screen.findByRole("table", { name: "Revisions" });
    const released = row("v2");
    expect(within(released).getByRole("button", { name: "Make revision B v2 obsolete" })).toBeInTheDocument();
    expect(within(released).queryByRole("button", { name: /Discard/ })).toBeNull();
  });

  it("is not shown when nothing has been corrected", async () => {
    revisions = [rev({})];
    renderIt();
    await screen.findByRole("table", { name: "Revisions" });
    expect(screen.queryByRole("region", { name: /was corrected/ })).toBeNull();
  });
});
