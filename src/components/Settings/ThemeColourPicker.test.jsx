import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mutate = vi.fn();
vi.mock("../../hooks/useQmsApi", () => ({
  useUpdateOrganisation: () => ({ mutate, isPending: false, error: null }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import ThemeColourPicker from "./ThemeColourPicker";
import { applyStoredThemeColour, applyThemeColour } from "../../lib/theme-colours";

describe("ThemeColourPicker", () => {
  beforeEach(() => {
    mutate.mockReset();
    localStorage.clear();
    delete document.documentElement.dataset.themeColour;
  });

  it("offers the seven colours with the current one selected", () => {
    render(<ThemeColourPicker value="purple" canManage />);
    const options = screen.getAllByRole("radio");
    expect(options.map((o) => o.value)).toEqual(["blue", "red", "yellow", "green", "orange", "purple", "pink"]);
    expect(screen.getByRole("radio", { name: "Purple" })).toBeChecked();
  });

  it("applies a new colour instantly and saves it for the organisation", async () => {
    render(<ThemeColourPicker value="purple" canManage />);
    await userEvent.click(screen.getByRole("radio", { name: "Green" }));
    expect(document.documentElement.dataset.themeColour).toBe("green");
    expect(mutate).toHaveBeenCalledWith(
      { body: { settings: { themeColour: "green" } }, reason: "Theme colour changed" },
      expect.any(Object)
    );
  });

  it("puts the previous colour back if saving fails", async () => {
    mutate.mockImplementation((_vars, { onError }) => onError(new Error("nope")));
    render(<ThemeColourPicker value="blue" canManage />);
    await userEvent.click(screen.getByRole("radio", { name: "Red" }));
    expect(document.documentElement.dataset.themeColour).toBe("blue");
  });

  it("is read-only without organisation.manage", async () => {
    render(<ThemeColourPicker value="purple" canManage={false} />);
    expect(screen.getByRole("radio", { name: "Pink" })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: "Pink" }));
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("theme colour storage", () => {
  beforeEach(() => localStorage.clear());

  it("remembers the last colour for the next page load", () => {
    applyThemeColour("orange");
    delete document.documentElement.dataset.themeColour;
    expect(applyStoredThemeColour()).toBe("orange");
    expect(document.documentElement.dataset.themeColour).toBe("orange");
  });

  it("falls back to purple for unknown values", () => {
    expect(applyThemeColour("teal")).toBe("purple");
    expect(applyStoredThemeColour()).toBe("purple");
  });
});
