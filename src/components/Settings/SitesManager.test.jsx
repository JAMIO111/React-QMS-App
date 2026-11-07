import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", async (importOriginal) => ({
  ...(await importOriginal()),
  useSites: () => ({ data: { data: [{ id: "s1", code: "MAIN", name: "Main site", timezone: "UTC", active: true }] }, isLoading: false }),
  useDepartments: () => ({ data: { data: [] }, isLoading: false }),
}));

import SitesManager from "./SitesManager";

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SitesManager canManage />
    </QueryClientProvider>
  );

beforeEach(() => apiFetch.mockReset());

describe("editing a site", () => {
  it("picks the time zone from a list and saves the chosen zone", async () => {
    apiFetch.mockResolvedValue({});
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const zone = screen.getByRole("combobox", { name: "Time zone" });
    expect(zone).toHaveAttribute("placeholder", expect.stringContaining("UTC"));
    await userEvent.click(zone);
    await userEvent.type(zone, "Asia/Tokyo");
    await userEvent.click(await screen.findByRole("option", { name: "Asia/Tokyo" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0][0]).toBe("/sites/s1");
    expect(apiFetch.mock.calls[0][1]).toMatchObject({ method: "PATCH", body: { name: "Main site", timezone: "Asia/Tokyo" } });
  });

  it("cannot save without a time zone", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear Time zone" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
