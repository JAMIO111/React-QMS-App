import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_MERGED_EVENT, fieldLabel, latestOwnVersion, recordKey, recordPath, resetEditConflicts, setConflictResolver, versionedSave } from "./editConflicts";

const ID = "11111111-2222-3333-4444-555555555555";
const conflict = (details) => Object.assign(new Error("Colin Brown changed this since you opened it"), { status: 409, code: "edit_conflict", details });
const colin = { id: "colin", name: "Colin Brown" };

let merged;
const onMerged = (e) => merged.push(e.detail);
beforeEach(() => {
  resetEditConflicts();
  merged = [];
  window.addEventListener(EDIT_MERGED_EVENT, onMerged);
});
afterEach(() => window.removeEventListener(EDIT_MERGED_EVENT, onMerged));

const me = async () => "ada";

describe("paths and names", () => {
  it("finds the record a save is for", () => {
    expect(recordKey(`/ncrs/${ID}`)).toBe(ID);
    expect(recordPath(`/management-reviews/${ID}/minutes`)).toBe(`/management-reviews/${ID}`);
    expect(recordKey("/ncrs")).toBeNull();
  });
  it("names fields in words", () => {
    expect(fieldLabel("quantityAffected")).toBe("Quantity affected");
    expect(fieldLabel("ownerId")).toBe("Owner");
  });
});

describe("versionedSave", () => {
  it("sends the version and remembers what this person's save produced", async () => {
    const send = vi.fn(async () => ({ id: ID, rowVersion: "20" }));
    await versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "A", rowVersion: "10" } }, me);
    expect(send).toHaveBeenCalledWith(`/ncrs/${ID}`, { method: "PATCH", body: { title: "A", rowVersion: "10" } });
    expect(latestOwnVersion(ID, "10")).toBe("20");
    // a second save from a screen that has not refetched yet goes on the newer version, not against itself
    await versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "B", rowVersion: "10" } }, me);
    expect(send.mock.calls[1][1].body.rowVersion).toBe("20");
  });

  it("runs saves of one record one at a time", async () => {
    const order = [];
    let release;
    const send = vi.fn(async (_p, { body }) => {
      order.push(`start ${body.title}`);
      if (body.title === "A") await new Promise((r) => (release = r));
      order.push(`end ${body.title}`);
      return { id: ID, rowVersion: body.title === "A" ? "20" : "30" };
    });
    const a = versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "A", rowVersion: "10" } }, me);
    const b = versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "B", rowVersion: "10" } }, me);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["start A", "end A", "start B", "end B"]);
    expect(send.mock.calls[1][1].body.rowVersion).toBe("20");
  });

  it("saves again on the new version when nobody else changed the same field, and says so", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(conflict({ version: "15", fields: ["severity"], people: [colin], changedBy: colin }))
      .mockResolvedValueOnce({ id: ID, rowVersion: "16" });
    const answer = await versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "Mine", rowVersion: "10" } }, me);
    expect(answer.rowVersion).toBe("16");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1].body).toEqual({ title: "Mine", rowVersion: "15" });
    expect(merged).toEqual([expect.objectContaining({ kept: "both", fields: ["severity"], people: [colin] })]);
  });

  it("asks when the same field changed, and saves what the person keeps", async () => {
    const send = vi.fn(async (path, { method, body }) => {
      if (method === "GET") return { id: ID, title: "Theirs", description: "Their words", rowVersion: "15" };
      if (body.rowVersion === "10") throw conflict({ version: "15", fields: ["title", "description"], people: [colin], changedBy: colin });
      return { id: ID, rowVersion: "16" };
    });
    const resolver = vi.fn(async ({ clashes }) => {
      expect(clashes).toEqual([
        { field: "title", label: "Title", mine: "Mine", theirs: "Theirs" },
        { field: "description", label: "Description", mine: "My words", theirs: "Their words" },
      ]);
      return { keepMine: ["title"] };
    });
    const undo = setConflictResolver(resolver);
    await versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "Mine", description: "My words", severity: "major", rowVersion: "10" } }, me);
    undo();
    expect(send.mock.calls.at(-1)[1].body).toEqual({ title: "Mine", severity: "major", rowVersion: "15" });
    expect(merged[0].kept).toBe("mine");
  });

  it("does not ask about a field that now holds the same value, or one changed only by this person", async () => {
    const resolver = vi.fn();
    const undo = setConflictResolver(resolver);
    const send = vi.fn(async (path, { method, body }) => {
      if (method === "GET") return { id: ID, title: "Same", owner: { id: "u1", name: "Bo" } };
      if (body.rowVersion === "10") throw conflict({ version: "15", fields: ["title", "ownerId"], people: [colin] });
      return { id: ID, rowVersion: "16" };
    });
    await versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "Same", ownerId: "u1", rowVersion: "10" } }, me);
    expect(resolver).not.toHaveBeenCalled();

    const own = vi.fn(async (path, { method, body }) => {
      if (method === "GET") return { id: ID, title: "Older" };
      if (body.rowVersion === "30") throw conflict({ version: "35", fields: ["title"], people: [{ id: "ada", name: "Ada" }] });
      return { id: ID, rowVersion: "36" };
    });
    await versionedSave(own, `/ncrs/${ID}`, { method: "PATCH", body: { title: "Newer", rowVersion: "30" } }, me);
    expect(resolver).not.toHaveBeenCalled();
    expect(merged).toHaveLength(1); // nothing announced for the person's own change
    undo();
  });

  it("answers with the record as it is when the person takes everything of theirs", async () => {
    const undo = setConflictResolver(async () => ({ keepMine: [] }));
    const send = vi.fn(async (path, { method }) => {
      if (method === "GET") return { id: ID, title: "Theirs", rowVersion: "15" };
      throw conflict({ version: "15", fields: ["title"], people: [colin] });
    });
    const answer = await versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "Mine", rowVersion: "10" } }, me);
    undo();
    expect(answer).toEqual({ id: ID, title: "Theirs", rowVersion: "15" });
    expect(send).toHaveBeenCalledTimes(2); // the refused save and the read, nothing written
    expect(merged[0].kept).toBe("theirs");
  });

  it("leaves the typing unsaved when the person cancels, and throws when no one can ask", async () => {
    const send = vi.fn(async (path, { method }) => {
      if (method === "GET") return { id: ID, title: "Theirs" };
      throw conflict({ version: "15", fields: ["title"], people: [colin] });
    });
    await expect(versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "Mine", rowVersion: "10" } }, me)).rejects.toMatchObject({ code: "edit_conflict" });
    const undo = setConflictResolver(async () => null);
    await expect(versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "Mine", rowVersion: "10" } }, me)).rejects.toMatchObject({
      cancelled: true,
      message: "Not saved: Colin Brown changed this since you opened it",
    });
    undo();
  });

  it("passes other errors and saves without a version straight through", async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("nope"), { status: 409, code: "ncr_rule" }));
    await expect(versionedSave(send, `/ncrs/${ID}`, { method: "PATCH", body: { title: "x", rowVersion: "1" } }, me)).rejects.toMatchObject({ code: "ncr_rule" });
    const plain = vi.fn(async () => ({}));
    await versionedSave(plain, `/ncrs/${ID}`, { method: "PATCH", body: { title: "x" } }, me);
    expect(plain.mock.calls[0][1].body).toEqual({ title: "x" });
  });
});

describe("what a form sends", () => {
  const opened = { id: ID, rowVersion: "10", title: "Bore", description: null, owner: { id: "u1", name: "Bo" }, dueDate: "2026-12-01" };
  it("withVersion adds the version the screen showed, nothing when it has none", async () => {
    const { withVersion } = await import("./editConflicts");
    expect(withVersion(opened, { title: "x" })).toEqual({ title: "x", rowVersion: "10" });
    expect(withVersion({ id: ID }, { title: "x" })).toEqual({ title: "x" });
    expect(withVersion(null, { title: "x" })).toEqual({ title: "x" });
  });
  it("changesSince sends only what differs from the record as opened", async () => {
    const { changesSince } = await import("./editConflicts");
    expect(changesSince(opened, { title: "Bore", description: "", ownerId: "u2", dueDate: "2026-12-01", extra: 1 })).toEqual({ ownerId: "u2", extra: 1, rowVersion: "10" });
    expect(changesSince(opened, { title: "Bore" })).toEqual({ title: "Bore", rowVersion: "10" });
    expect(changesSince({ id: ID }, { title: "Bore" })).toEqual({ title: "Bore" });
  });
});
