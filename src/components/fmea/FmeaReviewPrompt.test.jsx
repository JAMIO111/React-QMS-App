import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => held.includes(p), isLoading: false }) }));

import { apiFetch } from "../../lib/api-client";
import { linkPath } from "../../lib/risk";
import { REVISION_KINDS, taskLinkKindLabel, taskLinkPath } from "../../lib/change";
import FmeaReviewPrompt from "./FmeaReviewPrompt";

let held;
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <FmeaReviewPrompt capaId="c1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  held = ["fmea.read"];
  apiFetch.mockReset();
});

describe("Was the FMEA reviewed? (8D prevention step)", () => {
  it("lists the FMEAs in force that cover what the 8D is about, and links to them", async () => {
    apiFetch.mockResolvedValue({
      data: [{ id: "f1", number: "FMEA-001", title: "Machining the bracket", kind: "process", letter: "B", nextReviewOn: "2027-11-01", reviewOverdue: true, via: ["machine", "part"] }],
      canRaise: true,
    });
    show();
    const list = await screen.findByRole("list", { name: "FMEAs that cover this 8D" });
    expect(apiFetch).toHaveBeenCalledWith("/fmeas/linked?kind=capa_scope&id=c1", expect.anything());
    expect(within(list).getByRole("link", { name: "FMEA-001 rev B · Machining the bracket" })).toHaveAttribute("href", "/FMEA/f1");
    expect(within(list).getByText(/covers a machine it concerns and a part it concerns/)).toBeInTheDocument();
    expect(within(list).getByText("Review overdue")).toBeInTheDocument();
  });

  it("says so when no FMEA covers it, and never blocks", async () => {
    apiFetch.mockResolvedValue({ data: [], canRaise: false });
    show();
    expect(await screen.findByText(/No FMEA in force covers the parts or machines of this 8D/)).toBeInTheDocument();
  });

  it("shows nothing, and asks nothing, of someone who may not read FMEAs", () => {
    held = [];
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("FMEA links elsewhere", () => {
  it("a risk's link to a cause opens the revision it sits in, and only when both ids are known", () => {
    expect(linkPath({ kind: "fmea_cause", id: "c1", parentId: "f1", revisionId: "r1" })).toBe("/FMEA/f1/revisions/r1");
    expect(linkPath({ kind: "fmea_cause", id: "c1", parentId: null, revisionId: null })).toBeNull();
  });

  it("a change task can change an FMEA revision, and the link opens it", () => {
    expect(taskLinkKindLabel("fmea_revision")).toBe("FMEA revision");
    expect(taskLinkPath({ kind: "fmea_revision", id: "r1", parentId: "f1", readable: true })).toBe("/FMEA/f1/revisions/r1");
    expect(taskLinkPath({ kind: "fmea_revision", id: "r1", parentId: "f1", readable: false })).toBeNull();
    expect(REVISION_KINDS.map((k) => k.value)).toContain("fmea");
  });
});
