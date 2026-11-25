import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { apiFetch } from "../../lib/api-client";
import SettingsFmea from "./SettingsFmea";

const scale = (prefix) => Array.from({ length: 10 }, (_, i) => ({ label: `${prefix} ${i + 1}`, ...(i === 0 ? { criteria: `${prefix} lowest, in our words` } : {}) }));
const config = () => ({
  method: "rpn",
  rpnHighFrom: 200,
  rpnMediumFrom: 100,
  severityFloor: 9,
  reviewMonths: 12,
  scales: {
    design: { severity: scale("DS"), occurrence: scale("DO"), detection: scale("DD") },
    process: { severity: scale("PS"), occurrence: scale("PO"), detection: scale("PD") },
  },
  apRules: [],
});
const GRID = [
  { sFrom: 1, sTo: 8, oFrom: 1, oTo: 5, dFrom: 1, dTo: 10, priority: "low" },
  { sFrom: 1, sTo: 8, oFrom: 6, oTo: 10, dFrom: 1, dTo: 10, priority: "medium" },
  { sFrom: 9, sTo: 10, oFrom: 1, oTo: 10, dFrom: 1, dTo: 10, priority: "high" },
];
let canChange = true;
let importAnswer;

beforeEach(() => {
  apiFetch.mockReset();
  canChange = true;
  importAnswer = { rules: GRID, errors: [], problem: null, covered: true };
  apiFetch.mockImplementation(async (path, opts) => {
    if (path === "/fmea-model" && opts?.method === "PUT") return { id: "m2", version: 2, current: true, reason: opts.body.reason, config: opts.body.config, versions: [], canChange: true };
    if (path === "/fmea-model") {
      return { id: "m1", version: 1, current: true, reason: null, config: config(), canChange, createdBy: null, createdAt: "2026-11-25T10:00:00Z", versions: [{ id: "m1", version: 1, current: true, reason: null, createdBy: null, createdAt: "2026-11-25T10:00:00Z" }] };
    }
    if (path === "/fmea-model/preview") {
      const b = opts.body;
      const rpn = b.severity * b.occurrence * b.detection;
      return { ...b, rpn, priority: rpn >= 200 ? "high" : rpn >= 100 ? "medium" : "low", method: "rpn", needsAttention: b.severity >= 9 || rpn >= 200, modelVersion: 1 };
    }
    if (path === "/fmea-model/ap-import") return importAnswer;
    return {};
  });
});

const renderIt = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsFmea />
    </QueryClientProvider>,
  );
};

describe("Settings → FMEA", () => {
  it("shows the model: method, thresholds and the words of each scale, per kind", async () => {
    renderIt();
    expect(await screen.findByText(/Priority comes from the RPN: high from 200, medium from 100/)).toBeInTheDocument();
    expect(screen.getByText("Rated by RPN")).toBeInTheDocument();
    const severity = screen.getByRole("table", { name: "severity levels (process)" });
    expect(within(severity).getByText("PS 1")).toBeInTheDocument();
    expect(within(severity).getByText("PS lowest, in our words")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Design" }));
    await userEvent.click(screen.getByRole("radio", { name: "Detection" }));
    expect(within(screen.getByRole("table", { name: "detection levels (design)" })).getByText("DD 10")).toBeInTheDocument();
  });

  it("tries a rating and shows the answer the database gives", async () => {
    renderIt();
    expect(await screen.findByText(/Medium priority/)).toBeInTheDocument(); // 8 x 4 x 5 = 160
    expect(screen.getByText(/RPN 160/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/fmea-model/preview", expect.objectContaining({ method: "POST", body: { kind: "process", severity: 8, occurrence: 4, detection: 5 } }));
  });

  it("offers no way to change it without the approve permission", async () => {
    canChange = false;
    renderIt();
    await screen.findByText(/Priority comes from the RPN/);
    expect(screen.queryByRole("button", { name: "Change the model" })).toBeNull();
  });

  it("will not save the action priority method without a grid, and says why", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Change the model" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Action priority grid" }));
    expect(within(dialog).getByText(/needs an action priority grid/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save as version 2" })).toBeDisabled();
  });

  it("imports a complete grid from CSV, then saves it as a new version with a reason", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Change the model" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.upload(within(dialog).getByLabelText("Choose a CSV file"), new File(["S,O,D,P\n"], "grid.csv", { type: "text/csv" }));
    expect(await within(dialog).findByText(/grid.csv is complete/)).toBeInTheDocument();
    expect(within(dialog).getByText("S 9–10 · O any · D any → High")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Action priority grid" }));
    await userEvent.type(within(dialog).getByLabelText(/Why is the model changing/), "Use our licensed grid");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save as version 2" }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/fmea-model",
        expect.objectContaining({ method: "PUT", body: expect.objectContaining({ reason: "Use our licensed grid", config: expect.objectContaining({ method: "ap", apRules: GRID }) }) }),
      ),
    );
  });

  it("lists what is wrong with an incomplete file and does not take its ranges", async () => {
    importAnswer = { rules: GRID.slice(0, 1), errors: [{ line: 3, message: "The priority is H, M or L" }], problem: null, covered: false };
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Change the model" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.upload(within(dialog).getByLabelText("Choose a CSV file"), new File(["x"], "bad.csv", { type: "text/csv" }));
    expect(await within(dialog).findByText("bad.csv cannot be used yet")).toBeInTheDocument();
    expect(within(dialog).getByText(/Line 3: The priority is H, M or L/)).toBeInTheDocument();
    expect(within(dialog).getByText(/No grid. Priority comes from the RPN/)).toBeInTheDocument();
  });

  it("changes a level's word and the review interval, and sends only a tidy model", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Change the model" }));
    const dialog = screen.getByRole("dialog");
    const label = within(dialog).getByLabelText("Level 1 label");
    await userEvent.clear(label);
    await userEvent.type(label, "  Trivial ");
    const months = within(dialog).getByLabelText(/Review an FMEA every/);
    await userEvent.clear(months);
    await userEvent.type(months, "6");
    await userEvent.type(within(dialog).getByLabelText(/Why is the model changing/), "Our own words");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save as version 2" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmea-model", expect.objectContaining({ method: "PUT" })));
    const body = apiFetch.mock.calls.find((c) => c[0] === "/fmea-model" && c[1]?.method === "PUT")[1].body;
    expect(body.config.reviewMonths).toBe(6);
    expect(body.config.scales.process.severity[0]).toEqual({ label: "Trivial", criteria: "PS lowest, in our words" });
  });
});
