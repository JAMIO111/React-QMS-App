import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import RowActionsMenu from "./RowActionsMenu";

const renderIn = (ui, { onRowClick = vi.fn() } = {}) =>
  render(
    <MemoryRouter>
      <div onClick={onRowClick} data-testid="row">
        {ui}
      </div>
    </MemoryRouter>
  );

describe("RowActionsMenu", () => {
  it("opens a menu named for the row from the Actions button", async () => {
    renderIn(<RowActionsMenu label="Actions for NCM-1" items={[{ label: "Open" }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menu", { name: "Actions for NCM-1" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeInTheDocument();
  });

  it("runs the chosen action", async () => {
    const onSelect = vi.fn();
    renderIn(<RowActionsMenu items={[{ label: "Delete", tone: "danger", onSelect }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not reach the row when the button is clicked", async () => {
    const onRowClick = vi.fn();
    renderIn(<RowActionsMenu items={[{ label: "Open" }]} />, { onRowClick });
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("shows no button when there is nothing to offer", () => {
    renderIn(<RowActionsMenu items={[false, null, undefined]} />);
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    renderIn(<RowActionsMenu />);
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
  });

  it("takes a custom trigger (a card's Actions button)", async () => {
    renderIn(<RowActionsMenu items={[{ label: "Open" }]} trigger={(props) => <button {...props}>More</button>} />);
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
