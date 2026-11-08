import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SlidingToggle from "./SlidingToggle";

const OPTIONS = [
  { value: "all", label: "All" },
  { value: "customer", label: "Customer" },
  { value: "supplier", label: "Supplier", disabled: true },
];

describe("SlidingToggle", () => {
  it("is a group of pressed / not pressed buttons by default", () => {
    render(<SlidingToggle ariaLabel="Show" options={OPTIONS} value="all" onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Show" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Customer" })).toHaveAttribute("aria-pressed", "false");
  });

  it("can be tabs, with ids and aria-controls, or radios", () => {
    const { rerender } = render(
      <SlidingToggle ariaLabel="Panels" mode="tabs" options={[{ value: "a", label: "A", id: "tab-a", controls: "panel" }, { value: "b", label: "B" }]} value="a" onChange={() => {}} />
    );
    expect(screen.getByRole("tablist", { name: "Panels" })).toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: "A" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("id", "tab-a");
    expect(tab).toHaveAttribute("aria-controls", "panel");
    expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("aria-selected", "false");
    rerender(<SlidingToggle ariaLabel="Pick" mode="radio" options={["x", "y"]} value="y" onChange={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Pick" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "y" })).toHaveAttribute("aria-checked", "true");
  });

  it("accepts plain strings as options", async () => {
    const onChange = vi.fn();
    render(<SlidingToggle options={["All", "New", "Read"]} value="All" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    expect(onChange).toHaveBeenCalledWith("New");
  });

  it("calls onChange with the value only when the choice changes", async () => {
    const onChange = vi.fn();
    render(<SlidingToggle options={OPTIONS} value="all" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Customer" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("customer");
  });

  it("does not choose a disabled option", async () => {
    const onChange = vi.fn();
    render(<SlidingToggle options={OPTIONS} value="all" onChange={onChange} />);
    const disabled = screen.getByRole("button", { name: "Supplier" });
    expect(disabled).toBeDisabled();
    await userEvent.click(disabled);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("works with numbers as values", async () => {
    const onChange = vi.fn();
    render(<SlidingToggle options={[{ value: 7, label: "7 days" }, { value: 30, label: "30 days" }]} value={7} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "30 days" }));
    expect(onChange).toHaveBeenCalledWith(30);
  });

  it("names an icon-only option by its title", () => {
    const Icon = (props) => <svg {...props} />;
    render(<SlidingToggle options={[{ value: "list", icon: Icon, title: "List view" }, { value: "grid", icon: Icon, title: "Card view" }]} value="list" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute("title", "List view");
    expect(screen.getByRole("button", { name: "Card view" })).toBeInTheDocument();
  });

  it("shows a count beside the label", () => {
    render(<SlidingToggle options={[{ value: "new", label: "New", count: 4 }]} value="new" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /New/ })).toHaveTextContent("4");
  });

  it("highlights nothing when the value matches no option", () => {
    render(<SlidingToggle options={OPTIONS} value="nope" onChange={() => {}} />);
    for (const name of ["All", "Customer"]) expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
  });

  it("moves the choice with the arrow keys, skipping disabled options and wrapping", async () => {
    const onChange = vi.fn();
    render(<SlidingToggle mode="tabs" options={OPTIONS} value="all" onChange={onChange} />);
    screen.getByRole("tab", { name: "All" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("customer");
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("customer"); // wraps from All past the disabled Supplier
  });

  it("scales down when pressed", () => {
    render(<SlidingToggle options={OPTIONS} value="all" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Customer" })).toHaveClass("active:scale-97");
    expect(screen.getByRole("button", { name: "Supplier" })).not.toHaveClass("active:scale-97");
  });
});
