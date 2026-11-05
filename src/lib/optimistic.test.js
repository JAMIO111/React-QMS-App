import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { optimisticHandlers, optimisticTarget } from "./optimistic";

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
