import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", () => ({ apiFetch: (...a) => apiFetch(...a), describeApiError: (e) => e.message }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "o1" }) }));

import CustomerContacts from "./CustomerContacts";

const list = { data: [
  { id: "k1", customerId: "c1", name: "Pat Quality", jobTitle: null, role: "quality", email: "pat@wayne.test", phone: null, isPrimary: true, active: true, notes: null },
  { id: "k2", customerId: "c1", name: "Sam Buyer", jobTitle: "Buyer", role: "purchasing", email: null, phone: null, isPrimary: false, active: false, notes: null },
] };
const renderIt = (canManage = true) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CustomerContacts customerId="c1" canManage={canManage} /></QueryClientProvider>);

beforeEach(() => {
  apiFetch.mockReset().mockResolvedValue(list);
});

describe("customer contacts", () => {
  it("lists them with the primary marked and inactive ones dimmed", async () => {
    renderIt();
    const ul = await screen.findByRole("list", { name: "Customer contacts" });
    expect(ul).toHaveTextContent("Pat QualityPrimary");
    expect(ul).toHaveTextContent("Sam BuyerInactive");
  });

  it("adds a contact", async () => {
    renderIt();
    await screen.findByRole("list", { name: "Customer contacts" });
    await userEvent.click(screen.getByRole("button", { name: "Add a contact" }));
    const d = screen.getByRole("dialog");
    await userEvent.type(within(d).getByLabelText("Name"), "Kim Tech");
    await userEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(apiFetch).toHaveBeenCalledWith("/customers/c1/contacts", expect.objectContaining({ method: "POST", body: expect.objectContaining({ name: "Kim Tech", role: "other", isPrimary: false }) }));
  });

  it("deactivates with a switch, and offers no controls without the right", async () => {
    renderIt();
    await screen.findByRole("list", { name: "Customer contacts" });
    await userEvent.click(screen.getByRole("switch", { name: "Pat Quality is active" }));
    expect(apiFetch).toHaveBeenCalledWith("/customer-contacts/k1", expect.objectContaining({ method: "PATCH", body: { active: false } }));
  });

  it("is read-only without master_data.manage", async () => {
    renderIt(false);
    await screen.findByRole("list", { name: "Customer contacts" });
    expect(screen.queryByRole("button", { name: "Add a contact" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
