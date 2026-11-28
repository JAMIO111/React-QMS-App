import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Link } from "react-router-dom";

// The menu itself has its own tests and needs the whole API; here only the drawer around it matters.
vi.mock("./Navbar", () => ({
  default: ({ variant, onNavigate }) => (
    <nav aria-label="Main menu" data-variant={variant}>
      <button type="button" data-autofocus onClick={onNavigate}>Close the menu</button>
      <Link to="/Parts" onClick={onNavigate}>Parts</Link>
    </nav>
  ),
}));

import MobileNav from "./MobileNav";

const Harness = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open the menu</button>
      <MobileNav open={open} onClose={() => setOpen(false)} />
    </>
  );
};
const setup = () => render(<MemoryRouter><Harness /></MemoryRouter>);

describe("the phone menu drawer", () => {
  it("is not on the page until it is opened, then shows the full-width menu in a dialog", async () => {
    setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main menu" })).toHaveAttribute("data-variant", "drawer");
  });

  it("puts focus in the menu and gives it back to the button that opened it", async () => {
    setup();
    const opener = screen.getByRole("button", { name: "Open the menu" });
    await userEvent.click(opener);
    expect(screen.getByRole("button", { name: "Close the menu" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("closes on Escape, on a tap outside it and when a page is chosen", async () => {
    setup();
    const open = () => userEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    await open();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await open();
    // The dimmed area behind the panel is the first thing in the dialog.
    await userEvent.click(screen.getByRole("dialog").firstChild);
    expect(screen.queryByRole("dialog")).toBeNull();

    await open();
    await userEvent.click(screen.getByRole("link", { name: "Parts" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside the menu", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    const close = screen.getByRole("button", { name: "Close the menu" });
    const parts = screen.getByRole("link", { name: "Parts" });
    parts.focus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(parts).toHaveFocus();
  });
});
