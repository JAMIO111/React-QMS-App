import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import SettingsNotifications from "./SettingsNotifications";

const pref = (over = {}) => ({
  eventKey: "parts.created", group: "Master data", entity: "Part", action: "created", description: "Part created",
  enabled: true, defaultEnabled: true, overridden: false, email: false, emailDefault: false, emailOverridden: false, ...over,
});

let state;
beforeEach(() => {
  apiFetch.mockReset();
  state = { email: { sending: false }, data: [pref(), pref({ eventKey: "parts.updated", action: "updated", description: "Part changed", enabled: false, defaultEnabled: false })] };
  apiFetch.mockImplementation(async (path, opts = {}) => {
    if (opts.method === "PUT") {
      state = { ...state, data: state.data.map((p) => (p.eventKey === opts.body.eventKey ? { ...p, ...("email" in opts.body ? { email: opts.body.email ?? p.emailDefault, emailOverridden: opts.body.email !== null } : {}) } : p)) };
    }
    return state;
  });
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsNotifications />
    </QueryClientProvider>,
  );

describe("Settings → Notifications", () => {
  it("has an email toggle beside each event, offered only while the event is on in the app", async () => {
    renderPage();
    const created = await screen.findByRole("button", { name: "Part created by email" });
    expect(created).toHaveAttribute("aria-pressed", "false");
    expect(created).toBeEnabled();
    expect(screen.getByRole("button", { name: "Part updated by email" })).toBeDisabled();
    expect(screen.getByText("Emails are not being sent yet")).toBeInTheDocument();
  });

  it("switches email on for one event, at once and on the server", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Part created by email" }));
    expect(screen.getByRole("button", { name: "Part created by email" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/notification-preferences", expect.objectContaining({ method: "PUT", body: { eventKey: "parts.created", email: true } })));
  });

  it("says nothing about sending when the server has a mail provider", async () => {
    state.email = { sending: true };
    renderPage();
    await screen.findByRole("button", { name: "Part created by email" });
    expect(screen.queryByText("Emails are not being sent yet")).toBeNull();
  });
});
