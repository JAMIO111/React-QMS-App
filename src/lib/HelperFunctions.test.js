import { afterEach, describe, expect, it, vi } from "vitest";
import { getGreeting } from "./HelperFunctions";

describe("getGreeting", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [9, "Good morning"],
    [14, "Good afternoon"],
    [20, "Good evening"],
  ])("at %i:00 returns %s", (hour, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, hour));
    expect(getGreeting()).toBe(expected);
  });
});
