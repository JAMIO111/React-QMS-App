import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let ncrs;
let revisions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }), useSites: () => ({ data: { data: [] } }), useOrganisationDetails: () => ({ data: undefined }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../api/supabaseApi", () => ({ generateSignedUrl: vi.fn(async (_b, path) => `https://files.test/${path}`) }));

import JobPage from "./JobPage";

const job = {
  id: "j1",
  reference: "IPI-26-0007",
  status: "in_progress",
  result: null,
  part: { id: "p1", partNumber: "ROD-1", name: "Rod" },
  partRevision: "A",
  plan: { id: "cp1", planCode: "CP-ROD", revisionCode: "A" },
  operationCode: "OP-10",
  site: { id: "s1", name: "Plant A" },
  machine: { id: "m1", code: "CNC-1", name: "Lathe 1" },
  workOrder: null,
  lot: null,
  lotSize: 200,
  serial: null,
  triggerType: "first_off",
  startedAt: new Date(Date.now() - 5 * 60000).toISOString(),
  startedBy: { id: "u1", name: "Sam" },
  failures: 0,
  completedAt: null,
  completedBy: null,
  abandonReason: null,
  requirements: [],
  schedule: [],
  samples: [],
  measurements: [],
  ncrs: [],
};
const alertA = { id: "a1", reference: "QA-001", revisionLetter: "A", title: "Burr on bore", category: "product", severity: "high", actions: [{ description: "Deburr every part", department: null, machine: null }], effectiveDate: "2026-11-01", acknowledgeBy: null, matched: ["part"], acknowledged: false };
const alertB = { id: "a2", reference: "QA-002", revisionLetter: "B", title: "Coolant change", category: "process", severity: "low", actions: [], effectiveDate: "2026-11-03", acknowledgeBy: null, matched: ["machine"], acknowledged: true };
const ncr = (over) => ({ id: "n1", reference: "NCM-26-001", stage: "open", source: "internal", severity: "major", title: "Rod burr", detectedAt: "2026-11-02", quantityAffected: 3, part: { id: "p1", partNumber: "ROD-1" }, matched: ["part"], open: true, characteristics: ["OD"], ...over });

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/Jobs/j1"]}>
        <Routes>
          <Route path="/Jobs/:id" element={<JobPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["inspection.read", "inspection.record", "documentation.read", "ncr.read", "master_data.read"];
  ncrs = { canRead: true, days: 90, data: [ncr({}), ncr({ id: "n2", reference: "NCM-26-000", title: "Old chatter", stage: "closed", open: false, matched: ["machine", "operation"], source: "supplier" })] };
  revisions = {
    days: 30,
    partRevisionSuperseded: false,
    planRevisionSuperseded: true,
    data: [
      { kind: "plan_revision", id: "r2", revision: "B", subject: "CP-ROD", changeSummary: "Tighter sampling", at: "2026-11-06T09:00:00Z", by: "Quinn Quality", isNew: true, current: true, runningOnIt: false },
      { kind: "part_revision", id: "r1", revision: "A", subject: "ROD-1", changeSummary: null, at: "2026-10-20T09:00:00Z", by: null, isNew: false, current: true, runningOnIt: true },
    ],
  };
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path) => {
    if (path === "/inspections/j1") return job;
    if (path.startsWith("/gauges")) return { data: [] };
    if (path.startsWith("/quality-alerts/active")) return { data: [alertA, alertB] };
    if (path === "/quality-alerts/a1") return { ...alertA, description: "Sharp edge left inside the bore." };
    if (path === "/quality-alerts/a2") return { ...alertB, description: "New coolant from Monday." };
    if (path === "/quality-alerts/a1/attachments?deleted=include")
      return {
        data: [
          { id: "f1", fileName: "burr.jpg", storagePath: "org/quality-alerts/a1/burr.jpg", contentType: "image/jpeg", sizeBytes: 2048, deletedAt: null },
          { id: "f2", fileName: "inspection-sheet.pdf", storagePath: "org/quality-alerts/a1/sheet.pdf", contentType: "application/pdf", sizeBytes: 90000, deletedAt: null },
          { id: "f3", fileName: "removed.png", storagePath: "x", contentType: "image/png", sizeBytes: 1, deletedAt: "2026-11-02T00:00:00Z" },
        ],
      };
    if (path.includes("/attachments")) return { data: [] };
    if (path === "/jobs/j1/recent-ncrs") return ncrs;
    if (path === "/jobs/j1/revisions") return revisions;
    throw new Error(`unexpected ${path}`);
  });
});

const launcher = (name) => screen.findByRole("button", { name: new RegExp(name) });

describe("the launchers", () => {
  it("show a count for each pane and mark the ones that need attention", async () => {
    renderIt();
    expect(await launcher("Alerts, 2, needs attention")).toBeInTheDocument();
    expect(await launcher("NCs, 2, needs attention")).toBeInTheDocument();
    expect(await launcher("Revisions, 2, needs attention")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { hidden: true })).toHaveAttribute("inert");
  });

  it("show a pane only to people who may read what is in it", async () => {
    permissions = ["inspection.read", "inspection.record"];
    renderIt();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("navigation", { name: "Job information panes" })).toBeNull();
    permissions = ["inspection.read", "inspection.record", "documentation.read"];
  });

  it("hide the non-conformances pane when the server says the caller may not read them", async () => {
    ncrs = { canRead: false, days: 90, data: [] };
    renderIt();
    await launcher("Alerts");
    expect(screen.queryByRole("button", { name: /NCs/ })).toBeNull();
  });
});

describe("the quality alerts pane", () => {
  it("slides in with the first alert, its wording and its files, and cycles through the others", async () => {
    const user = userEvent.setup();
    renderIt();
    await user.click(await launcher("Alerts"));
    const pane = screen.getByRole("complementary", { name: "Alerts pane" });
    expect(pane).not.toHaveAttribute("inert");
    expect(await within(pane).findByText("QA-001 rev A · Burr on bore")).toBeInTheDocument();
    expect(within(pane).getByText("1 of 2")).toBeInTheDocument();
    expect(await within(pane).findByText("Sharp edge left inside the bore.")).toBeInTheDocument();
    expect(within(pane).getByText("Deburr every part")).toBeInTheDocument();
    expect(within(pane).getByText("Not acknowledged")).toBeInTheDocument();
    // a picture is shown inline from a signed link; a document is offered to open; removed files are not listed
    expect(await within(pane).findByRole("img", { name: "burr.jpg" })).toHaveAttribute("src", "https://files.test/org/quality-alerts/a1/burr.jpg");
    expect(within(pane).getByText("inspection-sheet.pdf")).toBeInTheDocument();
    expect(within(pane).queryByText(/removed\.png/)).toBeNull();
    await user.click(within(pane).getByRole("button", { name: "Next alert" }));
    expect(await within(pane).findByText("QA-002 rev B · Coolant change")).toBeInTheDocument();
    expect(within(pane).getByText("2 of 2")).toBeInTheDocument();
    expect(await within(pane).findByText("New coolant from Monday.")).toBeInTheDocument();
    await user.click(within(pane).getByRole("button", { name: "Next alert" }));
    expect(await within(pane).findByText("QA-001 rev A · Burr on bore")).toBeInTheDocument(); // wraps round
    await user.click(within(pane).getByRole("button", { name: "Previous alert" }));
    expect(within(pane).getByText("2 of 2")).toBeInTheDocument();
  });

  it("closes with the close button or Escape, and never hides the recording screen", async () => {
    const user = userEvent.setup();
    renderIt();
    await user.click(await launcher("Alerts"));
    expect(screen.getByRole("heading", { level: 1, name: "ROD-1 · CNC-1" })).toBeInTheDocument(); // still there, no backdrop
    await user.click(screen.getByRole("button", { name: "Close pane" }));
    expect(screen.getByRole("complementary", { hidden: true })).toHaveAttribute("inert");
    await user.click(await launcher("Alerts"));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("complementary", { hidden: true })).toHaveAttribute("inert");
  });

  it("switches to another pane from its launcher", async () => {
    const user = userEvent.setup();
    renderIt();
    await user.click(await launcher("Alerts"));
    await user.click(await launcher("NCs"));
    expect(screen.getByRole("complementary", { name: "NCs pane" })).toBeInTheDocument();
  });
});

describe("the non-conformances pane", () => {
  it("shows each NC with why it is relevant and a link to open it, and cycles", async () => {
    const user = userEvent.setup();
    renderIt();
    await user.click(await launcher("NCs"));
    const pane = screen.getByRole("complementary", { name: "NCs pane" });
    expect(within(pane).getByText("NCM-26-001 · Rod burr")).toBeInTheDocument();
    expect(within(pane).getByText("OD")).toBeInTheDocument();
    expect(within(pane).getByText(/same part\./)).toBeInTheDocument();
    expect(within(pane).getByRole("link", { name: "Open the non-conformance" })).toHaveAttribute("href", "/Non-Conformance/Register/n1");
    await user.click(within(pane).getByRole("button", { name: "Next non-conformance" }));
    expect(within(pane).getByText("NCM-26-000 · Old chatter")).toBeInTheDocument();
    expect(within(pane).getByText(/same machine, same operation/)).toBeInTheDocument();
    expect(within(pane).getByRole("link", { name: "Open the non-conformance" })).toHaveAttribute("href", "/Non-Conformance/Register/n2");
  });

  it("says so when there are none", async () => {
    ncrs = { canRead: true, days: 90, data: [] };
    const user = userEvent.setup();
    renderIt();
    await user.click(await launcher("NCs"));
    expect(screen.getByText(/No non-conformances for this part, family, machine or operation in the last 90 days/)).toBeInTheDocument();
  });
});

describe("the revisions pane and the newer-revision banner", () => {
  it("flags new revisions, says which are in force and which one this job runs on", async () => {
    const user = userEvent.setup();
    renderIt();
    await user.click(await launcher("Revisions"));
    const pane = screen.getByRole("complementary", { name: "Revisions pane" });
    expect(within(pane).getByText("New")).toBeInTheDocument();
    expect(within(pane).getByText("CP-ROD · rev B")).toBeInTheDocument();
    expect(within(pane).getByText("Tighter sampling")).toBeInTheDocument();
    expect(within(pane).getByText("This job started on an earlier revision.")).toBeInTheDocument();
    await user.click(within(pane).getByRole("button", { name: "Next revision" }));
    expect(within(pane).getByText("ROD-1 · rev A")).toBeInTheDocument();
    expect(within(pane).getByText("No change summary was given.")).toBeInTheDocument();
    expect(within(pane).getByText("This job is running on this revision.")).toBeInTheDocument();
  });

  it("warns on the hub when a newer control plan revision is in force, as information only", async () => {
    renderIt();
    const banner = await screen.findByText(/A newer control plan revision B \(this job runs on A\) is now in force/);
    expect(banner.closest("[role=status]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete inspection" })).toBeInTheDocument(); // nothing is blocked
  });

  it("calls a corrected part revision a correction, not a newer revision, and labels it with its version", async () => {
    revisions = {
      days: 30,
      partRevisionSuperseded: true,
      planRevisionSuperseded: false,
      data: [{ kind: "part_revision", id: "r9", revision: "A", version: 2, subject: "ROD-1", changeSummary: "Correction: Upper limit is 100.2", at: "2026-11-06T09:00:00Z", by: "Quinn Quality", isNew: true, current: true, runningOnIt: false }],
    };
    const user = userEvent.setup();
    renderIt();
    const banner = await screen.findByText(/Our record of revision A has been corrected \(now v2\); the drawing's revision is unchanged/);
    expect(banner.closest("[role=status]")).not.toHaveTextContent("A newer part revision");
    await user.click(await launcher("Revisions"));
    const pane = screen.getByRole("complementary", { name: "Revisions pane" });
    expect(within(pane).getByText("ROD-1 · rev A v2")).toBeInTheDocument();
    expect(within(pane).getByText("Correction: Upper limit is 100.2")).toBeInTheDocument();
  });

  it("shows no banner when the job is on the revisions in force", async () => {
    revisions = { ...revisions, planRevisionSuperseded: false };
    renderIt();
    await launcher("Revisions");
    await waitFor(() => expect(screen.queryByText(/is now in force/)).toBeNull());
  });
});
