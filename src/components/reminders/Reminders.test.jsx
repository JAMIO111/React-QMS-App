import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../Breadcrumb", () => ({ default: () => null }));

import RemindersPage from "./RemindersPage";
import ReminderTimeSetting from "../Settings/ReminderTimeSetting";
import { dueWords, reminderPath } from "../../lib/reminders";
import { notificationLink } from "../../lib/notifications";

const RISK = "11111111-1111-4111-8111-111111111111";
const item = (over = {}) => ({
  area: "risk_actions", areaLabel: "Risk actions", recordId: "a1", targetId: RISK, label: "RSK-001 · Check the foundry", dueOn: "2026-11-10",
  overdue: true, areaEnabled: true, path: `/Risk/Register/${RISK}`, ...over,
});

const wrap = (ui) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  apiFetch.mockReset();
});

describe("My reminders", () => {
  it("lists overdue and due soon apart, each linked, in words, and marks areas switched off", async () => {
    apiFetch.mockResolvedValue({
      today: "2026-11-12",
      counts: { overdue: 1, dueSoon: 2 },
      data: [
        item(),
        item({ recordId: "a2", label: "GA-1 · Micrometer", area: "gauges", areaLabel: "Gauge calibration", dueOn: "2026-11-13", overdue: false, path: "/Calibration/Gauges/x" }),
        item({ recordId: "a3", label: "SOP-001 · Cleaning", area: "documents_to_read", areaLabel: "Documents to read", dueOn: "2026-11-17", overdue: false, areaEnabled: false, path: "/Documentation/My-Documents" }),
      ],
    });
    wrap(<RemindersPage />);
    const overdue = await screen.findByRole("list", { name: "Overdue" });
    expect(within(overdue).getByRole("link", { name: "RSK-001 · Check the foundry" })).toHaveAttribute("href", `/Risk/Register/${RISK}`);
    expect(overdue).toHaveTextContent("Overdue since 10 Nov 2026 (2 days)");
    const soon = screen.getByRole("list", { name: "Due soon" });
    expect(soon).toHaveTextContent("Due tomorrow");
    expect(soon).toHaveTextContent("Due in 5 days (17 Nov 2026)");
    expect(within(soon).getByText("Not reminded")).toBeInTheDocument();
    expect(screen.getByText("1 overdue · 2 due soon")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/reminders/mine", expect.anything());
  });

  it("says when nothing is due", async () => {
    apiFetch.mockResolvedValue({ today: "2026-11-12", counts: { overdue: 0, dueSoon: 0 }, data: [] });
    wrap(<RemindersPage />);
    expect(await screen.findByText("Nothing of yours is overdue or due soon.")).toBeInTheDocument();
  });
});

describe("the organisation's reminder time", () => {
  it("saves the time and zone together, only once something changed", async () => {
    apiFetch.mockImplementation(async (_path, opts) => ({ settings: { ...opts.body.settings } }));
    wrap(<ReminderTimeSetting settings={{ reminderTime: "07:00", timeZone: null, effectiveTimeZone: "Europe/London" }} canManage />);
    const save = screen.getByRole("button", { name: "Save reminder time" });
    expect(save).toBeDisabled();
    expect(screen.getByText("Not set: the first site's zone is used (Europe/London)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: /^Send at/ }));
    await userEvent.click(await screen.findByRole("option", { name: "06:30" }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/organisations/current", expect.objectContaining({ method: "PATCH", body: { settings: { reminderTime: "06:30", timeZone: null } } })),
    );
  });

  it("is read-only without the right to manage the organisation", () => {
    wrap(<ReminderTimeSetting settings={{ reminderTime: "07:00", timeZone: "UTC", effectiveTimeZone: "UTC" }} canManage={false} />);
    expect(screen.queryByRole("button", { name: "Save reminder time" })).toBeNull();
  });
});

describe("links", () => {
  it("leads every area to its page, and never anywhere else", () => {
    expect(reminderPath("risk_reviews", RISK)).toBe(`/Risk/Register/${RISK}`);
    expect(reminderPath("ncr_containment", RISK)).toBe(`/Non-Conformance/Register/${RISK}`);
    expect(reminderPath("ncr_containment", "../../evil")).toBeNull();
    expect(reminderPath("gauges", "javascript:alert(1)")).toBe("/Calibration/Gauges");
    expect(reminderPath("nonsense", RISK)).toBeNull();
    expect(notificationLink({ entityType: "reminder_digests", entityId: "x", details: {} })).toBe("/Reminders");
    expect(notificationLink({ entityType: "reminder_overdue_notices", entityId: "x", details: { area: "scars", target_id: RISK } })).toBe(`/Supplier-Quality/SCARs/${RISK}`);
  });

  it("puts a due date in words", () => {
    expect(dueWords("2026-11-11", "2026-11-12")).toBe("Overdue since 11 Nov 2026 (1 day)");
    expect(dueWords("2026-11-12", "2026-11-12")).toBe("Due today");
  });
});
