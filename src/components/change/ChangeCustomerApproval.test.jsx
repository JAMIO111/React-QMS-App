import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { apiFetch } from "../../lib/api-client";
import { CustomerCard } from "./ChangeAssessment";

const change = {
  id: "c1", reference: "ECR-26-0001", stage: "assessment", typeNeedsCustomerApproval: true, canSetCustomerApproval: true,
  customerApproval: { status: "required", reference: null, on: null, waivedReason: null },
};
const request = (over) => ({ id: "r1", partyId: "p1", customer: "Wayne Ltd", status: "pending", requestedAt: "2026-11-20T10:00:00Z", requestNote: "Please approve.", requestedBy: "Ada", decidedAt: null, decidedBy: null, decisionNote: null, customerReference: null, withdrawnReason: null, ...over });
let state;

const renderIt = (c = change) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CustomerCard change={c} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  apiFetch.mockReset();
  state = { data: [], customers: [{ partyId: "p1", customerId: "k1", name: "Wayne Ltd" }] };
  apiFetch.mockImplementation(async (path, opts) => {
    if (path === "/changes/c1/customer-approvals" && opts?.method === "POST") {
      state = { ...state, data: [request({ requestNote: opts.body.note })] };
      return { ...state, email: { attempted: 0, sent: 0 } };
    }
    if (path === "/changes/c1/customer-approvals") return state;
    if (path === "/change-customer-approvals/r1/withdraw") {
      state = { ...state, data: [request({ status: "withdrawn", withdrawnReason: opts.body.reason })] };
      return state;
    }
    return {};
  });
});

describe("asking a customer to approve a change in the portal", () => {
  it("offers Ask the customer when a customer the change is about has the portal on, and sends the request", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Ask the customer" }));
    // one customer: already chosen
    await userEvent.type(screen.getByLabelText("Message to them"), "Please approve.");
    await userEvent.click(screen.getByRole("button", { name: "Ask them" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/changes/c1/customer-approvals", expect.objectContaining({ method: "POST", body: { partyId: "p1", note: "Please approve." } })));
    const list = await screen.findByRole("list", { name: "Requests to customers" });
    expect(within(list).getByText("Waiting for the customer")).toBeInTheDocument();
    expect(within(list).getByText(/You wrote: Please approve\./)).toBeInTheDocument();
  });

  it("does not offer it when no customer can be asked", async () => {
    state = { data: [], customers: [] };
    renderIt();
    await screen.findByText("Customer approval");
    expect(screen.queryByRole("button", { name: "Ask the customer" })).toBeNull();
  });

  it("does not offer it on a draft or while a request is waiting", async () => {
    renderIt({ ...change, stage: "draft" });
    await screen.findByText("Customer approval");
    expect(screen.queryByRole("button", { name: "Ask the customer" })).toBeNull();
  });

  it("shows a waiting request and the customer's words, and withdraws with a reason", async () => {
    state = { ...state, data: [request({})] };
    renderIt();
    const list = await screen.findByRole("list", { name: "Requests to customers" });
    expect(screen.queryByRole("button", { name: "Ask the customer" })).toBeNull();
    await userEvent.click(within(list).getByRole("button", { name: "Withdraw the request to Wayne Ltd" }));
    const send = screen.getByRole("button", { name: "Withdraw" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Why/), "Raised too early");
    await userEvent.click(send);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/change-customer-approvals/r1/withdraw", expect.objectContaining({ method: "POST", body: { reason: "Raised too early" } })));
  });

  it("shows what the customer answered", async () => {
    state = { ...state, data: [request({ status: "rejected", decidedAt: "2026-11-21T09:00:00Z", decidedBy: "Pat", decisionNote: "A 2 mm radius cracks on our press." })] };
    renderIt();
    const list = await screen.findByRole("list", { name: "Requests to customers" });
    expect(within(list).getByText("Not approved")).toBeInTheDocument();
    expect(within(list).getByText(/They wrote: A 2 mm radius cracks/)).toBeInTheDocument();
  });
});
