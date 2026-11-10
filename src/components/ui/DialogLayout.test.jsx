import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Dialog from "./Dialog";
import Switch from "./Switch";

// jsdom cannot lay pages out, so these pin the two rules that keep a dialog still when a switch inside it is pressed
// (checked in Chromium: without them, clicking a switch low in a long dialog scrolled the dialog frame and pushed header, form and footer up).
describe("a switch inside a dialog", () => {
  it("keeps its hidden checkbox inside its own label, so focusing it never scrolls an ancestor", () => {
    render(<Switch checked={false} onChange={() => {}}>Incremental imports</Switch>);
    expect(screen.getByRole("switch").closest("label")).toHaveClass("relative");
  });

  it("clips the dialog frame instead of hiding its overflow, so nothing can scroll the frame itself", () => {
    render(<Dialog title="Add a connection" onClose={() => {}}><p>Body</p></Dialog>);
    const frame = screen.getByRole("dialog");
    expect(frame).toHaveClass("overflow-clip");
    expect(frame).not.toHaveClass("overflow-hidden");
  });
});
