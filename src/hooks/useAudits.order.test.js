import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ORDER_WAIT_MS, inOrder, resetSaveOrder } from "./useAudits";

const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe("saves to the same address", () => {
  it("run one after another in the order they were made, even when the first is slow", async () => {
    const done = [];
    const first = inOrder("PUT /a", async () => { await later(30); done.push("first"); });
    const second = inOrder("PUT /a", async () => { done.push("second"); });
    await Promise.all([first, second]);
    expect(done).toEqual(["first", "second"]);
  });

  it("do not wait for each other when the address differs", async () => {
    const done = [];
    const slow = inOrder("PUT /a", async () => { await later(30); done.push("a"); });
    const quick = inOrder("PUT /b", async () => { done.push("b"); });
    await Promise.all([slow, quick]);
    expect(done).toEqual(["b", "a"]);
  });

  it("carry on after a save that failed, and still report that failure to its own caller", async () => {
    const failed = inOrder("PUT /a", async () => { throw new Error("refused"); });
    const after = inOrder("PUT /a", async () => "saved");
    await expect(failed).rejects.toThrow("refused");
    await expect(after).resolves.toBe("saved");
  });
});

describe("a save that never finishes", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetSaveOrder();
  });

  it("does not hold the next save for ever", async () => {
    vi.useFakeTimers();
    inOrder("PUT /a", () => new Promise(() => {}));
    const second = inOrder("PUT /a", async () => "went anyway");
    await vi.advanceTimersByTimeAsync(MAX_ORDER_WAIT_MS + 1);
    await expect(second).resolves.toBe("went anyway");
  });

  it("is forgotten by resetSaveOrder, so a test cannot hold up the next one", async () => {
    inOrder("PUT /b", () => new Promise(() => {}));
    resetSaveOrder();
    await expect(inOrder("PUT /b", async () => "free")).resolves.toBe("free");
  });
});
