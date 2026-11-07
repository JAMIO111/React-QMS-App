import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dialog from "./Dialog";
import RHFComboBox from "./RHFComboBox";

const options = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];

describe("combo box option lists", () => {
  it("float over the page (a fixed portal), not inside the dialog that would clip them, and still select and close", async () => {
    const user = userEvent.setup();
    let picked = null;
    render(
      <Dialog title="Pick" onClose={() => {}}>
        <RHFComboBox label="Thing" options={options} value={picked} onChange={(v) => (picked = v)} />
      </Dialog>
    );
    await user.click(screen.getByRole("combobox", { name: "Thing" }));
    const list = await screen.findByRole("listbox");
    expect(within(screen.getByRole("dialog")).queryByRole("listbox")).toBeNull();
    expect(list.parentElement).toBe(document.body);
    expect(list).toHaveAttribute("data-popover");
    expect(list.className).toMatch(/\bfixed\b/);
    expect(list.className).not.toMatch(/\babsolute\b/);
    await user.click(screen.getByRole("option", { name: "Beta" }));
    expect(picked).toBe("b");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stays open when the list itself is clicked (scrolling), and closes on a click elsewhere", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <p>elsewhere</p>
        <RHFComboBox label="Thing" options={options} value={null} onChange={() => {}} />
      </div>
    );
    await user.click(screen.getByRole("combobox", { name: "Thing" }));
    await user.click(await screen.findByRole("listbox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByText("elsewhere"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
