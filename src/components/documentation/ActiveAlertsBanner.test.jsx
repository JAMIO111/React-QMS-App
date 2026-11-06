import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));

import ActiveAlertsBanner from "./ActiveAlertsBanner";

const alert = (over = {}) => ({
  id: "a1", reference: "QA-001", revisionLetter: "B", title: "Incorrect material specification", category: "supplier", severity: "critical",
  requiredAction: "Quarantine lot 77.", effectiveDate: "2026-11-05", acknowledgeBy: "2026-11-07", matched: ["part", "machine"], acknowledged: false, ...over,
});

const show = (props) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ActiveAlertsBanner {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["documentation.read"];
});

describe("ActiveAlertsBanner", () => {
  it("asks for what is being worked on and shows each alert with severity, action, why it matches and acknowledgement", async () => {
    apiFetch.mockResolvedValue({ data: [alert(), alert({ id: "a2", reference: "QA-002", revisionLetter: "A", title: "Temporary frequency change", severity: "low", requiredAction: null, matched: ["family"], acknowledged: true, acknowledgeBy: null })] });
    show({ partId: "p1", machineId: "m1", operationCode: "OP-020" });
    const region = await screen.findByRole("region", { name: "Active quality alerts" });
    expect(apiFetch).toHaveBeenCalledWith("/quality-alerts/active?partId=p1&machineId=m1&operationCode=OP-020", { organisationId: "org-1" });
    expect(within(region).getByText("2 active quality alerts affect this work")).toBeInTheDocument();
    expect(within(region).getByText("1 is waiting for your acknowledgement")).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "QA-001 rev B · Incorrect material specification" })).toHaveAttribute("href", "/Documentation/Quality-Alerts/a1");
    expect(within(region).getByText("Critical")).toBeInTheDocument();
    expect(within(region).getByText("Quarantine lot 77.")).toBeInTheDocument();
    expect(within(region).getByText(/Affects this part, this machine/)).toBeInTheDocument();
    expect(within(region).getByText(/Affects this part family/)).toBeInTheDocument();
    expect(within(region).getByText("Not acknowledged")).toBeInTheDocument();
    expect(within(region).getByText("Acknowledged")).toBeInTheDocument();
  });

  it("uses the singular for one alert and does not nag about alerts that are not addressed to the reader", async () => {
    apiFetch.mockResolvedValue({ data: [alert({ acknowledged: null })] });
    show({ partFamilyId: "f1" });
    expect(await screen.findByText("1 active quality alert affects this work")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for your acknowledgement/)).toBeNull();
    expect(screen.queryByText("Not acknowledged")).toBeNull();
  });

  it("shows nothing when no alert affects the work, without documentation.read, or with nothing to look for", async () => {
    apiFetch.mockResolvedValue({ data: [] });
    const { unmount } = show({ partId: "p1" });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByRole("region")).toBeNull();
    unmount();

    apiFetch.mockClear();
    permissions = [];
    show({ partId: "p1" });
    show({});
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("region")).toBeNull();
  });
});
