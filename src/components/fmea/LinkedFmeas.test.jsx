import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => held.includes(p), isLoading: false }) }));

import { apiFetch } from "../../lib/api-client";
import LinkedFmeas from "./LinkedFmeas";

let held;
const fmea = (over = {}) => ({ id: "f1", number: "FMEA-001", title: "Brackets", kind: "process", revisionId: "r1", letter: "B", nextReviewOn: "2027-11-01", reviewOverdue: false, via: ["part_family"], ...over });
const show = (props) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <LinkedFmeas kind="part" id="p1" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  held = ["fmea.read"];
  apiFetch.mockReset();
});

describe("the FMEAs that cover a part, family, machine or plan (FM16)", () => {
  it("lists the FMEAs in force with how each covers it, and links to them", async () => {
    apiFetch.mockResolvedValue({ data: [fmea(), fmea({ id: "f2", number: "FMEA-002", title: "Plate", via: ["part"], letter: "A" })], canRaise: false });
    show();
    expect(await screen.findByText("2 FMEAs cover this part")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/fmeas/linked?kind=part&id=p1", expect.anything());
    const list = screen.getByRole("list", { name: "FMEAs in force" });
    expect(within(list).getByRole("link", { name: "FMEA-001 rev B · Brackets" })).toHaveAttribute("href", "/FMEA/f1");
    expect(within(list).getByText(/Process FMEA · covers its part family/)).toBeInTheDocument();
    expect(within(list).getByText(/covers this part ·/)).toBeInTheDocument();
  });

  it("flags a review that is overdue, once in the heading and on the FMEA", async () => {
    apiFetch.mockResolvedValue({ data: [fmea({ reviewOverdue: true })], canRaise: false });
    show({ kind: "machine", id: "m1" });
    expect(await screen.findByText("1 FMEA covers this machine")).toBeInTheDocument();
    expect(screen.getByText("Its review is overdue")).toBeInTheDocument();
    expect(screen.getByText("Review overdue")).toBeInTheDocument();
  });

  it("says quietly that nothing covers a part or a plan, and offers the FMEAs to someone who can start one", async () => {
    apiFetch.mockResolvedValue({ data: [], canRaise: true });
    show({ showWhenNone: true });
    expect(await screen.findByText("No FMEA in force covers this part.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to FMEAs" })).toHaveAttribute("href", "/FMEA/Register");
  });

  it("offers no way to start one to someone who cannot", async () => {
    apiFetch.mockResolvedValue({ data: [], canRaise: false });
    show({ kind: "control_plan", showWhenNone: true });
    expect(await screen.findByText("No FMEA in force covers this control plan.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to FMEAs" })).not.toBeInTheDocument();
  });

  it("shows nothing for a family or a machine that no FMEA covers", async () => {
    apiFetch.mockResolvedValue({ data: [], canRaise: true });
    const { container } = show({ kind: "part_family" });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing, and asks nothing, of someone who may not read FMEAs", () => {
    held = [];
    const { container } = show({ showWhenNone: true });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing when the answer is not what was expected", async () => {
    apiFetch.mockResolvedValue({});
    const { container } = show({ showWhenNone: true });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
