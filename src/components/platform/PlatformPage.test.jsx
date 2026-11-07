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

const overview = (over = {}) => ({
  funnel: { days: 30, since: "2026-10-08T00:00:00Z", signedUp: 20, verified: 15, orgStarted: 6, totalAccounts: 80, totalOrganisations: 25, ...over },
  recentSignups: [
    { userId: "u1", email: "ada@acme.test", name: "Ada Owner", signedUpAt: "2026-11-06T09:00:00Z", verifiedAt: "2026-11-06T09:05:00Z", orgStartedAt: "2026-11-06T09:10:00Z", organisationName: "Acme Ltd" },
    { userId: "u2", email: "bob@beta.test", name: "Bob", signedUpAt: "2026-11-05T09:00:00Z", verifiedAt: "2026-11-05T09:05:00Z", orgStartedAt: null, organisationName: null },
    { userId: "u3", email: "cy@gamma.test", name: null, signedUpAt: "2026-11-04T09:00:00Z", verifiedAt: null, orgStartedAt: null, organisationName: null },
  ],
});
const render_ = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><PlatformPage /></MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  apiFetch.mockReset();
});

describe("the platform area", () => {
  it("is not found for anyone who is not an operator", async () => {
    apiFetch.mockResolvedValue({ status: "none" });
    render_();
    expect(await screen.findByText("not found page")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/platform/overview"));
  });

  it("asks an operator without a two-factor session to verify, and shows no data", async () => {
    apiFetch.mockResolvedValue({ status: "needs_mfa" });
    render_();
    expect(await screen.findByText("Two-factor authentication needed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Verify with your authenticator app" })).toHaveAttribute("href", "/mfa?next=%2Fplatform");
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/platform/overview"));
  });

  it("shows the funnel with each step as a share of the one before, the totals and the latest sign-ups", async () => {
    apiFetch.mockImplementation(async (path) => (path === "/platform/me" ? { status: "ok" } : overview()));
    render_();
    const funnel = await screen.findByRole("list", { name: "Sign-up funnel" });
    expect(within(funnel).getByText("20")).toBeInTheDocument();
    expect(within(funnel).getByText("75% of the step before")).toBeInTheDocument(); // 15 of 20 verified
    expect(within(funnel).getByText("40% of the step before")).toBeInTheDocument(); // 6 of 15 started an organisation
    expect(screen.getByText("80")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Latest sign-ups" });
    expect(within(table).getByText("Organisation started")).toBeInTheDocument();
    expect(within(table).getByText("Verified")).toBeInTheDocument();
    expect(within(table).getByText("Awaiting verification")).toBeInTheDocument();
    expect(within(table).getByText("Acme Ltd")).toBeInTheDocument();
    expect(screen.getByText(/no organisation's business data/)).toBeInTheDocument();
  });

  it("changes the period", async () => {
    apiFetch.mockImplementation(async (path) => (path === "/platform/me" ? { status: "ok" } : overview({ days: path.endsWith("=7") ? 7 : 30 })));
    render_();
    await screen.findByRole("list", { name: "Sign-up funnel" });
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/platform/overview?days=7"));
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says when nobody has signed up, and shows an API failure", async () => {
    apiFetch.mockImplementation(async (path) => (path === "/platform/me" ? { status: "ok" } : { ...overview({ signedUp: 0, verified: 0, orgStarted: 0 }), recentSignups: [] }));
    render_();
    expect(await screen.findByText("Nobody has signed up yet.")).toBeInTheDocument();
  });
});
