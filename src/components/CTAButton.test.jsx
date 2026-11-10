/* global process */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import CTAButton from "./CTAButton";

describe("CTAButton", () => {
  it("shows a spinner, says it is busy and ignores clicks while loading, keeping its name", async () => {
    const click = vi.fn();
    const { rerender } = render(<CTAButton onClick={click}>Save</CTAButton>);
    expect(screen.queryByTestId("button-spinner")).toBeNull();
    rerender(<CTAButton onClick={click} loading>Save</CTAButton>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(screen.getByTestId("button-spinner")).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(click).not.toHaveBeenCalled();
    rerender(<CTAButton onClick={click} loading loadingText="Saving…">Save</CTAButton>);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument();
  });

  it("is a plain button that does not submit a form unless asked", () => {
    render(<CTAButton text="Go" />);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "button");
  });

  it("submits when buttonType is submit", () => {
    render(<CTAButton buttonType="submit">Save</CTAButton>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
  });

  it("scales down when pressed and has the pointer cursor", () => {
    render(<CTAButton type="main">Save</CTAButton>);
    expect(screen.getByRole("button")).toHaveClass("active:scale-97", "transition-transform", "cursor-pointer");
  });

  it("does not scale, and is dimmed and unclickable, when disabled", async () => {
    const onClick = vi.fn();
    render(<CTAButton disabled onClick={onClick}>Save</CTAButton>);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).not.toHaveClass("active:scale-97");
    expect(button).toHaveClass("opacity-50", "cursor-not-allowed");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("takes the click from onClick or callbackFn", async () => {
    const a = vi.fn();
    const b = vi.fn();
    render(
      <>
        <CTAButton onClick={a}>A</CTAButton>
        <CTAButton callbackFn={b}>B</CTAButton>
      </>
    );
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    await userEvent.click(screen.getByRole("button", { name: "B" }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("styles each type, with primary and danger as names for main and cancel", () => {
    render(
      <>
        <CTAButton type="main">m</CTAButton>
        <CTAButton type="primary">p</CTAButton>
        <CTAButton type="secondary">s</CTAButton>
        <CTAButton type="neutral">n</CTAButton>
        <CTAButton type="danger">d</CTAButton>
        <CTAButton type="cancel">c</CTAButton>
        <CTAButton type="success">ok</CTAButton>
      </>
    );
    const cls = (n) => screen.getByRole("button", { name: n }).className;
    expect(cls("m")).toContain("bg-cta-btn-bg");
    expect(cls("p")).toContain("bg-cta-btn-bg");
    expect(cls("s")).toContain("bg-secondary-btn-bg");
    expect(cls("n")).toContain("bg-neutral-btn-bg");
    expect(cls("d")).toContain("bg-error-btn-bg");
    expect(cls("c")).toContain("bg-error-btn-bg");
    expect(cls("ok")).toContain("bg-success-btn-bg");
  });

  it("has sizes for toolbars, forms and the main action of a form", () => {
    render(
      <>
        <CTAButton>d</CTAButton>
        <CTAButton size="md">m</CTAButton>
        <CTAButton size="lg">l</CTAButton>
      </>
    );
    expect(screen.getByRole("button", { name: "d" })).toHaveClass("px-2", "py-1");
    expect(screen.getByRole("button", { name: "m" })).toHaveClass("px-3", "py-1.5", "text-sm");
    expect(screen.getByRole("button", { name: "l" })).toHaveClass("px-4", "py-2", "text-sm");
  });

  it("lets className win over the defaults and passes other attributes on", () => {
    render(
      <CTAButton size="md" className="w-full px-1" aria-label="Save it" data-x="1" form="f">
        Save
      </CTAButton>
    );
    const button = screen.getByRole("button", { name: "Save it" });
    expect(button).toHaveClass("w-full", "px-1");
    expect(button).not.toHaveClass("w-fit");
    expect(button).not.toHaveClass("px-3");
    expect(button).toHaveAttribute("data-x", "1");
    expect(button).toHaveAttribute("form", "f");
  });

  it("shows an icon before the text", () => {
    const Icon = (props) => <svg data-testid="icon" {...props} />;
    render(<CTAButton text="Add" icon={Icon} />);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("renders a router link that looks the same, with `to`", () => {
    render(
      <MemoryRouter>
        <CTAButton to="/Settings" type="secondary" size="md">
          Settings
        </CTAButton>
      </MemoryRouter>
    );
    const link = screen.getByRole("link", { name: "Settings" });
    expect(link).toHaveAttribute("href", "/Settings");
    expect(link.className).toContain("bg-secondary-btn-bg");
    expect(link).toHaveClass("active:scale-97");
  });
});

/** Every main, secondary, neutral, danger and success button is a CTAButton: nobody hand-styles one (or brings back the old class helper). */
describe("button styling", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\./.test(name)) files.push(full);
    }
  };
  walk(join(process.cwd(), "src")); // tests run from the repository root
  // Not buttons: a selected-date marker and the sliding highlight of SlidingToggle.
  const NOT_BUTTONS = ["CTAButton.jsx", "DateRangePicker.jsx", "SlidingToggle.jsx"];

  it("no file styles a button by hand with the button colours", () => {
    const offenders = files.filter(
      (f) => !NOT_BUTTONS.some((n) => f.endsWith(n)) && /(cta|neutral|error|success|secondary)-btn-(border|bg)/.test(readFileSync(f, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("every button that waits on a request shows the spinner (disabled on isPending also passes loading)", () => {
    const offenders = [];
    for (const f of files.filter((x) => x.endsWith(".jsx"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/<CTAButton\b/g)) {
        // The opening tag: up to the first ">" that is not part of "=>" and not inside braces.
        let depth = 0;
        let end = m.index;
        for (let i = m.index; i < src.length; i += 1) {
          const c = src[i];
          if (c === "{") depth += 1;
          else if (c === "}") depth -= 1;
          else if (c === ">" && depth === 0 && src[i - 1] !== "=") { end = i; break; }
        }
        const tag = src.slice(m.index, end);
        if (/disabled=\{[^}]*[^!]\b\w+\.isPending/.test(tag) && !/\bloading=/.test(tag)) offenders.push(`${f}: ${tag.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("buttonClass is gone", () => {
    const offenders = files.filter((f) => /\bbuttonClass\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("every tab bar is a SlidingToggle (nobody builds one by hand)", () => {
    const ALLOWED = ["SlidingToggle.jsx"];
    const offenders = files.filter((f) => !ALLOWED.some((n) => f.endsWith(n)) && /role="(tablist|tab)"/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
