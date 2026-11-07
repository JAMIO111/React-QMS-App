import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
let departments;
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", async (importOriginal) => ({
  ...(await importOriginal()),
  useSites: () => ({ data: { data: [{ id: "s1", code: "MAIN", name: "Main site", timezone: "UTC", currency: "USD", active: true }] }, isLoading: false }),
  useDepartments: () => ({ data: { data: departments }, isLoading: false }),
  useOrganisationDetails: () => ({ data: { settings: { baseCurrency: "EUR" } } }),
}));

import SitesManager from "./SitesManager";

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SitesManager canManage />
    </QueryClientProvider>
  );
const calls = () => apiFetch.mock.calls.map(([path, opts]) => ({ path, method: opts?.method ?? "GET", body: opts?.body }));

beforeEach(() => {
  apiFetch.mockReset();
  departments = [{ id: "d1", siteId: "s1", code: "QA", name: "Quality", active: true }];
});

describe("sites", () => {
  it("shows each site's time zone and currency", () => {
    renderIt();
    expect(screen.getByRole("button", { name: /MAIN — Main site/ })).toHaveTextContent("UTC · USD");
  });

  it("opens a pop-up to edit a site, not an inline form", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit site MAIN" });
    const details = within(dialog).getByRole("form", { name: "Edit site MAIN" });
    expect(within(details).getByLabelText("Name")).toHaveValue("Main site");
    expect(within(details).getByLabelText("Code")).toBeDisabled();
    expect(within(dialog).getByRole("combobox", { name: "Currency" })).toHaveAttribute("placeholder", expect.stringContaining("USD"));
    expect(within(dialog).getByRole("region", { name: "Departments" })).toHaveTextContent("Quality");
  });

  it("saves the changed time zone and currency", async () => {
    apiFetch.mockResolvedValue({});
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit site MAIN" });
    const zone = within(dialog).getByRole("combobox", { name: "Time zone" });
    await userEvent.click(zone);
    await userEvent.type(zone, "Asia/Tokyo");
    await userEvent.click(await screen.findByRole("option", { name: "Asia/Tokyo" }));
    const currency = within(dialog).getByRole("combobox", { name: "Currency" });
    await userEvent.click(currency);
    await userEvent.type(currency, "JPY");
    await userEvent.click(await screen.findByRole("option", { name: /JPY/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls().some((c) => c.method === "PATCH")).toBe(true));
    expect(calls().find((c) => c.method === "PATCH")).toMatchObject({ path: "/sites/s1", body: { name: "Main site", timezone: "Asia/Tokyo", currency: "JPY" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("adds departments from the site pop-up as they are entered", async () => {
    apiFetch.mockResolvedValue({});
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit site MAIN" });
    const form = within(dialog).getByRole("form", { name: "Add department" });
    await userEvent.type(within(form).getByLabelText("Code"), "mfg");
    await userEvent.type(within(form).getByLabelText("Name"), "Manufacturing");
    await userEvent.click(within(form).getByRole("button", { name: "Add department" }));
    await waitFor(() => expect(calls().some((c) => c.path === "/departments")).toBe(true));
    expect(calls().find((c) => c.path === "/departments")).toMatchObject({ method: "POST", body: { code: "MFG", name: "Manufacturing", siteId: "s1" } });
  });

  it("adds a site in the same pop-up, starting with the organisation's currency, and creates its departments with it", async () => {
    apiFetch.mockImplementation(async (path) => (path === "/sites" ? { id: "s2" } : {}));
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Add site" }));
    const dialog = await screen.findByRole("dialog", { name: "Add site" });
    expect(within(dialog).getByRole("combobox", { name: "Currency" })).toHaveAttribute("placeholder", expect.stringContaining("EUR"));
    const details = within(dialog).getByRole("form", { name: "Add site" });
    await userEvent.type(within(details).getByLabelText("Code"), "de");
    await userEvent.type(within(details).getByLabelText("Name"), "Germany");
    const form = within(dialog).getByRole("form", { name: "Add department" });
    await userEvent.type(within(form).getByLabelText("Code"), "mfg");
    await userEvent.type(within(form).getByLabelText("Name"), "Manufacturing");
    await userEvent.click(within(form).getByRole("button", { name: "Add department" }));
    expect(within(dialog).getByRole("region", { name: "Departments" })).toHaveTextContent("Manufacturing");
    expect(calls().filter((c) => c.method === "POST")).toHaveLength(0); // nothing is saved until the site is
    await userEvent.click(within(dialog).getByRole("button", { name: "Add site" }));
    await waitFor(() => expect(calls().filter((c) => c.method === "POST")).toHaveLength(2));
    const [site, department] = calls().filter((c) => c.method === "POST");
    expect(site).toMatchObject({ path: "/sites", body: { code: "DE", name: "Germany", currency: "EUR" } });
    expect(department).toMatchObject({ path: "/departments", body: { code: "MFG", name: "Manufacturing", siteId: "s2" } });
  });
});
