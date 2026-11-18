import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", () => ({ apiFetch: (...a) => apiFetch(...a), describeApiError: (e) => e.message }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "o1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../api/supabaseApi", () => ({ uploadFileToSupabase: vi.fn().mockResolvedValue({ path: "o1/lot/l1/x-coc.pdf" }), generateSignedUrl: vi.fn() }));

import LotEvidence from "./LotEvidence";

const file = { id: "f1", customerId: "c1", customerName: "Wayne Ltd", kind: "certificate_of_conformance", description: "Certificate", fileName: "coc.pdf", sizeBytes: 2048, storagePath: "o1/lot/l1/x-coc.pdf", addedAt: "2026-11-17T09:00:00Z", addedBy: "Ada", removedAt: null, removeReason: null };
let data;
const renderIt = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LotEvidence lotId="l1" /></QueryClientProvider>);

beforeEach(() => {
  permissions = ["external_access.share"];
  data = { data: [file], customers: [{ id: "c1", name: "Wayne Ltd" }] };
  apiFetch.mockReset().mockImplementation(async () => data);
});

describe("files shared from a lot", () => {
  it("lists what is shared and with whom", async () => {
    renderIt();
    const ul = await screen.findByRole("list", { name: "Files shared from this lot" });
    expect(ul).toHaveTextContent("coc.pdf");
    expect(ul).toHaveTextContent("Certificate of conformance · Wayne Ltd");
  });

  it("shows nothing to someone who may not share", () => {
    permissions = [];
    const { container } = renderIt();
    expect(container).toBeEmptyDOMElement();
  });

  it("stops sharing a file with a reason", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Stop sharing coc.pdf" }));
    const d = screen.getByRole("dialog");
    expect(within(d).getByRole("button", { name: "Stop sharing" })).toBeDisabled();
    await userEvent.type(within(d).getByLabelText(/Reason/), "Wrong certificate");
    await userEvent.click(within(d).getByRole("button", { name: "Stop sharing" }));
    expect(apiFetch).toHaveBeenCalledWith("/external-access/lot-evidence/f1/remove", expect.objectContaining({ method: "POST", body: { reason: "Wrong certificate" } }));
  });

  it("shares a chosen file with the customer", async () => {
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Share a file" }));
    const d = screen.getByRole("dialog");
    expect(within(d).getByRole("button", { name: "Share" })).toBeDisabled();
    await userEvent.upload(within(d).getByLabelText("Choose the file"), new File(["x"], "report.pdf", { type: "application/pdf" }));
    await userEvent.click(within(d).getByRole("button", { name: "Share" }));
    expect(apiFetch).toHaveBeenCalledWith("/external-access/lots/l1/evidence", expect.objectContaining({ method: "POST", body: expect.objectContaining({ customerId: "c1", kind: "certificate_of_conformance", fileName: "report.pdf", path: "o1/lot/l1/x-coc.pdf" }) }));
  });
});
