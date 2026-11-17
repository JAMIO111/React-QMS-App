import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../../contexts/ToastProvider";
import EditConflictHost from "./EditConflictDialog";
import { EDIT_MERGED_EVENT, describeValue, docText, resetEditConflicts, versionedSave } from "../../lib/editConflicts";

const ID = "11111111-2222-3333-4444-555555555555";
const OWNER = "99999999-2222-3333-4444-555555555555";
const colin = { id: "colin", name: "Colin Brown" };
const conflict = (details) => Object.assign(new Error("Colin Brown changed this since you opened it"), { status: 409, code: "edit_conflict", details });

const mount = () => {
  const queryClient = new QueryClient();
  // something already on screen knows the person chosen as owner, so the choice can be shown by name
  queryClient.setQueryData(["employees"], { data: [{ id: OWNER, firstName: "Bea", surname: "Smith" }] });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <EditConflictHost />
      </ToastProvider>
    </QueryClientProvider>,
  );
};

describe("describeValue", () => {
  it("puts values in words", () => {
    expect(describeValue(null)).toBe("Empty");
    expect(describeValue(true)).toBe("Yes");
    expect(describeValue({ id: "x", name: "Bore" })).toBe("Bore");
    expect(describeValue(OWNER, () => "Bea Smith")).toBe("Bea Smith");
    expect(describeValue(OWNER)).toBe("Another choice");
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Step one" }] }] };
    expect(docText(doc).trim()).toBe("Step one");
    expect(describeValue(doc)).toBe("Step one");
  });
});

describe("EditConflictHost", () => {
  it("asks per clashing field and saves what the person keeps", async () => {
    resetEditConflicts();
    mount();
    const send = vi.fn(async (path, { method, body }) => {
      if (method === "GET") return { id: ID, title: "Their title", owner: { id: "u2", name: "Dan Jones" } };
      if (body.rowVersion === "10") throw conflict({ version: "15", fields: ["title", "ownerId"], people: [colin], changedBy: colin, changedAt: "2026-11-17T10:42:00Z" });
      return { id: ID, rowVersion: "16" };
    });
    const saving = versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "My title", ownerId: OWNER, rowVersion: "10" } }, async () => "ada");

    const dialog = await screen.findByRole("dialog", { name: "Changed while you were editing" });
    expect(dialog).toHaveTextContent("Colin Brown saved this");
    expect(screen.getByTestId("theirs-title")).toHaveTextContent("Their title");
    expect(screen.getByTestId("mine-title")).toHaveTextContent("My title");
    expect(screen.getByTestId("theirs-ownerId")).toHaveTextContent("Dan Jones");
    expect(screen.getByTestId("mine-ownerId")).toHaveTextContent("Bea Smith");
    // take theirs for the owner only
    const ownerGroup = screen.getByRole("radiogroup", { name: "What to keep for Owner" });
    await userEvent.click(ownerGroup.querySelectorAll("[role=radio]")[1]);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await saving;
    expect(send.mock.calls.at(-1)[1].body).toEqual({ title: "My title", rowVersion: "15" });
    expect(await screen.findByText(/your choices were saved/)).toBeInTheDocument();
  });

  it("shows a note when both changes were kept", async () => {
    mount();
    act(() => window.dispatchEvent(new CustomEvent(EDIT_MERGED_EVENT, { detail: { people: [colin], fields: ["severity"], kept: "both" } })));
    expect(await screen.findByText("Colin Brown also changed Severity; both changes kept.")).toBeInTheDocument();
  });
});
