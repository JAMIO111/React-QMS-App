import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrganisationProvider, useOrganisation } from "./OrganisationProvider";

let memberships = [];
vi.mock("./AuthProvider", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("../supabase-client", () => ({
  default: {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => Promise.resolve({ data: memberships, error: null }) }),
      }),
    }),
  },
}));

const row = (id, name, currency = "GBP") => ({
  id: `m-${id}`,
  status: "active",
  organisation: { id, name, slug: id, settings: { base_currency: currency, vat_rate: 0.2, ncr_reference_prefix: "NCM" } },
});

const Probe = () => {
  const { organisation, organisations } = useOrganisation();
  if (organisation === undefined) return <p>loading</p>;
  return <p>{organisation ? `${organisation.name}|${organisation.base_currency}|${organisations.length}` : "none"}</p>;
};

const renderProvider = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OrganisationProvider>
        <Probe />
      </OrganisationProvider>
    </QueryClientProvider>
  );

describe("OrganisationProvider", () => {
  beforeEach(() => localStorage.clear());

  it("selects the first organisation alphabetically by default", async () => {
    memberships = [row("b", "Zeta Ltd", "EUR"), row("a", "Alpha Ltd")];
    renderProvider();
    await waitFor(() => expect(screen.getByText("Alpha Ltd|GBP|2")).toBeInTheDocument());
  });

  it("restores a remembered organisation the user still belongs to", async () => {
    localStorage.setItem("qms.currentOrganisationId", "b");
    memberships = [row("b", "Zeta Ltd", "EUR"), row("a", "Alpha Ltd")];
    renderProvider();
    await waitFor(() => expect(screen.getByText("Zeta Ltd|EUR|2")).toBeInTheDocument());
  });

  it("ignores a remembered organisation the user no longer belongs to", async () => {
    localStorage.setItem("qms.currentOrganisationId", "gone");
    memberships = [row("a", "Alpha Ltd")];
    renderProvider();
    await waitFor(() => expect(screen.getByText("Alpha Ltd|GBP|1")).toBeInTheDocument());
  });

  it("reports no organisation when the user has no membership", async () => {
    memberships = [];
    renderProvider();
    await waitFor(() => expect(screen.getByText("none")).toBeInTheDocument());
  });
});
