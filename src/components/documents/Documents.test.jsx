import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { copyStamp, revisionLabel } from "../../lib/documents";
import { notificationLink } from "../../lib/notifications";

let permissions = [];
const mutate = vi.fn();
const saveDraft = vi.fn();
const setSigners = vi.fn();
const openCopy = vi.fn();
let dashboard = null;
let waiting = [];
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
  ...docRow, nextLetter: "A", canManage: true, canIssue: true, canStartRevision: false, currentRevision: null, withdrawReason: null, withdrawnAt: null,
  restricted: false, targets: [], skills: [], readers: { total: 0, acknowledged: 0, overdue: 0 },
  reviewMonths: null, reviewMonthsEffective: 24, nextReviewOn: null, reviewOverdue: false, reviews: [], links: [], changeRequests: [],
  revisions: [{ id: "r1", sequence: 1, letter: null, status: "draft", author: { id: "u1", name: "Ann Owner" }, changeSummary: null, discardReason: null, discardedAt: null, createdAt: "2026-11-10T08:00:00Z" }],
};
const BODY = { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Purpose" }] }, { type: "paragraph", content: [{ type: "text", text: "Quarantine suspect parts." }] }] };
const textRevision = {
  id: "r1", document: { ...docRow, nextLetter: "A", canManage: true }, sequence: 1, letter: null, plannedLetter: "A", status: "draft", author: { id: "u1", name: "Ann Owner" },
  changeSummary: null, body: BODY, files: [], discardReason: null, discardedAt: null, discardedBy: null, canEdit: true,
  problems: [], reviewers: [{ id: "u2", name: "Bob Bloggs" }], approver: { id: "u3", name: "Quinn Manager" }, reviewRound: 0, signoffs: [], myTurn: null,
  previousRevisionId: null, effectiveFrom: null, approvedBy: null, acknowledgeWithinDays: null, myReading: null,
  readers: { total: 0, acknowledged: 0, viewed: 0, overdue: 0 },
};
let myDocs = { toRead: [], acknowledged: [], reviews: 0 };
let recipients = [];
let changeRequests = [];
let inForce = [];
let revision = textRevision;

vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }),
  useAllDepartments: () => ({ data: { data: [{ id: "dep1", code: "ASM", name: "Assembly" }] } }),
  useRoles: () => ({ data: { data: [{ id: "role1", name: "Inspector" }] } }),
  useMembers: () => ({ data: { data: [{ membershipId: "m4", firstName: "Dee", surname: "Doe", status: "active" }] } }),
}));
vi.mock("../../hooks/useProcessControl", () => ({ usePartFamilies: () => ({ data: { items: [{ id: "f1", code: "BRK", name: "Brackets" }] } }) }));
vi.mock("../ncr/Pickers", () => ({
  PartPicker: ({ label, onChange }) => <button type="button" onClick={() => onChange("p1", { id: "p1", name: "P-100 · Bracket" })}>{label}</button>,
  MachinePicker: ({ label, onChange }) => <button type="button" onClick={() => onChange("m1", { id: "m1", name: "Deburr cell" })}>{label}</button>,
}));
vi.mock("../../hooks/useCompetence", () => ({ useCompetenceSkills: () => ({ data: { data: [{ id: "k1", code: "TORQ", name: "Torque tightening" }] } }) }));
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
  useSaveDraft: () => ({ mutate: saveDraft, mutateAsync: (b) => Promise.resolve(saveDraft(b)), isPending: false }),
  useToggleDocumentType: () => ({ mutate }),
  useWaitingReviews: () => ({ data: waiting }),
  useDocumentSigners: () => ({ data: [{ id: "u1", name: "Ann Owner", canApprove: true }, { id: "u2", name: "Bob Bloggs", canApprove: false }, { id: "u3", name: "Quinn Manager", canApprove: true }, { id: "u4", name: "Dee Doe", canApprove: false }] }),
  useSetSigners: () => ({ mutate: setSigners }),
  useSetRestricted: () => ({ mutate: (v, o) => mutate({ action: "restricted", body: v }, o) }),
  useMyDocuments: () => ({ data: myDocs, isLoading: false }),
  useDocumentRecipients: () => ({ data: recipients, isLoading: false }),
  useChangeRequests: () => ({ data: changeRequests, isLoading: false }),
  useDocumentsInForce: () => ({ data: inForce }),
  useControlledCopy: () => ({ mutate: openCopy, isPending: false }),
  useDocumentsDashboard: () => ({ data: dashboard, isLoading: false, isFetching: false, error: null }),
  useDocumentCompare: () => ({
    data: { against: { id: "r0", label: "Rev A" }, text: [{ kind: "same", text: "Purpose", block: "Heading 1" }, { kind: "removed", text: "Old step", block: "Paragraph" }, { kind: "added", text: "New step", block: "Paragraph" }], textSummary: { added: 1, removed: 1, same: 1 }, files: [] },
    isLoading: false,
  }),
}));
vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal();
  const { cloneElement } = await import("react");
  return { ...mod, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 300 }) };
});
vi.mock("../ui/FileDrop", () => ({ AttachmentDrop: ({ title, extraBody }) => <div data-testid={`drop-${extraBody.role}`}>{title}</div> }));

import DocumentsPage from "./DocumentsPage";
import DocumentPage from "./DocumentPage";
import RevisionPage from "./RevisionPage";
import SettingsDocuments from "../Settings/SettingsDocuments";
import MyDocumentsPage from "./MyDocumentsPage";
import ChangeRequestsPage from "./ChangeRequestsPage";
import DocumentsInForce from "./DocumentsInForce";
import DocumentsDashboard from "./DocumentsDashboard";

beforeEach(() => {
  mutate.mockReset();
  saveDraft.mockReset();
  setSigners.mockReset();
  openCopy.mockReset();
  waiting = [];
  myDocs = { toRead: [], acknowledged: [], reviews: 0 };
  recipients = [];
  changeRequests = [];
  inForce = [];
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
    await userEvent.click(within(dialog).getByRole("switch", { name: /Bringing an existing/ }));
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
    expect(screen.getByText(/becomes rev A when it is sent for review/)).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Send for review" })).toBeEnabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Change summary" }), "First issue");
    await userEvent.tab();
    expect(saveDraft).toHaveBeenCalledWith({ changeSummary: "First issue" }, expect.anything());
    expect(screen.queryByTestId("drop-main")).not.toBeInTheDocument();
    expect(screen.getByTestId("drop-attachment")).toBeInTheDocument();
  });

  it("asks for a main file on a file draft and shows it read-only to someone who cannot edit", () => {
    revision = { ...textRevision, body: null, problems: ["Upload the main file"], document: { ...textRevision.document, contentKind: "file" } };
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

describe("review and approval", () => {
  const open = () => at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);

  it("names reviewers and the approver (not the author; only those who can approve) and sends it for review", async () => {
    open();
    await userEvent.click(screen.getByRole("combobox", { name: /Reviewers/ }));
    expect(screen.queryByRole("option", { name: /Ann Owner/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /Dee Doe/ }));
    expect(setSigners).toHaveBeenCalledWith(expect.objectContaining({ reviewerIds: ["u2", "u4"], approverId: "u3" }), expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Remove Bob Bloggs" }));
    expect(setSigners.mock.calls[1][0]).toMatchObject({ reviewerIds: [], approverId: "u3" });
    await userEvent.click(screen.getByRole("combobox", { name: /Approver/ }));
    expect(screen.getByRole("option", { name: /Bob Bloggs/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("button", { name: "Send for review" }));
    expect(mutate).toHaveBeenCalledWith({ action: "submit", id: "r1" }, expect.anything());
  });

  it("keeps Send for review off while something is still needed", () => {
    revision = { ...textRevision, problems: ["Name the approver"] };
    open();
    expect(screen.getByText("Name the approver")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send for review" })).toBeDisabled();
  });

  it("lets a reviewer accept, or send back with what needs changing", async () => {
    revision = {
      ...textRevision, status: "in_review", letter: "A", canEdit: false, reviewRound: 1, myTurn: "review",
      signoffs: [{ id: "s1", round: 1, role: "reviewer", person: { id: "u2", name: "Bob Bloggs" }, decision: "pending", comment: null, decidedAt: null }],
    };
    open();
    expect(screen.getByText("Your review is needed")).toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(mutate).toHaveBeenCalledWith({ action: "review", id: "r1", body: { accept: true } }, expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Send back" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Send back" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("What needs changing?"), "Add the label");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send back" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "review", id: "r1", body: { accept: false, comment: "Add the label" } }, expect.anything());
  });

  it("lets the approver approve with the date it takes effect", async () => {
    revision = { ...textRevision, status: "awaiting_approval", letter: "A", canEdit: false, reviewRound: 1, myTurn: "approve" };
    open();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/in force as soon as you approve it/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(mutate.mock.calls[0][0]).toMatchObject({ action: "approve", id: "r1", body: { effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } });
  });

  it("shows the sign-offs of every round and what changed against the last revision", async () => {
    revision = {
      ...textRevision, status: "draft", letter: "B", sequence: 2, reviewRound: 1, previousRevisionId: "r0",
      signoffs: [{ id: "s1", round: 1, role: "reviewer", person: { id: "u2", name: "Bob Bloggs" }, decision: "returned", comment: "Add the label", decidedAt: "2026-11-10T09:00:00Z" }],
    };
    open();
    expect(screen.getByText("Sent back")).toBeInTheDocument();
    expect(screen.getByText(/Bob Bloggs: Add the label/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    const changes = screen.getByRole("list", { name: "Text changes" });
    expect(within(changes).getByText("New step").closest("li")).toHaveTextContent("Added:");
    expect(within(changes).getByText("Old step").closest("li")).toHaveTextContent("Removed:");
  });

  it("lists what is waiting for the person on the register", () => {
    waiting = [{ role: "approver", since: "2026-11-10T09:00:00Z", revision: { id: "r1", letter: "A", status: "awaiting_approval" }, document: { id: "d1", number: "SOP-001", title: "Control" }, author: "Ann" }];
    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    const list = screen.getByRole("list", { name: "Waiting for you" });
    expect(within(list).getByRole("link", { name: /SOP-001 rev A/ })).toHaveAttribute("href", "/Documentation/Documents/d1/revisions/r1");
    expect(within(list).getByText(/approve it/)).toBeInTheDocument();
  });
});

describe("document in force", () => {
  it("shows the revision in force, starts a new revision and withdraws with a reason", async () => {
    Object.assign(document, { status: "active", inProgress: null, canStartRevision: true, currentRevision: { id: "r1", letter: "A", effectiveFrom: "2026-11-10" } });
    try {
      at("/Documentation/Documents/d1", "/Documentation/Documents/:id", <DocumentPage />);
      expect(screen.getByText("Rev A is in force")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Start a new revision" }));
      expect(mutate).toHaveBeenCalledWith({ action: "startRevision", id: "d1" }, expect.anything());
      await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
      const dialog = screen.getByRole("dialog");
      await userEvent.type(within(dialog).getByLabelText("Why?"), "Replaced by the manual");
      await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "withdraw", id: "d1", body: { reason: "Replaced by the manual" } }, expect.anything());
    } finally {
      Object.assign(document, { status: "draft", inProgress: { id: "r1", status: "draft", sequence: 1 }, canStartRevision: false, currentRevision: null });
    }
  });
});

describe("readers and acknowledgement", () => {
  it("adds readers by department, role or person, restricts the document and names the skills it trains", async () => {
    permissions = ["documentation.read", "documentation.manage", "members.read", "competence.read"];
    Object.assign(document, { targets: [{ id: "t1", kind: "role", refId: "role1", label: "Inspector" }], skills: [] });
    try {
      at("/Documentation/Documents/d1", "/Documentation/Documents/:id", <DocumentPage />);
      expect(within(screen.getByRole("list", { name: "Readers" })).getByText("Inspector")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("combobox", { name: /Add a department/ }));
      await userEvent.click(screen.getByRole("option", { name: /Assembly/ }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "setReaders", id: "d1", body: { targets: [{ roleId: "role1" }, { departmentId: "dep1" }] } }, expect.anything());
      await userEvent.click(screen.getByRole("button", { name: "Remove Inspector" }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "setReaders", id: "d1", body: { targets: [] } }, expect.anything());
      await userEvent.click(screen.getByRole("switch", { name: "Restricted" }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "restricted", body: true }, expect.anything());
      await userEvent.click(screen.getByRole("combobox", { name: /Add a skill/ }));
      await userEvent.click(screen.getByRole("option", { name: /Torque tightening/ }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "setSkills", id: "d1", body: { skillIds: ["k1"] } }, expect.anything());
    } finally {
      Object.assign(document, { targets: [], skills: [] });
    }
  });

  it("asks a reader to acknowledge the revision in force, with an optional note", async () => {
    revision = { ...textRevision, status: "effective", letter: "A", canEdit: false, myReading: { dueOn: "2099-01-01", viewedAt: "2026-11-10T09:00:00Z", acknowledgedAt: null, note: null } };
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.getByText("Please read and acknowledge it")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Note"), "Read at the briefing");
    await userEvent.click(within(dialog).getByRole("button", { name: "I have read it" }));
    expect(mutate).toHaveBeenCalledWith({ action: "acknowledge", id: "r1", body: { note: "Read at the briefing" } }, expect.anything());
  });

  it("shows an overdue request in red, and a done one with its date", () => {
    revision = { ...textRevision, status: "effective", letter: "A", canEdit: false, myReading: { dueOn: "2020-01-01", viewedAt: null, acknowledgedAt: null, note: null } };
    const { unmount } = at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.getByText(/Overdue: please read/)).toBeInTheDocument();
    unmount();
    revision = { ...textRevision, status: "effective", letter: "A", canEdit: false, myReading: { dueOn: null, viewedAt: "2026-11-10T09:00:00Z", acknowledgedAt: "2026-11-10T10:00:00Z", note: "OK" } };
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.getByText("You acknowledged it")).toBeInTheDocument();
  });

  it("shows managers who has read it, flags the overdue and adds a reader", async () => {
    revision = { ...textRevision, status: "effective", letter: "A", canEdit: false, readers: { total: 2, acknowledged: 1, viewed: 2, overdue: 1 } };
    recipients = [
      { id: "x1", person: { id: "u2", name: "Bob Bloggs" }, reachedVia: ["Role: Inspector"], dueOn: "2020-01-01", viewedAt: "2026-11-10T09:00:00Z", acknowledgedAt: null, note: null, overdue: true },
      { id: "x2", person: { id: "u4", name: "Dee Doe" }, reachedVia: ["Named"], dueOn: null, viewedAt: "2026-11-10T09:00:00Z", acknowledgedAt: "2026-11-10T10:00:00Z", note: null, overdue: false },
    ];
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.getByText(/1 of 2 acknowledged · 2 viewed · 1 overdue/)).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Readers" })).getByText(/\(overdue\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add a reader" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Person/ }));
    expect(screen.queryByRole("option", { name: /Dee Doe/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /Quinn Manager/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(mutate).toHaveBeenCalledWith({ action: "addRecipient", id: "r1", body: { userId: "u3" } }, expect.anything());
  });

  it("saves how many days readers have when the field is left", async () => {
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    await userEvent.type(screen.getByLabelText("Days readers have to acknowledge it"), "14");
    await userEvent.tab();
    expect(saveDraft).toHaveBeenCalledWith({ acknowledgeWithinDays: 14 }, expect.anything());
  });

  it("lists my documents to read, overdue first, and what I read lately", () => {
    myDocs = {
      toRead: [{ document: { id: "d1", number: "SOP-001", title: "Torque" }, revision: { id: "r1", letter: "A" }, dueOn: "2020-01-01", overdue: true, viewedAt: null }],
      acknowledged: [{ document: { id: "d2", number: "WI-003", title: "Packing" }, revision: { id: "r9", letter: "C" }, acknowledgedAt: "2026-11-01T10:00:00Z" }],
      reviews: 0,
    };
    render(<MemoryRouter><MyDocumentsPage /></MemoryRouter>);
    const toRead = screen.getByRole("list", { name: "To read" });
    expect(within(toRead).getByRole("link", { name: /SOP-001 rev A/ })).toHaveAttribute("href", "/Documentation/Documents/d1/revisions/r1");
    expect(within(toRead).getByText(/Overdue since/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Read lately" })).getByText(/WI-003 rev C/)).toBeInTheDocument();
    expect(screen.getByText("Nothing waiting for you.")).toBeInTheDocument();
  });
});

describe("periodic review, change requests and links", () => {
  const inForceDoc = (extra) => Object.assign(document, { status: "active", inProgress: null, currentRevision: { id: "r1", letter: "A", effectiveFrom: "2026-11-10" }, ...extra });
  const reset = () => Object.assign(document, { status: "draft", inProgress: { id: "r1", status: "draft", sequence: 1 }, currentRevision: null, nextReviewOn: null, reviewOverdue: false, reviews: [], links: [], changeRequests: [], reviewMonths: null });

  it("shows when the review is due, flags it overdue, and records 'no change needed' with what was checked", async () => {
    inForceDoc({ nextReviewOn: "2020-01-01", reviewOverdue: true });
    try {
      at("/Documentation/Documents/d1", "/Documentation/Documents/:id", <DocumentPage />);
      expect(screen.getByText("Review overdue")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Record a review" }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("button", { name: "Record the review" })).toBeDisabled();
      await userEvent.type(within(dialog).getByLabelText("What was checked"), "Checked against the drawing");
      await userEvent.click(within(dialog).getByRole("button", { name: "Record the review" }));
      expect(mutate).toHaveBeenCalledWith({ action: "recordReview", id: "d1", body: { outcome: "no_change", note: "Checked against the drawing" } }, expect.anything());
    } finally {
      reset();
    }
  });

  it("saves the document's own review interval when the field is left", async () => {
    inForceDoc({ nextReviewOn: "2027-11-10" });
    try {
      at("/Documentation/Documents/d1", "/Documentation/Documents/:id", <DocumentPage />);
      await userEvent.type(screen.getByLabelText("Its own interval in months"), "6");
      await userEvent.tab();
      expect(mutate).toHaveBeenCalledWith({ action: "updateDocument", id: "d1", body: { reviewMonths: 6 } }, expect.anything());
    } finally {
      reset();
    }
  });

  it("links the document to a part, family, machine and operation", async () => {
    inForceDoc({ links: [{ id: "l1", kind: "operation", refId: "OP-20", label: "OP-20" }] });
    try {
      at("/Documentation/Documents/d1", "/Documentation/Documents/:id", <DocumentPage />);
      expect(within(screen.getByRole("list", { name: "Where it applies" })).getByText("OP-20")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Add a machine" }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "setLinks", id: "d1", body: { links: [{ operationCode: "OP-20" }, { machineId: "m1" }] } }, expect.anything());
      await userEvent.type(screen.getByLabelText("Add an operation"), "op-20");
      await userEvent.click(screen.getByRole("button", { name: "Add the operation" }));
      expect(mutate).toHaveBeenCalledTimes(1);
    } finally {
      reset();
    }
  });

  it("asks for a change, and lets a manager accept or decline one with a reason", async () => {
    const open = { id: "c1", reference: "DCR-26-0001", document: { id: "d1", number: "SOP-001", title: "Control" }, what: "Add the label", why: "Complaint", status: "open",
      requestedBy: { id: "u9", name: "Dee Doe" }, decidedBy: null, decidedAt: null, decisionReason: null, revision: null, createdAt: "2026-11-10T09:00:00Z" };
    inForceDoc({ changeRequests: [open] });
    try {
      at("/Documentation/Documents/d1", "/Documentation/Documents/:id", <DocumentPage />);
      await userEvent.click(screen.getByRole("button", { name: "Ask for a change" }));
      let dialog = screen.getByRole("dialog");
      await userEvent.type(within(dialog).getByLabelText("What should change"), "Fix step 2");
      await userEvent.type(within(dialog).getByLabelText("Why"), "Reads badly");
      await userEvent.click(within(dialog).getByRole("button", { name: "Send the request" }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "raiseChangeRequest", id: "d1", body: { what: "Fix step 2", why: "Reads badly" } }, expect.anything());
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      const list = screen.getByRole("list", { name: "Change requests" });
      await userEvent.click(within(list).getByRole("button", { name: "Accept into a revision" }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "acceptChangeRequest", id: "c1" }, expect.anything());
      await userEvent.click(within(list).getByRole("button", { name: "Decline" }));
      dialog = screen.getByRole("dialog");
      await userEvent.type(within(dialog).getByLabelText("Why?"), "Covered elsewhere");
      await userEvent.click(within(dialog).getByRole("button", { name: "Decline" }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "declineChangeRequest", id: "c1", body: { reason: "Covered elsewhere" } }, expect.anything());
      expect(within(list).queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument();
    } finally {
      reset();
    }
  });

  it("lists change requests and lets the person who asked withdraw theirs", async () => {
    permissions = ["documentation.read"];
    changeRequests = [{ id: "c2", reference: "DCR-26-0002", document: { id: "d1", number: "SOP-001", title: "Control" }, what: "Fix step 2", why: "Reads badly", status: "open",
      requestedBy: { id: "u1", name: "Ann Owner" }, decidedBy: null, decidedAt: null, decisionReason: null, revision: null, createdAt: "2026-11-10T09:00:00Z" }];
    render(<MemoryRouter><ChangeRequestsPage /></MemoryRouter>);
    const list = screen.getByRole("list", { name: "Change requests" });
    expect(within(list).getByRole("link", { name: /SOP-001 Control/ })).toHaveAttribute("href", "/Documentation/Documents/d1");
    expect(within(list).queryByRole("button", { name: "Accept into a revision" })).not.toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Withdraw" }));
    expect(mutate).toHaveBeenCalledWith({ action: "withdrawChangeRequest", id: "c2" }, expect.anything());
  });

  it("shows the documents in force where work happens, and nothing when there are none", () => {
    const { container, unmount } = render(<MemoryRouter><DocumentsInForce partId="p1" /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
    unmount();
    inForce = [{ id: "d1", number: "SOP-001", title: "Deburring", type: "Procedure", revision: { id: "r1", letter: "A", effectiveFrom: "2026-11-10" }, matched: ["part family"], toAcknowledge: true }];
    render(<MemoryRouter><DocumentsInForce partId="p1" /></MemoryRouter>);
    expect(screen.getByText("1 document applies to this work")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /SOP-001 rev A/ })).toHaveAttribute("href", "/Documentation/Documents/d1/revisions/r1");
    expect(screen.getByText("To read")).toBeInTheDocument();
  });
});

const PDF = { id: "f1", role: "main", fileName: "spec.pdf", contentType: "application/pdf", sizeBytes: 10, deletedAt: null, createdAt: "2026-11-10T08:00:00Z" };
const externalDoc = { ...textRevision.document, number: "EXT-001", contentKind: "file", origin: "external", issuer: "Acme Ltd", externalReference: "ACS-1001", status: "draft" };

describe("external documents and controlled copies", () => {
  it("creates an external document with who issues it, always a file", async () => {
    render(<MemoryRouter><DocumentsPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "New document" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Type/ }));
    await userEvent.click(screen.getByRole("option", { name: /Procedure/ }));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Customer specification");
    await userEvent.click(within(dialog).getByRole("switch", { name: /External/ }));
    const create = within(dialog).getByRole("button", { name: "Create document" });
    expect(create).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Issued by"), "Acme Ltd");
    await userEvent.type(within(dialog).getByLabelText("Their reference"), "ACS-1001");
    await userEvent.click(create);
    expect(mutate.mock.calls[0][0].body).toMatchObject({ contentKind: "file", origin: "external", issuer: "Acme Ltd", externalReference: "ACS-1001" });
  });

  it("records an external draft as issued instead of sending it for review", async () => {
    revision = { ...textRevision, document: externalDoc, body: null, files: [PDF], reviewers: [], approver: null, canRecordIssue: true };
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.getByText(/issued by Acme Ltd \(ACS-1001\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send for review" })).not.toBeInTheDocument();
    expect(screen.queryByText("Reviewers and approver")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record this issue" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Record as issued" });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Their revision"), "Issue 3");
    await userEvent.click(save);
    expect(mutate.mock.calls[0][0]).toMatchObject({ action: "issueExternal", id: "r1", body: { issuerRevision: "Issue 3" } });
    expect(mutate.mock.calls[0][0].body.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("opens a stamped controlled copy of a PDF, and says other files are uncontrolled", async () => {
    revision = { ...textRevision, status: "effective", letter: "A", canEdit: false, body: null, files: [PDF], document: { ...textRevision.document, contentKind: "file", status: "active" } };
    const { unmount } = at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    await userEvent.click(screen.getByRole("button", { name: "Open a controlled copy" }));
    expect(openCopy).toHaveBeenCalledWith("f1", expect.anything());
    unmount();
    revision = { ...revision, files: [{ ...PDF, fileName: "spec.docx", contentType: "application/msword" }] };
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.getByText("Uncontrolled when printed or saved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /controlled copy/ })).not.toBeInTheDocument();
  });

  it("prints a written document with the stamp", async () => {
    let printed = "";
    const print = vi.spyOn(window, "print").mockImplementation(() => (printed = globalThis.document.getElementById("document-print")?.textContent ?? ""));
    at("/Documentation/Documents/d1/revisions/r1", "/Documentation/Documents/:id/revisions/:revisionId", <RevisionPage />);
    expect(screen.queryByText(/NOT FOR USE/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Print or save as PDF" }));
    expect(print).toHaveBeenCalled();
    expect(printed).toMatch(/NOT ISSUED - NOT FOR USE - SOP-001 draft/);
    expect(printed).toMatch(/Quarantine suspect parts/);
    expect(screen.queryByText(/NOT FOR USE/)).not.toBeInTheDocument();
    print.mockRestore();
  });
});

describe("documents dashboard", () => {
  it("shows what is in force, what is waiting and what is due", () => {
    dashboard = {
      period: { from: "2026-08-13", to: "2026-11-11", bucket: "week" },
      kpis: { inForce: 12, external: 3, withdrawn: 1, drafts: 2, inReview: 1, awaitingApproval: 1, approvedWaiting: 1, reviewsOverdue: 2, reviewsDue30: 1, readersOverdue: 4, readersPending: 9, changeRequestsOpen: 3, madeEffective: 5, acknowledgements: 20, changeRequestsRaised: 2 },
      byType: [{ typeId: "t1", name: "Procedure", prefix: "SOP", inForce: 9, inProgress: 2 }],
      activity: [],
      waiting: [{ documentId: "d1", number: "SOP-001", title: "Control of nonconforming product", revisionId: "r1", letter: "B", status: "in_review", since: "2026-10-01", days: 41 }],
      reviewsDue: [{ documentId: "d2", number: "SOP-002", title: "Purchasing", nextReviewOn: "2026-11-01", days: -10 }],
      readersBehind: [],
      effectiveSoon: [],
    };
    render(<MemoryRouter><DocumentsDashboard /></MemoryRouter>);
    expect(screen.getByRole("link", { name: /In force\s*12/ })).toHaveAttribute("href", "/Documentation/Documents?status=active");
    expect(screen.getByText("3 external · 1 withdrawn")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reviews overdue\s*2/ })).toHaveAttribute("href", "/Documentation/Documents?review=true");
    expect(within(screen.getByRole("table", { name: "Revisions waiting" })).getByRole("link", { name: /SOP-001 rev B/ })).toHaveAttribute("href", "/Documentation/Documents/d1/revisions/r1");
    expect(within(screen.getByRole("table", { name: "Periodic reviews due" })).getByText(/10 days ago/)).toBeInTheDocument();
    expect(screen.getByText("Every reader is up to date.")).toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("labels revisions and links a sign-off notice to its revision", () => {
    expect(revisionLabel({ letter: "B", status: "effective" })).toBe("Rev B");
    expect(revisionLabel({ letter: "A", status: "effective", issuerRevision: "Issue 3" })).toBe("Rev A (Issue 3)");
    expect(copyStamp({ status: "effective", letter: "B", effectiveFrom: "2026-11-01" }, "SOP-001").head).toBe("CONTROLLED COPY - SOP-001 rev B");
    expect(copyStamp({ status: "superseded", letter: "A" }, "SOP-001")).toMatchObject({ usable: false, head: "SUPERSEDED - NOT FOR USE - SOP-001 rev A" });
    expect(revisionLabel({ letter: null, status: "draft" }, "C")).toBe("Draft (will be rev C)");
    expect(revisionLabel({ letter: null, status: "discarded", sequence: 2 })).toBe("Draft 2 (discarded)");
    expect(notificationLink({ entityType: "document_signoffs", details: { document_id: "d1", revision_id: "r1" } })).toBe("/Documentation/Documents/d1/revisions/r1");
    expect(notificationLink({ entityType: "document_recipients", details: { document_id: "d1", revision_id: "r2" } })).toBe("/Documentation/Documents/d1/revisions/r2");
  });
});
