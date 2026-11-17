import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { optimisticHandlers, optimisticTarget, guessCache, rollbackGuess, updateById, mergeResponse, pendingId, isPending } from "./optimistic";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const root = ["api", "org", "o1", "master"];

const setup = () => {
  const qc = new QueryClient();
  qc.setQueryData([...root, "list"], { pages: [{ data: [{ id: ID, active: true, name: "A" }, { id: OTHER, active: true, name: "B" }] }] });
  qc.setQueryData([...root, "detail"], { id: "x", customers: [{ id: ID, isPrimary: false }] });
  return qc;
};

describe("optimisticTarget", () => {
  it("accepts a flat PATCH or a DELETE of one uuid", () => {
    expect(optimisticTarget({ path: `/things/${ID}`, method: "PATCH", body: { active: false } })).toEqual({ id: ID, remove: false });
    expect(optimisticTarget({ path: `/things/${ID}`, method: "DELETE" })).toEqual({ id: ID, remove: true });
  });
  it("ignores actions, nested bodies and non-uuid paths", () => {
    expect(optimisticTarget({ path: `/things/${ID}/restore`, method: "POST" })).toBeNull();
    expect(optimisticTarget({ path: `/things/${ID}`, method: "PATCH", body: { a: { b: 1 } } })).toBeNull();
    expect(optimisticTarget({ path: "/things/current", method: "PATCH", body: { a: 1 } })).toBeNull();
  });
});

describe("optimisticHandlers", () => {
  it("patches only keys the cached object has, everywhere it appears, and rolls back", async () => {
    const qc = setup();
    const h = optimisticHandlers(qc, root);
    const request = { path: `/things/${ID}`, method: "PATCH", body: { active: false, unknown: 1 } };
    const ctx = await h.onMutate(request);
    expect(ctx.optimistic).toBe(true);
    const list = qc.getQueryData([...root, "list"]).pages[0].data;
    expect(list[0]).toEqual({ id: ID, active: false, name: "A" });
    expect(list[1].active).toBe(true);
    h.onError(new Error("x"), request, ctx);
    expect(qc.getQueryData([...root, "list"]).pages[0].data[0].active).toBe(true);
  });

  it("removes a deleted item from lists and nested arrays", async () => {
    const qc = setup();
    const h = optimisticHandlers(qc, root);
    const ctx = await h.onMutate({ path: `/part-customers/${ID}`, method: "DELETE" });
    expect(ctx.optimistic).toBe(true);
    expect(qc.getQueryData([...root, "list"]).pages[0].data.map((r) => r.id)).toEqual([OTHER]);
    expect(qc.getQueryData([...root, "detail"]).customers).toEqual([]);
  });

  it("does nothing for other requests", async () => {
    const qc = setup();
    const ctx = await optimisticHandlers(qc, root).onMutate({ path: "/things", method: "POST", body: { a: 1 } });
    expect(ctx).toEqual({ optimistic: false });
  });
});


describe("guesses and answers written into the cache", () => {
  const seed = () => {
    const qc = new QueryClient();
    qc.setQueryData(["api", "org", "o1", "members"], { data: [{ id: "m1", name: "Ann", departments: [{ id: "d1", name: "GI" }] }] });
    qc.setQueryData(["api", "org", "o1", "member", "m1"], { id: "m1", name: "Ann", email: "a@x", departments: [] });
    return qc;
  };

  it("guessCache changes every matching query and rollbackGuess puts it back", async () => {
    const qc = seed();
    const ctx = await guessCache(qc, ["api", "org", "o1"], (data) => updateById(data, "m1", (m) => ({ ...m, name: "Anna" })));
    expect(ctx.optimistic).toBe(true);
    expect(qc.getQueryData(["api", "org", "o1", "members"]).data[0].name).toBe("Anna");
    expect(qc.getQueryData(["api", "org", "o1", "member", "m1"]).name).toBe("Anna");
    rollbackGuess(qc, ctx);
    expect(qc.getQueryData(["api", "org", "o1", "members"]).data[0].name).toBe("Ann");
  });

  it("updateById removes nested rows and leaves untouched branches as they were", () => {
    const data = { a: { id: "x", list: [{ id: "d1" }, { id: "d2" }] }, b: { id: "y" } };
    const next = updateById(data, "d1", null, { remove: true });
    expect(next.a.list).toEqual([{ id: "d2" }]);
    expect(next.b).toBe(data.b);
  });

  it("mergeResponse writes an answer into every copy, only the keys each copy has, only matching kinds", () => {
    const qc = seed();
    mergeResponse(qc, { id: "m1", name: "Ann B", email: "b@x", departments: "not a list", extra: 1 });
    expect(qc.getQueryData(["api", "org", "o1", "members"]).data[0]).toEqual({ id: "m1", name: "Ann B", departments: [{ id: "d1", name: "GI" }] });
    expect(qc.getQueryData(["api", "org", "o1", "member", "m1"]).email).toBe("b@x");
    mergeResponse(qc, { ok: true });
    mergeResponse(qc, null);
  });

  it("pending ids are recognised", () => {
    expect(isPending(pendingId())).toBe(true);
    expect(isPending("3f1c")).toBe(false);
  });
});
