import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let permissions = [];
const mutate = vi.fn();
const listCalls = [];
const session = {
  id: "t1", reference: "TS-26-0001", title: "CMM basics", kind: "course", providerType: "internal", trainer: { id: "e9", name: "Tina Trainer" }, providerName: null, providerContact: null,
  startsOn: "2026-11-01", endsOn: null, hours: 4, location: "Lab", notes: null, status: "open", cancelReason: null, reopenReason: null,
  skills: [{ id: "s1", code: "CMM", name: "CMM operation" }], attendeeCount: 3, enrolledCount: 1, completedCount: 2, createdAt: "2026-11-01T08:00:00Z",
  attendees: [
    { id: "a1", employee: { id: "e1", name: "Xavier Xu" }, status: "completed", completedOn: "2026-11-03", note: "Passed", reason: null, recordedBy: "Ann", files: [] },
    { id: "a2", employee: { id: "e2", name: "Yara Yu" }, status: "enrolled", completedOn: null, note: null, reason: null, recordedBy: null, files: [] },
    { id: "a3", employee: { id: "e3", name: "Zed Zhou" }, status: "completed", completedOn: "2026-11-08", note: null, reason: null, recordedBy: null, files: [] },
    { id: "a4", employee: { id: "e4", name: "Old Timer" }, status: "voided", completedOn: "2026-11-02", note: null, reason: "Wrong person ticked", recordedBy: null, files: [] },
  ],
  files: [],
};
let current = session;

vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useNcr", () => ({ useEmployees: () => ({ data: [{ id: "e1", name: "Xavier Xu", active: true }, { id: "e5", name: "Eve Extra", active: true }, { id: "e9", name: "Tina Trainer", active: true }] }) }));
vi.mock("../../hooks/useCompetence", () => ({
  useCompetenceSkills: () => ({ data: { data: [{ id: "s1", code: "CMM", name: "CMM operation" }] }, isLoading: false }),
  useTrainingSessions: (params) => (listCalls.push(params), { data: { data: [{ ...session, title: "CMM basics" }], page: 1, pageSize: 25, total: 1 }, isLoading: false }),
  useTrainingSession: () => ({ data: current, isLoading: false }),
  useCompetenceMutation: () => ({ mutate, isPending: false, error: null, reset: vi.fn(), variables: undefined }),
}));
vi.mock("../ui/FileDrop", () => ({ AttachmentDrop: ({ title }) => <div>{title}</div> }));

import TrainingPage from "./TrainingPage";
import TrainingSessionPage from "./TrainingSessionPage";

beforeEach(() => {
  mutate.mockReset();
  listCalls.length = 0;
  current = session;
  permissions = ["competence.read", "competence.assess"];
});

const openSession = () =>
  render(
    <MemoryRouter initialEntries={["/Competence/Training/t1"]}>
      <Routes>
        <Route path="/Competence/Training/:id" element={<TrainingSessionPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("training register", () => {
  it("lists sessions with provider, dates and how many completed", async () => {
    render(<MemoryRouter><TrainingPage /></MemoryRouter>);
    const table = screen.getByRole("table", { name: "Training sessions" });
    expect(within(table).getByRole("link", { name: "TS-26-0001" })).toHaveAttribute("href", "/Competence/Training/t1");
    expect(within(table).getByText("Tina Trainer")).toBeInTheDocument();
    expect(within(table).getByText("2 of 3 completed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(listCalls.at(-1)).toMatchObject({ status: "closed" });
  });

  it("offers New session only to people who may record training, and creates it with the right body", async () => {
    permissions = ["competence.read"];
    const { unmount } = render(<MemoryRouter><TrainingPage /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: /New session/ })).not.toBeInTheDocument();
    unmount();
    permissions = ["competence.read", "competence.assess"];
    render(<MemoryRouter><TrainingPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: /New session/ }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Welding awareness");
    await userEvent.click(within(dialog).getByLabelText("Kind"));
    await userEvent.click(await screen.findByRole("option", { name: "External" }));
    await userEvent.click(within(dialog).getByLabelText("Run by"));
    await userEvent.click(await screen.findByRole("option", { name: /External \(an outside provider\)/ }));
    expect(within(dialog).queryByLabelText("Trainer")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create session" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Provider or trainer"), "Acme Training");
    await userEvent.click(within(dialog).getByLabelText("Attendees"));
    await userEvent.click(await screen.findByRole("option", { name: /Xavier Xu/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create session" }));
    expect(mutate).toHaveBeenCalledWith(
      { action: "createSession", body: expect.objectContaining({ title: "Welding awareness", kind: "external", providerType: "external", providerName: "Acme Training", trainerEmployeeId: null, employeeIds: ["e1"] }) },
      expect.any(Object),
    );
  });

  it("asks for a trainer when the session is run internally", async () => {
    render(<MemoryRouter><TrainingPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: /New session/ }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText("Run by"));
    await userEvent.click(await screen.findByRole("option", { name: /Internal/ }));
    expect(within(dialog).getByLabelText("Trainer")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Provider or trainer")).not.toBeInTheDocument();
  });
});

describe("training session page", () => {
  it("shows the facts, the attendees with their own dates, and what is left to do", () => {
    openSession();
    expect(screen.getByRole("heading", { name: "CMM basics" })).toBeInTheDocument();
    expect(screen.getByText("Tina Trainer")).toBeInTheDocument();
    expect(screen.getByText("CMM operation")).toBeInTheDocument();
    const list = within(screen.getByRole("list", { name: "Attendees" }));
    expect(list.getByText(/Completed on 2026-11-03/)).toBeInTheDocument();
    expect(list.getByText(/Completed on 2026-11-08/)).toBeInTheDocument();
    expect(screen.getByText("Removed or voided (1)")).toBeInTheDocument();
    expect(screen.getByText(/1 person is still enrolled/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close session" })).toBeDisabled();
  });

  it("records a result for the ticked people only", async () => {
    openSession();
    expect(screen.getByRole("button", { name: /Record a result/ })).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Select Yara Yu"));
    await userEvent.click(screen.getByRole("button", { name: "Record a result (1)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Yara Yu")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    expect(mutate).toHaveBeenCalledWith(
      { action: "recordAttendees", id: "t1", body: expect.objectContaining({ attendeeIds: ["a2"], outcome: "completed", note: null }) },
      expect.any(Object),
    );
  });

  it("needs a note for a failure and no date for did-not-attend", async () => {
    openSession();
    await userEvent.click(screen.getByLabelText("Select Yara Yu"));
    await userEvent.click(screen.getByRole("button", { name: "Record a result (1)" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText("Result"));
    await userEvent.click(await screen.findByRole("option", { name: "Failed" }));
    expect(within(dialog).getByRole("button", { name: "Record" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Note"), "Missed the practical");
    expect(within(dialog).getByRole("button", { name: "Record" })).toBeEnabled();
    await userEvent.click(within(dialog).getByLabelText("Result"));
    await userEvent.click(await screen.findByRole("option", { name: "Did not attend" }));
    expect(within(dialog).queryByLabelText("Completed on")).not.toBeInTheDocument();
  });

  it("voids a recorded result with a reason", async () => {
    openSession();
    await userEvent.click(screen.getByRole("button", { name: "Void Xavier Xu" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Void" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why?"), "Wrong person ticked");
    await userEvent.click(within(dialog).getByRole("button", { name: "Void" }));
    expect(mutate).toHaveBeenCalledWith({ action: "voidAttendee", id: "a1", body: { reason: "Wrong person ticked" } }, expect.any(Object));
  });

  it("closes a session once nobody is enrolled", async () => {
    current = { ...session, enrolledCount: 0, attendees: session.attendees.filter((a) => a.status !== "enrolled") };
    openSession();
    expect(screen.getByText(/Everyone has a result/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close session" }));
    expect(mutate).toHaveBeenCalledWith({ action: "closeSession", id: "t1" }, expect.any(Object));
  });

  it("offers Reopen on a closed session and nothing on a cancelled one", () => {
    current = { ...session, status: "closed", enrolledCount: 0 };
    const { unmount } = openSession();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record a result/ })).not.toBeInTheDocument();
    unmount();
    current = { ...session, status: "cancelled", cancelReason: "Provider cancelled" };
    openSession();
    expect(screen.getByText("Provider cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel session" })).not.toBeInTheDocument();
  });

  it("is read-only without the right to record training", () => {
    permissions = ["competence.read"];
    openSession();
    expect(screen.queryByRole("button", { name: /Record a result|Add a person|Close session|Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select Yara Yu")).not.toBeInTheDocument();
  });
});
