import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import DropdownMenu from "./DropdownMenu";

const setup = (props = {}) =>
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <DropdownMenu
                label="Row actions"
                trigger={(p) => (
                  <button {...p} data-testid="trigger">
                    Open menu
                  </button>
                )}
                {...props}
              />
              <button>Elsewhere</button>
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

describe("DropdownMenu", () => {
  it("is closed until the trigger is clicked, and announces itself as a menu button", async () => {
    setup({ items: [{ label: "Open", onSelect: vi.fn() }] });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("trigger")).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByRole("menu", { name: "Row actions" })).toBeInTheDocument();
    expect(screen.getByTestId("trigger")).toHaveAttribute("aria-expanded", "true");
  });

  it("renders in a floating portal on the body marked as a popover", async () => {
    const { container } = setup({ items: [{ label: "Open" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-popover");
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it("runs the chosen action once and closes", async () => {
    const onSelect = vi.fn();
    setup({ items: [{ label: "Open", onSelect }, { label: "Delete", tone: "danger", onSelect: vi.fn() }] });
    await userEvent.click(screen.getByTestId("trigger"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("skips falsy entries, so a permission check can be written inline", async () => {
    setup({ items: [{ label: "Open" }, false, null, undefined, { label: "Delete" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open", "Delete"]);
  });

  it("shows a header that is not an item, and separators", async () => {
    setup({ header: <p>Jane Smith</p>, items: [{ label: "Open" }, { separator: true }, { label: "Logout" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("does not run a disabled item and stays open", async () => {
    const onSelect = vi.fn();
    setup({ items: [{ label: "Help", disabled: true, hint: "Not set up yet", onSelect }] });
    await userEvent.click(screen.getByTestId("trigger"));
    const item = screen.getByRole("menuitem", { name: /Help/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Not set up yet")).toBeInTheDocument();
    await userEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("makes an item with `checked` a switch that stays open", async () => {
    const onSelect = vi.fn();
    setup({ items: [{ label: "Dark mode", checked: true, onSelect }] });
    await userEvent.click(screen.getByTestId("trigger"));
    const item = screen.getByRole("menuitemcheckbox", { name: "Dark mode" });
    expect(item).toHaveAttribute("aria-checked", "true");
    await userEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("links to a page in the app with `to`, and closes", async () => {
    setup({ items: [{ label: "Settings", to: "/Settings" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "/Settings");
    await userEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens an outside address in a new tab with `href`", async () => {
    setup({ items: [{ label: "Help", href: "https://help.example.com" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    const link = screen.getByRole("menuitem", { name: "Help" });
    expect(link).toHaveAttribute("href", "https://help.example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("closes on an outside click, but not on a click inside it", async () => {
    setup({ header: <p>Header</p>, items: [{ label: "Open" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    await userEvent.click(screen.getByText("Header"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("toggles shut when the trigger is clicked again", async () => {
    setup({ items: [{ label: "Open" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    await userEvent.click(screen.getByTestId("trigger"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    setup({ items: [{ label: "Open" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("trigger")).toHaveFocus();
  });

  it("focuses the first item when it opens and moves with the arrow keys, wrapping round", async () => {
    setup({ items: [{ label: "One" }, { label: "Two", disabled: true }, { label: "Three" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Three" })).toHaveFocus(); // the disabled one is skipped
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Three" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Three" })).toHaveFocus();
  });

  it("opens from the keyboard with the down arrow on the trigger", async () => {
    setup({ items: [{ label: "Open" }] });
    screen.getByTestId("trigger").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes on Tab", async () => {
    setup({ items: [{ label: "Open" }] });
    await userEvent.click(screen.getByTestId("trigger"));
    await userEvent.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
