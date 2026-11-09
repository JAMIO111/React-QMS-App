import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
const upload = vi.fn();
const signed = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/api/supabaseApi", () => ({ uploadFileToSupabase: (...a) => upload(...a), generateSignedUrl: (...a) => signed(...a) }));

import { CertificationsCard, DocumentsCard } from "./Qualification";
import ExpiryWatchlistPage from "./ExpiryWatchlistPage";
import { expiryBadge } from "../../lib/supplierQualification";

const cert = (over = {}) => ({
  id: "c1", supplierId: "s1", certType: "iso_9001", title: null, certificateNumber: "Q-123", issuingBody: "BSI", scope: "Machining", issuedOn: "2026-01-01", expiresOn: "2026-12-01",
  document: null, notes: null, status: "current", replacesId: null, expiry: { state: "valid", daysLeft: 200 }, verification: null, withdrawal: null, createdAt: "2026-01-02T00:00:00Z", createdBy: null, ...over,
});
const doc = (over = {}) => ({
  id: "d1", supplierId: "s1", docType: "certificate", title: "ISO certificate", revision: "A", documentDate: null, expiresOn: null, notes: null, storagePath: "org-1/supplier/s1/x-iso.pdf", fileName: "iso.pdf",
  contentType: "application/pdf", sizeBytes: 2048, status: "current", replacesId: null, expiry: { state: "no_expiry", daysLeft: null }, verification: null, removal: null, createdAt: "2026-01-02T00:00:00Z", createdBy: null, ...over,
});
const calls = [];
const routeApi = (routes = {}) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });

const renderUi = (ui, url = "/") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["supplier_quality.read", "supplier_quality.manage"];
  calls.length = 0;
  apiFetch.mockReset();
  upload.mockReset();
  signed.mockReset();
});

describe("expiry badges", () => {
  it("say it in words", () => {
    expect(expiryBadge({ state: "expired", daysLeft: -1 }).label).toBe("Expired yesterday");
    expect(expiryBadge({ state: "expired", daysLeft: -12 }).label).toBe("Expired 12 days ago");
    expect(expiryBadge({ state: "expiring", daysLeft: 0 }).label).toBe("Expires today");
    expect(expiryBadge({ state: "expiring", daysLeft: 1 }).label).toBe("Expires tomorrow");
    expect(expiryBadge({ state: "expiring", daysLeft: 30 }).label).toBe("Expires in 30 days");
    expect(expiryBadge({ state: "valid", daysLeft: 200 }).label).toBe("Valid");
    expect(expiryBadge({ state: "no_expiry", daysLeft: null }).label).toBe("No expiry");
  });
});

describe("certifications", () => {
  it("lists current ones with expiry and verification, warns about an expired one, and keeps past ones folded away", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/certifications": {
        data: [
          cert({ expiry: { state: "expired", daysLeft: -3 }, expiresOn: "2026-11-06" }),
          cert({ id: "c2", certType: "as9100", certificateNumber: "A-1", expiry: { state: "expiring", daysLeft: 20 }, verification: { at: "2026-11-01T10:00:00Z", by: { id: "u1", name: "Ada Owner" }, note: null } }),
          cert({ id: "c3", status: "superseded", certificateNumber: "OLD-1" }),
        ],
      },
      "GET /supplier-quality/suppliers/s1/documents": { data: [] },
    });
    renderUi(<CertificationsCard supplierId="s1" canManage />);
    const list = await screen.findByRole("list", { name: "Current certifications" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Expired 3 days ago")).toBeInTheDocument();
    expect(within(list).getByText("Expires in 20 days")).toBeInTheDocument();
    expect(within(list).getByText("Verified")).toBeInTheDocument();
    expect(within(list).getByText("Not verified")).toBeInTheDocument();
    expect(screen.getByText("A certification has expired")).toBeInTheDocument();
    expect(screen.getByText(/approval status has not changed/)).toBeInTheDocument();
    expect(screen.getByText(/OLD-1 · superseded/)).toBeInTheDocument();
  });

  it("adds a certification with the fields the API needs", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/certifications": { data: [] },
      "GET /supplier-quality/suppliers/s1/documents": { data: [doc()] },
      "POST /supplier-quality/suppliers/s1/certifications": cert(),
    });
    renderUi(<CertificationsCard supplierId="s1" canManage />);
    await screen.findByText("No certifications recorded.");
    await userEvent.click(screen.getByRole("button", { name: "Add certification" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add certification" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter the certificate number");
    await userEvent.type(within(dialog).getByLabelText(/Certificate number/), "Q-123");
    await userEvent.type(within(dialog).getByLabelText(/Issuing body/), "BSI");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add certification" }));
    await waitFor(() => expect(calls.some((c) => c.k === "POST /supplier-quality/suppliers/s1/certifications")).toBe(true));
    expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/certifications").body).toMatchObject({ certType: "iso_9001", certificateNumber: "Q-123", issuingBody: "BSI", expiresOn: null, documentId: null });
  });

  it("offers verify and edit only until verified, renews instead, and withdraws with a reason", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/certifications": { data: [cert(), cert({ id: "c2", certificateNumber: "A-1", verification: { at: "2026-11-01T10:00:00Z", by: null, note: null } })] },
      "GET /supplier-quality/suppliers/s1/documents": { data: [] },
      "POST /supplier-quality/supplier-certifications/c1/withdraw": cert({ status: "withdrawn" }),
    });
    renderUi(<CertificationsCard supplierId="s1" canManage />);
    await screen.findByRole("list", { name: "Current certifications" });
    await userEvent.click(screen.getByRole("button", { name: "Actions for ISO 9001 A-1" }));
    let menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Verify" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Edit details" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Renew" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Actions for ISO 9001 Q-123" }));
    menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Verify" })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Withdraw" }));
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Withdraw" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Why is it being withdrawn/), "Suspended by the body");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/supplier-certifications/c1/withdraw")?.body).toEqual({ reason: "Suspended by the body" }));
  });

  it("shows no add or action controls without supplier_quality.manage", async () => {
    permissions = ["supplier_quality.read"];
    routeApi({ "GET /supplier-quality/suppliers/s1/certifications": { data: [cert()] } });
    renderUi(<CertificationsCard supplierId="s1" canManage={false} />);
    await screen.findByRole("list", { name: "Current certifications" });
    expect(screen.queryByRole("button", { name: "Add certification" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });
});

describe("documents", () => {
  it("uploads the file to the supplier's folder, then records it", async () => {
    upload.mockResolvedValue({ path: "org-1/supplier/s1/uuid-manual.pdf" });
    routeApi({ "GET /supplier-quality/suppliers/s1/documents": { data: [] }, "POST /supplier-quality/suppliers/s1/documents": doc() });
    renderUi(<DocumentsCard supplierId="s1" canManage />);
    await screen.findByText("No documents yet.");
    await userEvent.click(screen.getByRole("button", { name: "Add document" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add document" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give the document a title");
    await userEvent.type(within(dialog).getByLabelText(/Title/), "Quality manual");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add document" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose the file to upload");
    const file = new File(["%PDF"], "manual.pdf", { type: "application/pdf" });
    await userEvent.upload(within(dialog).getByLabelText("File"), file);
    await userEvent.click(within(dialog).getByRole("button", { name: "Add document" }));
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file, "supplier-files", "org-1", "s1", "supplier"));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/documents")?.body).toMatchObject({
      docType: "certificate", title: "Quality manual", storagePath: "org-1/supplier/s1/uuid-manual.pdf", fileName: "manual.pdf", sizeBytes: file.size,
    }));
    expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/documents").body.replacesId).toBeUndefined();
  });

  it("has a drop area that takes a dragged file and suggests the title from its name", async () => {
    routeApi({ "GET /supplier-quality/suppliers/s1/documents": { data: [] } });
    renderUi(<DocumentsCard supplierId="s1" canManage />);
    await screen.findByText("No documents yet.");
    await userEvent.click(screen.getByRole("button", { name: "Add document" }));
    const dialog = screen.getByRole("dialog");
    const file = new File(["%PDF"], "Calibration-report.pdf", { type: "application/pdf" });
    fireEvent.drop(within(dialog).getByTestId("document-drop"), { dataTransfer: { files: [file] } });
    expect(await within(dialog).findByText("Calibration-report.pdf")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Title/)).toHaveValue("Calibration-report");
  });

  it("shows a picture for an image and the icon of its kind for other files", async () => {
    signed.mockResolvedValue("https://files.test/photo.png");
    routeApi({ "GET /supplier-quality/suppliers/s1/documents": { data: [doc({ id: "d1", title: "Manual" }), doc({ id: "d2", title: "Site photo", fileName: "photo.png", contentType: "image/png", storagePath: "org-1/supplier/s1/photo.png" })] } });
    const { container } = renderUi(<DocumentsCard supplierId="s1" canManage />);
    await screen.findByText("Site photo");
    await waitFor(() => expect(container.querySelector('img[src="https://files.test/photo.png"]')).not.toBeNull());
    expect(container.querySelector('img[alt="PDF"]')).not.toBeNull();
    expect(signed).toHaveBeenCalledTimes(1);
  });

  it("adds a document from the certification form and chooses it, without leaving", async () => {
    upload.mockResolvedValue({ path: "org-1/supplier/s1/uuid-iso.pdf" });
    let docs = [];
    routeApi({
      "GET /supplier-quality/suppliers/s1/certifications": { data: [] },
      "GET /supplier-quality/suppliers/s1/documents": () => ({ data: docs }),
      "POST /supplier-quality/suppliers/s1/documents": () => { docs = [doc({ id: "dnew", title: "New ISO scan" })]; return docs[0]; },
    });
    renderUi(<CertificationsCard supplierId="s1" canManage />);
    await userEvent.click(await screen.findByRole("button", { name: "Add certification" }));
    const cert = screen.getByRole("dialog", { name: /certification/i });
    await userEvent.click(within(cert).getByRole("button", { name: "Add a new document" }));
    const dialogs = screen.getAllByRole("dialog");
    const add = dialogs[dialogs.length - 1];
    await userEvent.type(within(add).getByLabelText(/Title/), "New ISO scan");
    await userEvent.upload(within(add).getByLabelText("File"), new File(["%PDF"], "iso.pdf", { type: "application/pdf" }));
    await userEvent.click(within(add).getByRole("button", { name: "Add document" }));
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("combobox", { name: "Evidence document" })).toHaveValue("New ISO scan"));
    expect(calls.some((c) => c.k === "POST /supplier-quality/suppliers/s1/certifications")).toBe(false);
  });

  it("a new version names the document it replaces; superseded and removed ones are listed apart", async () => {
    upload.mockResolvedValue({ path: "org-1/supplier/s1/uuid-v2.pdf" });
    routeApi({
      "GET /supplier-quality/suppliers/s1/documents": { data: [doc(), doc({ id: "d0", title: "Old manual", status: "superseded" }), doc({ id: "dx", title: "Wrong file", status: "removed", removal: { at: "2026-11-02T00:00:00Z", by: null, reason: "Uploaded in error" } })] },
      "POST /supplier-quality/suppliers/s1/documents": doc({ id: "d2" }),
    });
    renderUi(<DocumentsCard supplierId="s1" canManage />);
    const list = await screen.findByRole("list", { name: "Current documents" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/removed: Uploaded in error/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for ISO certificate" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Upload a new version" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/old version stays on record as superseded/)).toBeInTheDocument();
    await userEvent.upload(within(dialog).getByLabelText("File"), new File(["x"], "v2.pdf", { type: "application/pdf" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add document" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/documents")?.body).toMatchObject({ replacesId: "d1", title: "ISO certificate" }));
  });

  it("opens a file through a signed link", async () => {
    signed.mockResolvedValue("https://files.test/signed");
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    routeApi({ "GET /supplier-quality/suppliers/s1/documents": { data: [doc()] } });
    renderUi(<DocumentsCard supplierId="s1" canManage />);
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://files.test/signed", "_blank", "noopener,noreferrer"));
    expect(signed).toHaveBeenCalledWith("supplier-files", "org-1/supplier/s1/x-iso.pdf");
    open.mockRestore();
  });
});

describe("the expiry watchlist", () => {
  const item = (over = {}) => ({ kind: "certification", id: "c1", supplier: { id: "s1", code: "ACME", name: "Acme Metals" }, title: "ISO 9001", detail: "Q-123 · BSI", expiresOn: "2026-11-20", state: "expiring", daysLeft: 11, verified: true, ...over });

  it("lists what to chase, links to the right tab, and changes the window and kind from the URL", async () => {
    routeApi({
      "GET /supplier-quality/expiry-watchlist": (path) => ({
        data: [item({ id: "c0", state: "expired", daysLeft: -2, expiresOn: "2026-11-07", verified: false }), item(), item({ kind: "document", id: "d1", title: "Insurance certificate", detail: null })],
        counts: { expired: 1, expiring: 2 },
        days: Number(new URL(path, "http://x").searchParams.get("days") ?? 60),
      }),
    });
    renderUi(<ExpiryWatchlistPage />, "/Supplier-Quality/Expiry");
    const list = await screen.findByRole("list", { name: "Expiring records" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Expired 2 days ago");
    expect(rows[0]).toHaveTextContent("not verified");
    expect(within(rows[1]).getByRole("link", { name: /ACME · Acme Metals/ })).toHaveAttribute("href", "/Suppliers/s1?tab=qualification");
    expect(within(rows[2]).getByRole("link")).toHaveAttribute("href", "/Suppliers/s1?tab=documents");
    expect(screen.getByText(/within 60 days/, { selector: "p" })).toHaveTextContent("1 expired · 2 expiring within 60 days");
    await userEvent.click(screen.getByRole("button", { name: "30 days" }));
    await waitFor(() => expect(calls.at(-1).path).toContain("days=30"));
  });

  it("says so when there is nothing to chase", async () => {
    routeApi({ "GET /supplier-quality/expiry-watchlist": { data: [], counts: { expired: 0, expiring: 0 }, days: 60 } });
    renderUi(<ExpiryWatchlistPage />, "/Supplier-Quality/Expiry");
    expect(await screen.findByText("Nothing to chase")).toBeInTheDocument();
  });
});
