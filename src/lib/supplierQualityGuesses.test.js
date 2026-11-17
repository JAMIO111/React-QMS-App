import { describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { isPending } from "./optimistic";
import {
  guessAssessment,
  guessCertificate,
  guessIncoming,
  guessReceiving,
  guessScar,
  guessSupplier,
  guessSupplierSettings,
  mergeFlat,
  partFromOption,
} from "./supplierQualityGuesses";

const apiFetch = vi.fn();
const showToast = vi.fn();
vi.mock("./api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

const supplier = {
  id: "s1",
  code: "ACME",
  name: "Acme Ltd",
  approvalStatus: "pending_approval",
  conditions: null,
  reviewOn: null,
  classifications: [{ id: "k1", label: "Foundry" }],
  contacts: [{ id: "c1", name: "Ann", isPrimary: true, active: true }],
  products: [],
};

describe("mergeFlat", () => {
  it("takes flat values for keys the row has, never rowVersion, new keys or nested values", () => {
    const row = { id: "a", name: "Old", active: true, rowVersion: "1", part: { id: "p" } };
    expect(mergeFlat(row, { name: "New", rowVersion: "2", extra: 1, part: { id: "q" } })).toEqual({ ...row, name: "New" });
    expect(mergeFlat(row, { name: "Old" })).toBe(row);
  });
});

describe("guessSupplier", () => {
  it("edits the supplier everywhere it is cached, with the chosen classifications", () => {
    const data = { data: [{ id: "s1", name: "Acme Ltd", approvalStatus: "pending_approval" }] };
    expect(guessSupplier(data, { action: "update", id: "s1", body: { name: "Acme plc" } }).data[0].name).toBe("Acme plc");
    const next = guessSupplier(supplier, { action: "update", id: "s1", body: { name: "Acme plc" }, show: { classifications: [{ id: "k2", label: "Machining" }] } });
    expect(next.name).toBe("Acme plc");
    expect(next.classifications).toEqual([{ id: "k2", label: "Machining" }]);
  });

  it("moves the approval status with its conditions and review date", () => {
    const next = guessSupplier(supplier, { action: "status", id: "s1", body: { status: "suspended", reason: "Late", reviewOn: "2027-01-01" } });
    expect(next).toMatchObject({ approvalStatus: "suspended", conditions: null, reviewOn: "2027-01-01" });
  });

  it("adds a contact as a placeholder, and a new primary replaces the old one", () => {
    const next = guessSupplier(supplier, { action: "addContact", id: "s1", body: { name: "Bob", isPrimary: true } });
    expect(next.contacts).toHaveLength(2);
    expect(next.contacts[0].isPrimary).toBe(false);
    expect(next.contacts[1]).toMatchObject({ name: "Bob", isPrimary: true, active: true });
    expect(isPending(next.contacts[1].id)).toBe(true);
  });

  it("edits a contact inside the profile", () => {
    const next = guessSupplier(supplier, { action: "updateContact", id: "c1", body: { name: "Anne", active: false, isPrimary: false } });
    expect(next.contacts[0]).toMatchObject({ name: "Anne", active: false, isPrimary: false });
  });

  it("links a product with the picked part's name, and switches one off", () => {
    const next = guessSupplier(supplier, { action: "addProduct", id: "s1", body: { kind: "part", partId: "p1", supplierPartNumber: null, notes: null }, show: { part: partFromOption("p1", { name: "PN-1 · Bracket" }) } });
    expect(next.products[0]).toMatchObject({ kind: "part", part: { id: "p1", partNumber: "PN-1", name: "Bracket" }, active: true });
    const off = guessSupplier(next, { action: "updateProduct", id: next.products[0].id, body: { active: false } });
    expect(off.products[0].active).toBe(false);
  });

  it("adds a classification only to the classification lists, and renames one wherever it shows", () => {
    const list = { data: [{ id: "k1", label: "Foundry", active: true, suppliers: 3 }] };
    expect(guessSupplier(list, { action: "createClassification", body: { label: "Plating" } }, ["api", "org", "o", "supplier-quality", "classifications", true]).data[1]).toMatchObject({ label: "Plating", active: true, suppliers: 0 });
    expect(guessSupplier(list, { action: "createClassification", body: { label: "Plating" } }, ["api", "org", "o", "supplier-quality", "list"])).toBe(list);
    expect(guessSupplier(supplier, { action: "updateClassification", id: "k1", body: { label: "Castings" } }).classifications[0].label).toBe("Castings");
  });
});

describe("guessAssessment", () => {
  it("completes with the score the database already worked out, and abandons with the reason", () => {
    const a = { id: "a1", status: "in_progress", score: null, result: null, progress: { score: 82, result: "pass" } };
    expect(guessAssessment(a, { action: "completeAssessment", id: "a1", body: {} })).toMatchObject({ status: "completed", score: 82, result: "pass" });
    const row = { id: "a1", status: "in_progress", score: null, result: null };
    expect(guessAssessment(row, { action: "completeAssessment", id: "a1", body: {}, show: { score: 60, result: "fail" } })).toMatchObject({ score: 60, result: "fail" });
    expect(guessAssessment(a, { action: "abandonAssessment", id: "a1", body: { reason: "Wrong template" } })).toMatchObject({ status: "abandoned", abandonReason: "Wrong template" });
  });
});

describe("guessScar", () => {
  const scar = {
    id: "x1",
    status: "draft",
    responseDueOn: "2026-12-01",
    owner: { id: "u1", name: "Ann" },
    items: [{ id: "i1", material: "Bar", endedAt: null }],
    ncrs: [{ linkId: "l1", ncr: { id: "n1", reference: "SNC-26-0001" }, endedAt: null }],
    responses: [{ id: "r1", seq: 1, review: null }],
    implementations: [],
    extensions: [{ id: "e1", status: "pending" }],
  };

  it("moves the status for a direct step", () => {
    expect(guessScar(scar, { action: "issue", id: "x1" }).status).toBe("issued");
    expect(guessScar(scar, { action: "cancel", id: "x1", body: { reason: "Duplicate" } })).toMatchObject({ status: "cancelled", cancelReason: "Duplicate" });
    const reviewed = guessScar({ ...scar, status: "under_review" }, { action: "review", id: "x1", body: { decision: "accepted", note: "Fine" } });
    expect(reviewed.status).toBe("accepted");
    expect(reviewed.responses[0].review).toMatchObject({ decision: "accepted", note: "Fine" });
  });

  it("records a response and an implementation as placeholder rows", () => {
    const responded = guessScar({ ...scar, status: "issued" }, { action: "respond", id: "x1", body: { rootCause: "Worn tool", correctiveAction: "Replace", respondedOn: "2026-11-17" } });
    expect(responded.status).toBe("response_received");
    expect(responded.responses[1]).toMatchObject({ seq: 2, rootCause: "Worn tool", review: null });
    const implemented = guessScar({ ...scar, status: "accepted" }, { action: "implement", id: "x1", body: { description: "Done", implementedOn: "2026-11-17" } });
    expect(implemented.status).toBe("verifying");
    expect(isPending(implemented.implementations[0].id)).toBe(true);
  });

  it("adds, removes and links items and NCs, and withdraws an extension", () => {
    const added = guessScar(scar, { action: "addItem", id: "x1", body: { material: "Sheet", quantity: 4 } });
    expect(added.items[1]).toMatchObject({ material: "Sheet", quantity: 4, endedAt: null });
    expect(guessScar(scar, { action: "removeItem", id: "i1", body: { reason: "Wrong" } }).items[0]).toMatchObject({ endReason: "Wrong" });
    const linked = guessScar(scar, { action: "linkNcr", id: "x1", body: { ncrId: "n2" }, show: { ncr: { id: "n2", reference: "SNC-26-0002", title: "Burr", stage: "open" } } });
    expect(linked.ncrs[1].ncr.reference).toBe("SNC-26-0002");
    expect(isPending(linked.ncrs[1].linkId)).toBe(true);
    expect(guessScar(scar, { action: "unlinkNcr", id: "l1", body: { reason: "Not ours" } }).ncrs[0].endReason).toBe("Not ours");
    expect(guessScar(scar, { action: "withdrawExtension", id: "e1", body: { reason: "Answered" } }).extensions[0].status).toBe("withdrawn");
  });

  it("changes the owner by name when the edit gives one", () => {
    const next = guessScar(scar, { action: "update", id: "x1", body: { title: "New" }, show: { owner: { id: "u2", name: "Bob" } } });
    expect(next.owner).toEqual({ id: "u2", name: "Bob" });
  });
});

describe("guessReceiving", () => {
  const order = { id: "po1", status: "open", lateLines: 1, lines: [{ id: "pl1", status: "open", agreedOn: null }] };
  it("closes and cancels an order with its open lines, and sets an agreed date", () => {
    expect(guessReceiving(order, { action: "closeOrder", id: "po1" })).toMatchObject({ status: "closed", lateLines: 0, lines: [{ status: "closed" }] });
    expect(guessReceiving(order, { action: "cancelOrder", id: "po1", body: { reason: "Not needed" } })).toMatchObject({ status: "cancelled", cancelReason: "Not needed", lines: [{ status: "cancelled" }] });
    expect(guessReceiving(order, { action: "agreedDate", id: "pl1", body: { agreedOn: "2026-12-24" } }).lines[0].agreedOn).toBe("2026-12-24");
    expect(guessReceiving({ id: "g1", status: "received" }, { action: "cancelReceipt", id: "g1", body: { reason: "Typo" } })).toMatchObject({ status: "cancelled", cancelReason: "Typo" });
  });
});

describe("guessIncoming", () => {
  it("retires a requirement and links / unlinks an NC to a received line", () => {
    expect(guessIncoming({ id: "r1", status: "draft" }, { action: "retireRequirement", id: "r1", body: { reason: "Old" } }).status).toBe("retired");
    const source = { items: [] };
    const key = ["api", "org", "o", "incoming", "ncr-source", "n1"];
    const linked = guessIncoming(source, { action: "linkNcr", id: "n1", body: { receiptLineId: "gl1" }, show: { line: { id: "gl1", reference: "GR-26-0001", lineNumber: 1, quantityReceived: 10 } } }, key);
    expect(linked.items[0]).toMatchObject({ reference: "GR-26-0001", lineNumber: 1 });
    expect(isPending(linked.items[0].linkId)).toBe(true);
    expect(guessIncoming(source, { action: "linkNcr", id: "n2", body: { receiptLineId: "gl1" } }, key)).toBe(source);
    expect(guessIncoming({ items: [{ linkId: "k1" }] }, { action: "unlinkNcr", id: "k1", body: { reason: "Wrong" } }).items).toEqual([]);
  });
});

describe("guessCertificate", () => {
  it("reviews, withdraws and edits a certificate", () => {
    const c = { id: "m1", status: "received", certificateNumber: "A1", reviewNote: null, withdrawalReason: null };
    expect(guessCertificate(c, { action: "review", id: "m1", body: { accept: false, note: "Wrong heat" } })).toMatchObject({ status: "rejected", reviewNote: "Wrong heat" });
    expect(guessCertificate(c, { action: "withdraw", id: "m1", body: { reason: "Duplicate" } })).toMatchObject({ status: "withdrawn", withdrawalReason: "Duplicate" });
    expect(guessCertificate(c, { action: "update", id: "m1", body: { certificateNumber: "A2" } }).certificateNumber).toBe("A2");
  });
});

describe("guessSupplierSettings", () => {
  it("makes the body the overrides, and every value set the one in force", () => {
    const s = { overrides: { graceDaysAfter: null, otdPolicy: null }, effective: { graceDaysAfter: 2, otdPolicy: "agreed" } };
    expect(guessSupplierSettings(s, { graceDaysAfter: 5, otdPolicy: null })).toEqual({ overrides: { graceDaysAfter: 5, otdPolicy: null }, effective: { graceDaysAfter: 5, otdPolicy: "agreed" } });
  });
});

describe("useSupplierMutation", () => {
  it("shows a status move at once, and puts it back with a toast when refused", async () => {
    const { useSupplierMutation } = await import("../hooks/useSupplierQuality");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const detailKey = ["api", "org", "org-1", "supplier-quality", "detail", "s1"];
    client.setQueryData(detailKey, supplier);
    let fail;
    apiFetch.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const wrapper = ({ children }) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useSupplierMutation(), { wrapper });
    act(() => result.current.mutate({ action: "status", id: "s1", body: { status: "suspended", reason: "Late again" } }));
    await waitFor(() => expect(client.getQueryData(detailKey).approvalStatus).toBe("suspended"));
    await act(async () => fail(new Error("Refused")));
    await waitFor(() => expect(client.getQueryData(detailKey).approvalStatus).toBe("pending_approval"));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
});
