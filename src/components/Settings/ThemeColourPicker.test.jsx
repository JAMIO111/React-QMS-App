import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const mutate = vi.fn();
vi.mock("../../hooks/useQmsApi", () => ({
  useUpdateOrganisation: () => ({ mutate, isPending: false, error: null }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import ThemeColourPicker, { SAVE_DELAY_MS } from "./ThemeColourPicker";
import { applyStoredThemeColour, applyThemeColour, getPendingThemeColour } from "../../lib/theme-colours";

const pick = (name) => fireEvent.click(screen.getByRole("radio", { name }));
const wait = () => act(() => vi.advanceTimersByTime(SAVE_DELAY_MS));
const colour = () => document.documentElement.dataset.themeColour;

describe("ThemeColourPicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mutate.mockReset();
    localStorage.clear();
    delete document.documentElement.dataset.themeColour;
  });
  afterEach(() => vi.useRealTimers());

  it("offers the seven colours with the current one selected", () => {
    render(<ThemeColourPicker value="purple" canManage />);
    expect(screen.getAllByRole("radio").map((o) => o.value)).toEqual(["blue", "red", "yellow", "green", "orange", "purple", "pink"]);
    expect(screen.getByRole("radio", { name: "Purple" })).toBeChecked();
  });

  it("updates instantly on every click and saves only the last choice", () => {
    render(<ThemeColourPicker value="purple" canManage />);
    pick("Green");
    expect(screen.getByRole("radio", { name: "Green" })).toBeChecked();
    expect(colour()).toBe("green");
    pick("Red");
    pick("Blue");
    expect(screen.getByRole("radio", { name: "Blue" })).toBeChecked();
    expect(colour()).toBe("blue");
    expect(mutate).not.toHaveBeenCalled();

    wait();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      { body: { settings: { themeColour: "blue" } }, reason: "Theme colour changed" },
      expect.any(Object)
    );
  });

  it("keeps the latest choice while an earlier save is still answering", () => {
    let first;
    mutate.mockImplementationOnce((_vars, callbacks) => (first = callbacks));
    const { rerender } = render(<ThemeColourPicker value="purple" canManage />);
    pick("Green");
    wait(); // save "green" is in flight
    pick("Pink"); // user moves on before it answers

    // The green save succeeds and the organisation data now says green.
    act(() => {
      first.onSuccess();
      first.onSettled();
    });
    rerender(<ThemeColourPicker value="green" canManage />);
    expect(screen.getByRole("radio", { name: "Pink" })).toBeChecked();
    expect(colour()).toBe("pink");
    expect(getPendingThemeColour()).toBe("pink");

    wait();
    expect(mutate).toHaveBeenLastCalledWith(
      { body: { settings: { themeColour: "pink" } }, reason: "Theme colour changed" },
      expect.any(Object)
    );
  });

  it("puts the saved colour back if the last save fails", () => {
    mutate.mockImplementation((_vars, { onError, onSettled }) => {
      onError(new Error("nope"));
      onSettled();
    });
    render(<ThemeColourPicker value="blue" canManage />);
    pick("Red");
    expect(colour()).toBe("red");
    wait();
    expect(colour()).toBe("blue");
    expect(screen.getByRole("radio", { name: "Blue" })).toBeChecked();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(getPendingThemeColour()).toBeNull();
  });

  it("saves a pending change when the page is left early", () => {
    const { unmount } = render(<ThemeColourPicker value="purple" canManage />);
    pick("Orange");
    unmount();
    expect(mutate).toHaveBeenCalledWith(
      { body: { settings: { themeColour: "orange" } }, reason: "Theme colour changed" },
      expect.any(Object)
    );
    expect(getPendingThemeColour()).toBeNull();
  });

  it("is read-only without organisation.manage", () => {
    render(<ThemeColourPicker value="purple" canManage={false} />);
    expect(screen.getByRole("radio", { name: "Pink" })).toBeDisabled();
    pick("Pink");
    wait();
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Purple" })).toBeChecked();
  });
});

describe("theme colour storage", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the last colour for the next page load", () => {
    applyThemeColour("orange");
    delete document.documentElement.dataset.themeColour;
    expect(applyStoredThemeColour()).toBe("orange");
    expect(colour()).toBe("orange");
  });

  it("falls back to purple for unknown values", () => {
    expect(applyThemeColour("teal")).toBe("purple");
    expect(applyStoredThemeColour()).toBe("purple");
  });
});
