import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../ncr/Pickers", () => ({ PartyPicker: () => null, PartPicker: () => null, MachinePicker: () => null, RemoteComboBox: () => null }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => held.includes(p), isLoading: false }) }));

import { apiFetch } from "../../lib/api-client";
import RaisedFmeas, { RaisedFrom } from "./RaisedFmeas";

let held;
const DRAFT = {
  kind: "process",
  title: "Porosity in castings",
  scopeText: "Raised from non-conformance SNC-26-0011: Porosity in castings",
  links: [
    { kind: "part", id: "p1", label: "BR-100 Bracket" },
    { kind: "supplier", id: "s1", label: "CAST Castings Ltd" },
  ],
  source: { kind: "ncr", id: "n1", reference: "SNC-26-0011", title: "Porosity in castings" },
};
const route = (linked) =>
  apiFetch.mockImplementation(async (path) => {
    if (path.startsWith("/fmeas/linked")) return linked;
    if (path.startsWith("/fmea-draft")) return DRAFT;
    if (path.startsWith("/fmea-people")) return { data: [] };
    if (path.startsWith("/fmeas?")) return { data: [], page: 1, pageSize: 100, total: 0 };
    if (path === "/fmeas") return { id: "f9", number: "FMEA-009" };
    return {};
  });
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/ncr"]}>
        <Routes>
          <Route path="/ncr" element={<RaisedFmeas kind="ncr" id="n1" />} />
          <Route path="/FMEA/:id" element={<p>The FMEA page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  held = ["fmea.read", "fmea.manage"];
  apiFetch.mockReset();
});

describe("FMEAs raised from a record (FM13)", () => {
  it("lists the FMEAs raised from the record, with links, and says when there are none", async () => {
    route({ data: [{ id: "f1", number: "FMEA-001", title: "Castings", kind: "process", status: "active", via: ["origin"], reviewOverdue: false }], canRaise: true });
    show();
    const list = await screen.findByRole("list", { name: "FMEAs raised from this record" });
    expect(within(list).getByRole("link", { name: "FMEA-001" })).toHaveAttribute("href", "/FMEA/f1");
    expect(apiFetch).toHaveBeenCalledWith("/fmeas/linked?kind=ncr&id=n1", expect.anything());
  });

  it("says so when none was raised, and offers Start an FMEA only to someone who may", async () => {
    route({ data: [], canRaise: false });
    show();
    expect(await screen.findByText("No FMEA was raised from this non-conformance yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start an FMEA" })).toBeNull();
  });

  it("shows nothing to someone who may not read FMEAs", () => {
    held = [];
    route({ data: [], canRaise: true });
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("starts an FMEA from the record: prefilled, the scope can be trimmed, and the origin is sent", async () => {
    route({ data: [], canRaise: true });
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Start an FMEA" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Raised from non-conformance SNC-26-0011")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Title/)).toHaveValue("Porosity in castings");
    const scope = within(dialog).getByRole("list", { name: "Suggested scope" });
    expect(within(scope).getByText(/BR-100 Bracket/)).toBeInTheDocument();
    await userEvent.click(within(scope).getByRole("button", { name: "Remove CAST Castings Ltd" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Start the FMEA" }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/fmeas",
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({ kind: "process", title: "Porosity in castings", raisedFrom: { kind: "ncr", id: "n1" }, links: [{ kind: "part", id: "p1" }] }),
        }),
      ),
    );
    expect(await screen.findByText("The FMEA page")).toBeInTheDocument();
  });
});

describe("where an FMEA came from", () => {
  const origin = (over) => ({ kind: "ncr", id: "n1", reference: "SNC-26-0011", title: "Porosity in castings", readable: true, ...over });
  const line = (props) => render(<MemoryRouter><RaisedFrom {...props} /></MemoryRouter>);

  it("links to the record it was raised from", () => {
    line({ origin: origin() });
    expect(screen.getByRole("link", { name: "non-conformance SNC-26-0011" })).toHaveAttribute("href", "/Non-Conformance/Register/n1");
    expect(screen.getByText(/Porosity in castings/)).toBeInTheDocument();
  });

  it("does not say what a record is when the caller may not read it", () => {
    line({ origin: origin({ readable: false, reference: null, title: null }) });
    expect(screen.getByText(/a non-conformance you cannot open/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows nothing for an FMEA that was not raised from anything", () => {
    const { container } = line({ origin: null });
    expect(container).toBeEmptyDOMElement();
  });
});
