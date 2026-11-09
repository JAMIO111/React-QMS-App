import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Callout from "./Callout";
import RHFComboBox from "./RHFComboBox";
import RHFDatePickerPopout from "./RHFDatePickerPopout";

describe("Callout", () => {
  it.each([
    ["success", "text-success-color"],
    ["info", "text-info-color"],
    ["warning", "text-warning-color"],
    ["error", "text-error-color"],
  ])("a %s notice has an icon in its colour, a title and its words", (tone, iconClass) => {
    const { container } = render(<Callout tone={tone} title="A title">The words</Callout>);
    expect(screen.getByText("A title")).toBeInTheDocument();
    expect(screen.getByText("The words")).toBeInTheDocument();
    const icon = container.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon.getAttribute("class")).toContain(iconClass);
  });

  it("has no role unless one is given, and shows an action beside the words", () => {
    const { rerender } = render(<Callout tone="info">Plain</Callout>);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<Callout tone="error" role="alert" action={<button type="button">Fix it</button>}>Broken</Callout>);
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Fix it" })).toBeInTheDocument();
  });
});

describe("custom inputs open from the box, not the label", () => {
  it("a combo box opens when its box is clicked and not when its label is", async () => {
    render(<RHFComboBox label="Machine" value={null} onChange={vi.fn()} options={[{ id: "m1", name: "Lathe 1" }]} />);
    await userEvent.click(screen.getByText("Machine"));
    expect(screen.queryByRole("option", { name: "Lathe 1" })).toBeNull();
    await userEvent.click(screen.getByRole("combobox", { name: "Machine" }));
    expect(screen.getByRole("option", { name: "Lathe 1" })).toBeInTheDocument();
  });

  it("a date field opens when its box is clicked and not when its label is", async () => {
    render(<RHFDatePickerPopout label="Due date" value="" onChange={vi.fn()} />);
    await userEvent.click(screen.getByText("Due date"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Due date/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
