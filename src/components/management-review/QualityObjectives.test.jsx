import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { basisWords, formatValue, targetWords } from "../../lib/qualityObjectives";
import { menuStructure } from "../../MenuStructure";
import { PresentationIcon } from "@/components/icons";

const mutate = vi.fn();
const period = (start, label, value, standing, extra = {}) => ({
  periodStart: start, periodEnd: start, label, current: false, value, numerator: null, denominator: null, note: null, recordedBy: null, recordedAt: null, corrections: [], standing, ...extra,
});
const manual = {
  id: "q1", reference: "QO-001", title: "Complaints answered in 5 days", description: null, owner: { id: "u2", name: "Bob Bloggs" }, measure: "manual",
  measureLabel: "Entered by hand", measureDescription: "A value typed in", unit: "%", direction: "at_least", target: 95, frequency: "quarterly", startsOn: "2026-01-01",
  active: true, retiredReason: null, retiredAt: null, retiredBy: null, canManage: true, canRecord: true, available: true, standing: "off_target",
  summary: { periods: 2, onTarget: 1 },
  periods: [
    period("2026-04-01", "Q2 2026", 97, "on_target"),
    period("2026-07-01", "Q3 2026", 92, "off_target", { note: "Two late", recordedBy: "Bob Bloggs", recordedAt: "2026-10-01T09:00:00Z", corrections: [{ value: 90, note: null, by: "Bob Bloggs", at: "2026-09-30T09:00:00Z" }] }),
    period("2026-10-01", "Q4 2026", null, "no_value", { current: true }),
  ],
};
manual.latest = manual.periods[1];
manual.trend = manual.periods;
const ppm = {
  ...manual, id: "q2", reference: "QO-002", title: "Supplier PPM", measure: "supplier_ppm", measureLabel: "Supplier PPM at goods receipt", unit: "PPM", direction: "at_most", target: 500,
  frequency: "monthly", canRecord: false, standing: "on_target",
  periods: [period("2026-11-01", "Nov 2026", 420, "on_target", { current: true, numerator: 42, denominator: 100000 })],
};
ppm.latest = ppm.periods[0];
ppm.trend = ppm.periods;
let list = { data: [manual, ppm], canManage: true };
let detail = manual;

vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal();
  const { cloneElement } = await import("react");
  return { ...mod, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 300 }) };
});
vi.mock("../Breadcrumb", () => ({ default: () => null }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../../hooks/useCustomFields", () => ({ useCustomFieldPeople: () => ({ data: [{ id: "u1", name: "Ann Owner" }, { id: "u2", name: "Bob Bloggs" }] }) }));
vi.mock("../../hooks/useManagementReview", () => ({
  useQualityObjectives: () => ({ data: list, isLoading: false }),
  useQualityObjective: () => ({ data: detail, isLoading: false }),
  useObjectiveMeasures: () => ({
    data: { data: [
      { key: "manual", label: "Entered by hand", unit: null, direction: null, description: "Typed in", available: true },
      { key: "supplier_ppm", label: "Supplier PPM at goods receipt", unit: "PPM", direction: "at_most", description: "Units rejected per million", available: true },
      { key: "capa_on_time", label: "8Ds closed on time", unit: "%", direction: "at_least", description: "8Ds closed by their due date", available: false },
    ] },
  }),
  useObjectiveMutation: () => ({ mutate, isPending: false, error: null }),
}));

import ObjectivesPage from "./ObjectivesPage";
import ObjectivePage from "./ObjectivePage";

beforeEach(() => {
  mutate.mockReset();
  list = { data: [manual, ppm], canManage: true };
  detail = manual;
});

const at = (path, route, element) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>,
  );

describe("quality objectives", () => {
  it("shows each objective with its latest value, target and standing", () => {
    at("/Management-Review/Objectives", "/Management-Review/Objectives", <ObjectivesPage />);
    expect(screen.getByText("1 on target · 1 off target · 0 with no value yet")).toBeInTheDocument();
    const cards = within(screen.getByRole("list", { name: "Quality objectives" })).getAllByRole("listitem");
    expect(within(cards[0]).getByRole("link", { name: "QO-001 · Complaints answered in 5 days" })).toHaveAttribute("href", "/Management-Review/Objectives/q1");
    expect(within(cards[0]).getByText("92%")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Off target")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Target: At least 95%")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Nov 2026 so far · 42 rejected of 100,000 received")).toBeInTheDocument();
  });

  it("defines an objective with a system measure: its unit and direction are its own", async () => {
    at("/Management-Review/Objectives", "/Management-Review/Objectives", <ObjectivesPage />);
    await userEvent.click(screen.getByRole("button", { name: /New objective/ }));
    await userEvent.type(screen.getByLabelText("Objective"), "Supplier quality");
    await userEvent.click(screen.getByLabelText("Measured by"));
    expect(screen.getByRole("option", { name: /8Ds closed on time/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("option", { name: /Supplier PPM/ }));
    expect(screen.getByText(/Met when the value is at most the target, in PPM/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Unit")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Target"), "500");
    await userEvent.click(screen.getByRole("button", { name: "Define it" }));
    expect(mutate).toHaveBeenCalledWith(
      { action: "create", body: { title: "Supplier quality", description: null, ownerId: "u1", target: 500, measure: "supplier_ppm", frequency: "monthly" } },
      expect.anything(),
    );
  });

  it("offers nothing to define for someone who only reads", () => {
    list = { data: [manual], canManage: false };
    at("/Management-Review/Objectives", "/Management-Review/Objectives", <ObjectivesPage />);
    expect(screen.queryByRole("button", { name: /New objective/ })).not.toBeInTheDocument();
  });

  it("lists every period with its value, standing and the value a correction replaced", () => {
    at("/Management-Review/Objectives/q1", "/Management-Review/Objectives/:id", <ObjectivePage />);
    expect(screen.getByText("1 of 2 finished periods on target")).toBeInTheDocument();
    const rows = within(screen.getByRole("table", { name: "Values by period" })).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Q4 2026in progress—No value yet");
    expect(rows[2]).toHaveTextContent("Q3 2026");
    expect(rows[2]).toHaveTextContent("Two late");
    expect(rows[2]).toHaveTextContent("Replaced 90%");
  });

  it("records a value; a period that has one needs a reason for the correction", async () => {
    at("/Management-Review/Objectives/q1", "/Management-Review/Objectives/:id", <ObjectivePage />);
    await userEvent.click(screen.getByRole("button", { name: "Record a value" }));
    await userEvent.type(screen.getByLabelText("Value (%)"), "96");
    await userEvent.click(screen.getByRole("button", { name: "Record it" }));
    expect(mutate).toHaveBeenCalledWith({ action: "recordValue", id: "q1", body: { periodStart: "2026-10-01", value: 96, note: null } }, expect.anything());

    await userEvent.click(screen.getByLabelText("Period"));
    await userEvent.click(screen.getByRole("option", { name: /Q3 2026/ }));
    expect(screen.getByText(/Q3 2026 already has 92%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record the correction" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Why is it corrected?"), "Recounted");
    await userEvent.click(screen.getByRole("button", { name: "Record the correction" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "recordValue", id: "q1", body: { periodStart: "2026-07-01", value: 96, note: "Recounted" } }, expect.anything());
  });

  it("offers no recording for a system measure, and says so when its records cannot be read", () => {
    detail = { ...ppm, available: false, standing: "unavailable", latest: null, summary: { periods: 0, onTarget: 0 } };
    at("/Management-Review/Objectives/q2", "/Management-Review/Objectives/:id", <ObjectivePage />);
    expect(screen.queryByRole("button", { name: "Record a value" })).not.toBeInTheDocument();
    expect(screen.getByText(/counts records you may not read/)).toBeInTheDocument();
  });

  it("formats values and targets in words, and is in the menu", () => {
    expect(formatValue(420, "PPM")).toBe("420 PPM");
    expect(formatValue(null, "%")).toBe("—");
    expect(targetWords({ direction: "at_most", target: 3, unit: "NCs" })).toBe("At most 3 NCs");
    expect(basisWords("audit_pass_rate", { numerator: 3, denominator: 4 })).toBe("3 of 4 passed");
    expect(basisWords("ncr_count", { numerator: 3, denominator: null })).toBeNull();
    const item = menuStructure.find((m) => m.name === "Management review");
    expect(item).toMatchObject({ permission: "management_review.read", path: "/Management-Review", icon: PresentationIcon });
    expect(item.subMenu.map((s) => s.path)).toEqual(["/Management-Review/Reviews", "/Management-Review/Objectives", "/Management-Review/My-Actions"]);
  });
});
