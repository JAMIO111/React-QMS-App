import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { draftProblems, revisionLabel } from "../../lib/documents";

let permissions = [];
const mutate = vi.fn();
const saveDraft = vi.fn();
const listCalls = [];
const types = [
  { id: "t1", name: "Procedure", prefix: "SOP", description: null, reviewMonths: 24, contentHint: "text", sequence: 1, active: true, documents: 2 },
  { id: "t2", name: "Form", prefix: "FRM", description: null, reviewMonths: 36, contentHint: "file", sequence: 3, active: true, documents: 0 },
];
const docRow = {
  id: "d1", number: "SOP-001", title: "Control of nonconforming product", type: { id: "t1", name: "Procedure", prefix: "SOP" }, contentKind: "text", description: "All sites",
  owner: { id: "u1", name: "Ann Owner" }, status: "draft", startLetter: "A", lastLetter: null, numberTyped: false, inProgress: { id: "r1", status: "draft", sequence: 1 },
  revisionCount: 1, createdAt: "2026-11-10T08:00:00Z", updatedAt: "2026-11-10T08:00:00Z",
};
const document = {
  ...docRow, nextLetter: "A", canManage: true,
  revisions: [{ id: "r1", sequence: 1, letter: null, status: "draft", author: { id: "u1", name: "Ann Owner" }, changeSummary: null, discardReason: null, discardedAt: null, createdAt: "2026-11-10T08:00:00Z" }],
};
const BODY = { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Purpose" }] }, { type: "paragraph", content: [{ type: "text", text: "Quarantine suspect parts." }] }] };
const textRevision = {
  id: "r1", document: { ...docRow, nextLetter: "A", canManage: true }, sequence: 1, letter: null, plannedLetter: "A", status: "draft", author: { id: "u1", name: "Ann Owner" },
  changeSummary: null, body: BODY, files: [], discardReason: null, discardedAt: null, discardedBy: null, canEdit: true,
};
let revision = textRevision;

vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../../hooks/useCustomFields", () => ({ useCustomFieldPeople: () => ({ data: [{ id: "u1", name: "Ann Owner" }, { id: "u2", name: "Bob Bloggs" }] }) }));
vi.mock("../../hooks/useDocuments", () => ({
  useDocumentTypes: () => ({ data: { data: types }, isLoading: false }),
  useDocuments: (params) => (listCalls.push(params), { data: { data: [docRow], page: 1, pageSize: 50, total: 1 }, isLoading: false }),
  useDocument: () => ({ data: document, isLoading: false }),
  useDocumentRevision: () => ({ data: revision, isLoading: false }),
  useDocumentMutation: () => ({ mutate, isPending: false, error: null, reset: vi.fn() }),
  useDocumentFileMutation: () => ({ mutate, isPending: false, error: null, reset: vi.fn() }),
  useSaveDraft: () => ({ mutate: saveDraft, isPending: false }),
  useToggleDocumentType: () => ({ mutate }),
}));
vi.mock("../ui/FileDrop", () => ({ AttachmentDrop: ({ title, extraBody }) => <div data-testid={`drop-${extraBody.role}`}>{title}</div> }));

import DocumentsPage from "./DocumentsPage";
import DocumentPage from "./DocumentPage";
import RevisionPage from "./RevisionPage";
import SettingsDocuments from "../Settings/SettingsDocuments";

beforeEach(() => {
  mutate.mockReset();
  saveDraft.mockReset();
  listCalls.length = 0;
  revision = textRevision;
  permissions = ["documentation.read", "documentation.manage"];
});

const at = (path, route, element) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>,
  );

describe("documents register", () => {
  it("lists documents with their number, type, owner and status, and filters by status", async () => {
    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    const table = screen.getByRole("table", { name: "Documents" });
    expect(within(table).getByRole("link", { name: "SOP-001" })).toHaveAttribute("href", "/Documentation/Documents/d1");
    expect(within(table).getByText("Procedure")).toBeInTheDocument();
    expect(within(table).getByText("Ann Owner")).toBeInTheDocument();
    expect(within(table).getByText("Not yet issued")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Withdrawn" }));
    expect(listCalls.at(-1)).toMatchObject({ status: "withdrawn" });
    await userEvent.click(within(table).getByRole("button", { name: /Title/ }));
    expect(listCalls.at(-1)).toMatchObject({ sort: "title", order: "asc" });
  });

  it("offers New document only to managers, and creates one from its type", async () => {
    permissions = ["documentation.read"];
    const { unmount } = render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "New document" })).not.toBeInTheDocument();
    unmount();
    permissions = ["documentation.read", "documentation.manage"];
    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "New document" }));
    const dialog = screen.getByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create document" });
    expect(create).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Type/ }));
    await userEvent.click(screen.getByRole("option", { name: /Procedure/ }));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Purchasing");
    expect(create).toBeEnabled();
    await userEvent.click(create);
    expect(mutate).toHaveBeenCalledWith({ action: "createDocument", body: { typeId: "t1", title: "Purchasing", contentKind: "text", description: null, ownerId: "u1" } }, expect.anything());
  });

  it("asks for the number and current letter when bringing a document across", async () => {
    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "New document" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Type/ }));
    await userEvent.click(screen.getByRole("option", { name: /Form/ }));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Calibration record");
    await userEvent.click(within(dialog).getByRole("switch"));
    const create = within(dialog).getByRole("button", { name: "Create document" });
    expect(create).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Its number"), "FRM-020");
    await userEvent.type(within(dialog).getByLabelText("Its current revision letter"), "c");
    await userEvent.click(create);
    expect(mutate.mock.calls[0][0].body).toMatchObject({ typeId: "t2", contentKind: "file", number: "FRM-020", startLetter: "C" });
  });
});

describe("document page", () => {
  it("shows the details, the draft in progress and the revisions", () => {
    at("/Documentation/Documents/d1", "/Documentation/Documents/:id", <DocumentPage />);
    expect(screen.getByRole("heading", { name: "SOP-001" })).toBeInTheDocument();
    expect(screen.getByText(/first revision will be rev A/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the draft" })).toHaveAttribute("href", "/Documentation/Documents/d1/revisions/r1");
    expect(within(screen.getByRole("list", { name: "Revisions" })).getByRole("link", { name: "Draft (will be rev A)" })).toBeInTheDocument();
  });

  it("edits the title and owner", async () => {
    at("/Documentation/Documents/d1", "/Documentation/Documents/:id", <DocumentPage />);
    await userEvent.click(screen.getByRole("button", { name: "Edit details" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText("Title"));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Nonconforming product");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith({ action: "updateDocument", id: "d1", body: { title: "Nonconforming product", description: "All sites", ownerId: "u1" } }, expect.anything());
  });
});

describe("revision page", () => {
  it("shows a text draft in the editor with a toolbar, and saves the change summary when it is left", async () => {
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.getByRole("heading", { name: /SOP-001 · Draft \(will be rev A\)/ })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    expect(screen.getByLabelText("Document text")).toHaveTextContent("Quarantine suspect parts.");
    expect(screen.getByText(/has what it needs/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Change summary" }), "First issue");
    await userEvent.tab();
    expect(saveDraft).toHaveBeenCalledWith({ changeSummary: "First issue" }, expect.anything());
    expect(screen.queryByTestId("drop-main")).not.toBeInTheDocument();
    expect(screen.getByTestId("drop-attachment")).toBeInTheDocument();
  });

  it("asks for a main file on a file draft and shows it read-only to someone who cannot edit", () => {
    revision = { ...textRevision, body: null, document: { ...textRevision.document, contentKind: "file" } };
    const { unmount } = at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.getByText("Upload the main file")).toBeInTheDocument();
    expect(screen.getByTestId("drop-main")).toBeInTheDocument();
    unmount();
    revision = { ...textRevision, canEdit: false };
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard draft" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only document managers can change it/)).toBeInTheDocument();
  });

  it("discards a draft with a reason", async () => {
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    await userEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/document is discarded too/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Why?"), "Not needed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(mutate).toHaveBeenCalledWith({ action: "discardRevision", id: "r1", body: { reason: "Not needed" } }, expect.anything());
  });
});

describe("settings: document types", () => {
  it("lists types and switches one off at once", async () => {
    render(<MemoryRouter><SettingsDocuments /></MemoryRouter>);
    const list = screen.getByRole("list", { name: "Document types" });
    expect(within(list).getByText("SOP")).toBeInTheDocument();
    expect(within(list).getByText(/Review every 36 months/)).toBeInTheDocument();
    await userEvent.click(within(list).getAllByRole("switch")[1]);
    expect(mutate).toHaveBeenCalledWith({ id: "t2", active: false }, expect.anything());
  });

  it("fixes the prefix of a type in use and adds a new one", async () => {
    render(<MemoryRouter><SettingsDocuments /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "Edit Procedure" }));
    expect(within(screen.getByRole("dialog")).getByLabelText("Prefix")).toBeDisabled();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Add type" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Drawing");
    await userEvent.type(within(dialog).getByLabelText("Prefix"), "dw g");
    expect(within(dialog).getByText(/numbered DWG-001/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Add type" }));
    expect(mutate).toHaveBeenCalledWith({ action: "createType", body: { name: "Drawing", reviewMonths: 24, contentHint: "file", description: null, prefix: "DWG" } }, expect.anything());
  });
});

describe("helpers", () => {
  it("labels revisions and lists what a draft still needs", () => {
    expect(revisionLabel({ letter: "B", status: "effective" })).toBe("Rev B");
    expect(revisionLabel({ letter: null, status: "draft" }, "C")).toBe("Draft (will be rev C)");
    expect(revisionLabel({ letter: null, status: "discarded", sequence: 2 })).toBe("Draft 2 (discarded)");
    expect(draftProblems({ ...textRevision, body: { type: "doc", content: [{ type: "paragraph" }] } })).toEqual(["Write the document's text"]);
    expect(draftProblems({ ...textRevision, sequence: 2 })).toEqual(["Say what changed and why"]);
    expect(draftProblems({ ...textRevision, status: "in_review" })).toEqual([]);
  });
});
