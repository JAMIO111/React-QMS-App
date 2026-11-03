import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let assurance;
let confirmAnswer;
const mutate = vi.fn();
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ assurance }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => async () => confirmAnswer }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useQmsApi", () => ({ useUpdateOrganisation: () => ({ mutate, isPending: false }) }));

import RequireMfaSetting from "./RequireMfaSetting";

const renderIt = (props) => render(<MemoryRouter><RequireMfaSetting {...props} /></MemoryRouter>);

describe("RequireMfaSetting", () => {
  beforeEach(() => {
    mutate.mockReset();
    confirmAnswer = true;
  });

  it("cannot be switched on before the owner has two-factor themselves", () => {
    assurance = { currentLevel: "aal1", nextLevel: "aal1" };
    renderIt({ value: false, canManage: true });
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("link", { name: "Settings → Account" })).toHaveAttribute("href", "/Settings/Account");
  });

  it("is switched on after confirmation by an owner who passed two-factor", async () => {
    assurance = { currentLevel: "aal2", nextLevel: "aal2" };
    renderIt({ value: false, canManage: true });
    await userEvent.click(screen.getByRole("switch"));
    expect(mutate).toHaveBeenCalledWith(
      { body: { settings: { requireMfa: true } }, reason: "Two-factor authentication required" },
      expect.any(Object)
    );
  });

  it("does nothing when the confirmation is cancelled", async () => {
    assurance = { currentLevel: "aal2", nextLevel: "aal2" };
    confirmAnswer = false;
    renderIt({ value: false, canManage: true });
    await userEvent.click(screen.getByRole("switch"));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("can be switched off, and is read-only for non-managers", async () => {
    assurance = { currentLevel: "aal2", nextLevel: "aal2" };
    const { unmount } = renderIt({ value: true, canManage: true });
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("switch"));
    expect(mutate.mock.calls[0][0].body.settings.requireMfa).toBe(false);
    unmount();
    renderIt({ value: true, canManage: false });
    expect(screen.getByRole("switch")).toBeDisabled();
  });
});
