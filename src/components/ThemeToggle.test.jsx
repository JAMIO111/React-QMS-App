import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ThemeToggle from "./ThemeToggle";

const mockSystem = (dark) => {
  const listeners = new Set();
  window.matchMedia = vi.fn(() => ({
    matches: dark,
    addEventListener: (_e, fn) => listeners.add(fn),
    removeEventListener: (_e, fn) => listeners.delete(fn),
  }));
  return listeners;
};

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });
  afterEach(() => {
    delete window.matchMedia;
  });

  it("shows the system mode on first visit instead of an empty toggle", () => {
    mockSystem(true);
    render(<ThemeToggle menuExpanded />);
    expect(screen.getByText("Dark Mode")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("title", "Toggle Light Mode");
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBeNull(); // still following the system
  });

  it("falls back to light when the system preference is unknown", () => {
    render(<ThemeToggle menuExpanded />);
    expect(screen.getByText("Light Mode")).toBeInTheDocument();
  });

  it("toggles and remembers the choice", async () => {
    mockSystem(false);
    render(<ThemeToggle menuExpanded />);
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Dark Mode")).toBeInTheDocument();
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Light Mode")).toBeInTheDocument();
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("always renders a knob when collapsed", () => {
    mockSystem(false);
    const { container } = render(<ThemeToggle menuExpanded={false} />);
    expect(container.querySelectorAll("button > div")).toHaveLength(1);
  });
});
