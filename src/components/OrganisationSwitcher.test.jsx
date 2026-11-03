import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let state;
vi.mock("../contexts/OrganisationProvider", () => ({ useOrganisation: () => state }));

import OrganisationSwitcher from "./OrganisationSwitcher";

describe("OrganisationSwitcher", () => {
  it("is hidden for members of a single organisation", () => {
    state = { organisations: [{ id: "a", name: "Alpha" }], organisationId: "a", selectOrganisation: vi.fn() };
    const { container } = render(<OrganisationSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });

  it("switches organisation", async () => {
    const selectOrganisation = vi.fn();
    state = {
      organisations: [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
      organisationId: "a",
      selectOrganisation,
    };
    render(<OrganisationSwitcher />);
    expect(screen.getByLabelText("Organisation")).toHaveValue("a");
    await userEvent.selectOptions(screen.getByLabelText("Organisation"), "b");
    expect(selectOrganisation).toHaveBeenCalledWith("b");
  });
});
