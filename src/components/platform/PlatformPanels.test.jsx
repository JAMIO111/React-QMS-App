import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "op-1" } }) }));
vi.mock("../NotFound", () => ({ default: () => <p>not found page</p> }));

import PlatformPage from "./PlatformPage";
import { ago, describeEvent, pounds } from "./format";

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const org = (over = {}) => ({
  organisationId: "o1", name: "Acme Ltd", status: "active", createdAt: "2026-10-01T00:00:00Z", country: "GB", billingRequired: true, setupFinishedAt: "2026-10-02T00:00:00Z", ownerEmails: ["ada@acme.test"], members: 4,
  subscriptionStatus: "active", billingProvider: "stripe", billingInterval: "month", trialEnd: null, currentPeriodEnd: "2026-12-01T00:00:00Z", cancelAtPeriodEnd: false, pastDueSince: null, seatsPurchased: 5, seatsAssigned: 3, mrrPence: 8000, lastSyncedAt: iso(1000), ...over,
});
let responses;
const routes = () => ({
  "/platform/me": { status: "ok" },
  "/platform/overview": { funnel: { days: 30, since: "2026-10-08T00:00:00Z", signedUp: 1, verified: 1, orgStarted: 1, totalAccounts: 1, totalOrganisations: 1 }, recentSignups: [] },
  "/platform/revenue": { currency: "GBP", mrrPence: 10500, arrPence: 126000, trialMrrPence: 2083, trialsEndingSoon: 2, pastDue: 1, cancelling: 3, cancelledLast30Days: 1, newLast30Days: 4, byStatus: { active: 5, trialing: 2, past_due: 1 }, payingByInterval: { month: 4, year: 2 }, seats: [{ slug: "observer", name: "Observer", purchased: 4, assigned: 3 }, { slug: "controller", name: "Controller", purchased: 6, assigned: 6 }] },
  "/platform/organisations": { total: 2, data: [org(), org({ organisationId: "o2", name: "Beta Co", ownerEmails: [], subscriptionStatus: null, billingProvider: null, billingInterval: null, currentPeriodEnd: null, setupFinishedAt: null, mrrPence: 0, seatsPurchased: 0, seatsAssigned: 0, status: "archived", cancelAtPeriodEnd: null })] },
  "/platform/payments": { invoices: [{ id: "i1", organisationId: "o1", organisation: "Acme Ltd", number: "FQ-1", status: "paid", currency: "gbp", subtotal: 8000, tax: 1600, total: 9600, invoiceDate: "2026-11-01", paidAt: "2026-11-01T10:00:00Z" }], failedPayments: [{ organisationId: "o3", organisation: "Gamma Ltd", invoice: "FQ-9", amount: 3000, currency: "gbp", at: "2026-11-05T10:00:00Z" }], paidLast30DaysPence: 9600, taxLast30DaysPence: 1600, failedLast30Days: 1 },
  "/platform/email": { provider: "none", sending: false, counts: { sent: 0, unsent: 7, failed: 1 }, waiting: 0, oldestWaiting: null, lastSent: null, problems: [{ organisation: "Acme Ltd", event: "parts.created", status: "failed", attempts: 5, error: "Resend refused it (422): Invalid `to` field", at: "2026-11-06T10:00:00Z" }], byEvent: [{ event: "parts.created", count: 8 }] },
  "/platform/webhooks": { hours: 24, lastReceivedAt: iso(5 * 60 * 1000), lastProcessedAt: iso(5 * 60 * 1000), counts: { received: 12, processed: 9, ignored: 2, failed: 1 }, stuck: 0, failed: [{ eventId: "evt_1", type: "invoice.paid", error: "Unknown Stripe price price_x", attempts: 3, organisation: "Acme Ltd", receivedAt: "2026-11-06T10:00:00Z" }], types: [{ type: "invoice.paid", count: 5 }] },
  "/platform/activity": { data: [{ at: "2026-11-06T10:00:00Z", kind: "billing", event: "seats_added", organisationId: "o1", organisation: "Acme Ltd", details: { plan: "controller", from: 0, to: 2 } }, { at: "2026-11-06T09:00:00Z", kind: "organisation", event: "organisation_archived", organisationId: "o2", organisation: "Beta Co", details: { reason: "unpaid_setup" } }] },
});
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}><PlatformPage /></MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  responses = routes();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path) => {
    const key = path.split("?")[0];
    if (!(key in responses)) throw new Error(`unexpected ${path}`);
    const v = responses[key];
    if (v instanceof Error) throw v;
    return v;
  });
});

describe("the platform tabs", () => {
  it("offers seven tabs, opens the overview, and keeps the chosen tab in the address", async () => {
    renderAt("/platform");
    const tabs = await screen.findByRole("tablist", { name: "Platform" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Revenue", "Organisations", "Payments", "Webhooks", "Email", "Activity"]);
    expect(within(tabs).getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(within(tabs).getByRole("tab", { name: "Revenue" }));
    expect(within(tabs).getByRole("tab", { name: "Revenue" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("£105.00")).toBeInTheDocument();
  });

  it("opens straight on a tab from the address", async () => {
    renderAt("/platform?tab=payments");
    expect(await screen.findByRole("table", { name: "Latest invoices" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Payments" })).toHaveAttribute("aria-selected", "true");
  });

  it("only asks the server for the tab that is open", async () => {
    renderAt("/platform?tab=activity");
    await screen.findByRole("list", { name: "Activity" });
    const asked = apiFetch.mock.calls.map((c) => c[0].split("?")[0]);
    expect(asked).toContain("/platform/activity");
    expect(asked).not.toContain("/platform/revenue");
    expect(asked).not.toContain("/platform/payments");
  });
});

describe("revenue", () => {
  it("shows MRR, ARR, trial MRR, movement, seats and subscriptions by status", async () => {
    renderAt("/platform?tab=revenue");
    const tiles = await screen.findByRole("group", { name: "Revenue" });
    expect(tiles).toHaveTextContent("£105.00");
    expect(tiles).toHaveTextContent("£1,260.00");
    expect(tiles).toHaveTextContent("£20.83");
    expect(within(tiles).getByText("Past due").nextSibling).toHaveTextContent("1");
    const movement = screen.getByRole("group", { name: "Movement" });
    expect(movement).toHaveTextContent("Trials ending in 7 days");
    expect(movement).toHaveTextContent("Set to cancel");
    const seats = screen.getByRole("table", { name: "Seats by package" });
    expect(within(seats).getByText("Controller").closest("tr")).toHaveTextContent("660"); // bought 6, assigned 6, unused 0
    const statuses = screen.getByRole("list", { name: "Subscriptions by status" });
    expect(statuses).toHaveTextContent("Active5");
    expect(statuses).toHaveTextContent("Past due1");
    expect(screen.getByText(/Paying: 4 monthly, 2 annual/)).toBeInTheDocument();
    expect(screen.getByText(/excluding VAT/)).toBeInTheDocument();
  });

  it("says so when there are no Stripe subscriptions yet", async () => {
    responses["/platform/revenue"] = { ...routes()["/platform/revenue"], byStatus: {}, payingByInterval: {} };
    renderAt("/platform?tab=revenue");
    expect(await screen.findByText("No Stripe subscriptions yet.")).toBeInTheDocument();
  });
});

describe("organisations", () => {
  it("lists each organisation with owners, members, set-up, subscription, seats and MRR", async () => {
    renderAt("/platform?tab=organisations");
    const table = await screen.findByRole("table", { name: "Organisations" });
    const acme = within(table).getByText("Acme Ltd").closest("tr");
    expect(acme).toHaveTextContent("ada@acme.test");
    expect(acme).toHaveTextContent("Done");
    expect(acme).toHaveTextContent("active");
    expect(acme).toHaveTextContent("Stripe, monthly");
    expect(acme).toHaveTextContent("3 / 5");
    expect(acme).toHaveTextContent("£80.00");
    const beta = within(table).getByText("Beta Co").closest("tr");
    expect(beta).toHaveTextContent("archived");
    expect(beta).toHaveTextContent("In progress");
    expect(beta).toHaveTextContent("None yet");
    expect(screen.getByText("Organisations (2)")).toBeInTheDocument();
    expect(screen.getByText(/no records, documents or quality data/)).toBeInTheDocument();
  });

  it("searches after a pause, and says when nothing matches", async () => {
    renderAt("/platform?tab=organisations");
    await screen.findByRole("table", { name: "Organisations" });
    responses["/platform/organisations"] = { total: 0, data: [] };
    await userEvent.type(screen.getByLabelText("Search organisations"), "zzz");
    await waitFor(() => expect(apiFetch.mock.calls.some((c) => c[0].includes("search=zzz"))).toBe(true));
    expect(await screen.findByText("No organisation matches.")).toBeInTheDocument();
  });

  it("pages through a long list", async () => {
    responses["/platform/organisations"] = { total: 60, data: Array.from({ length: 25 }, (_, i) => org({ organisationId: `o${i}`, name: `Org ${i}` })) };
    renderAt("/platform?tab=organisations");
    expect(await screen.findByText("1–25 of 60")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(apiFetch.mock.calls.some((c) => c[0].includes("offset=25"))).toBe(true));
  });
});

describe("organisations: searching from a later page", () => {
  it("goes back to the first page for a new search", async () => {
    responses["/platform/organisations"] = { total: 60, data: Array.from({ length: 25 }, (_, i) => org({ organisationId: `o${i}`, name: `Org ${i}` })) };
    renderAt("/platform?tab=organisations");
    await screen.findByText("1–25 of 60");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(apiFetch.mock.calls.some((c) => c[0].includes("offset=25"))).toBe(true));
    apiFetch.mockClear();
    await userEvent.type(screen.getByLabelText("Search organisations"), "acme");
    await waitFor(() => expect(apiFetch.mock.calls.some((c) => c[0].includes("search=acme") && c[0].includes("offset=0"))).toBe(true));
    expect(apiFetch.mock.calls.some((c) => c[0].includes("search=acme") && c[0].includes("offset=25"))).toBe(false);
  });
});

describe("payments", () => {
  it("shows 30-day totals, failed payments and the latest invoices", async () => {
    renderAt("/platform?tab=payments");
    const tiles = await screen.findByRole("group", { name: "Last 30 days" });
    expect(tiles).toHaveTextContent("£96.00");
    expect(tiles).toHaveTextContent("£16.00");
    const failed = screen.getByRole("list", { name: "Failed payments" });
    expect(failed).toHaveTextContent("Gamma Ltd");
    expect(failed).toHaveTextContent("FQ-9");
    const invoices = screen.getByRole("table", { name: "Latest invoices" });
    expect(within(invoices).getByText("FQ-1").closest("tr")).toHaveTextContent("£96.00");
  });
});

describe("webhooks", () => {
  it("shows health: last event, counts, and the failed events with their error", async () => {
    renderAt("/platform?tab=webhooks");
    const tiles = await screen.findByRole("group", { name: "Webhook health" });
    expect(tiles).toHaveTextContent("5 minutes ago");
    expect(tiles).toHaveTextContent("12");
    expect(tiles).toHaveTextContent("2 ignored");
    expect(screen.queryByRole("alert")).toBeNull();
    const failed = screen.getByRole("table", { name: "Failed events" });
    expect(failed).toHaveTextContent("Unknown Stripe price price_x");
    expect(failed).toHaveTextContent("evt_1");
    expect(screen.getByRole("list", { name: "Event types" })).toHaveTextContent("invoice.paid5");
  });

  it("warns when Stripe has gone quiet, and when events are stuck", async () => {
    responses["/platform/webhooks"] = { ...routes()["/platform/webhooks"], lastReceivedAt: iso(3 * 24 * 3600 * 1000), stuck: 2 };
    renderAt("/platform?tab=webhooks");
    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]).toHaveTextContent(/has not reached us for over 24 hours/);
    expect(alerts[0]).toHaveTextContent(/Recent deliveries/);
    expect(alerts[1]).toHaveTextContent("2 events were received but never finished");
  });

  it("says Stripe has never reached us when it has not", async () => {
    responses["/platform/webhooks"] = { ...routes()["/platform/webhooks"], lastReceivedAt: null, counts: { received: 0, processed: 0, ignored: 0, failed: 0 }, failed: [], types: [] };
    renderAt("/platform?tab=webhooks");
    expect(await screen.findByRole("alert")).toHaveTextContent("Stripe has never reached us.");
    expect(screen.getByText("No failed events.")).toBeInTheDocument();
  });

  it("changes the window", async () => {
    renderAt("/platform?tab=webhooks");
    await screen.findByRole("group", { name: "Webhook health" });
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/platform/webhooks?hours=168"));
  });
});

describe("activity", () => {
  it("describes each event in words, with its organisation", async () => {
    renderAt("/platform?tab=activity");
    const list = await screen.findByRole("list", { name: "Activity" });
    expect(list).toHaveTextContent("Acme Ltd: Seats added: controller 0 → 2");
    expect(list).toHaveTextContent("Beta Co: Organisation archived (unpaid setup)");
    expect(within(list).getAllByText("Billing")).toHaveLength(1);
  });
});

describe("failures", () => {
  it("shows a failed panel as an error, not as an empty one", async () => {
    responses["/platform/revenue"] = Object.assign(new Error("API unreachable"), { code: "api_unreachable" });
    renderAt("/platform?tab=revenue");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("formatting", () => {
  it("formats pounds, how long ago, and events", () => {
    expect(pounds(123456)).toBe("£1,234.56");
    expect(pounds(null)).toBe("—");
    const now = new Date("2026-11-07T12:00:00Z").getTime();
    expect(ago("2026-11-07T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-11-07T11:00:00Z", now)).toBe("1 hour ago");
    expect(ago("2026-11-04T12:00:00Z", now)).toBe("3 days ago");
    expect(ago(null, now)).toBe("never");
    expect(describeEvent({ event: "payment_failed" })).toBe("Payment failed");
    expect(describeEvent({ event: "admin_override", details: { overAssigned: 2, plan: "contributor" } })).toContain("2 over");
    expect(describeEvent({ event: "something_new" })).toBe("something new");
  });
});

describe("email", () => {
  it("shows the provider, counts and problems, and says when there is no provider", async () => {
    renderAt("/platform?tab=email");
    const tiles = await screen.findByRole("group", { name: "Email health" });
    expect(tiles).toHaveTextContent("None");
    expect(tiles).toHaveTextContent("7");
    expect(screen.getByText("No mail provider")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Email problems" })).toHaveTextContent("Invalid `to` field");
    expect(screen.getByRole("list", { name: "Emails by event" })).toHaveTextContent("parts.created8");
  });
});
