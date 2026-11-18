import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let profile;
const signOutNow = vi.fn();
let signingOut = false;
vi.mock("../contexts/UserProvider", () => ({ useUser: () => ({ profile }) }));
vi.mock("../hooks/useSignedAvatarURL", () => ({ default: () => ({ signedUrl: null }) }));
vi.mock("../hooks/useSignOut", () => ({ default: () => [signOutNow, signingOut] }));
const help = vi.hoisted(() => ({ url: "https://fortress-qms.com/help" }));
vi.mock("../lib/help", () => ({
  get HELP_URL() {
    return help.url;
  },
}));

const renderMenu = async () => {
  const { default: ProfileMenu } = await import("./ProfileMenu");
  return render(
    <MemoryRouter>
      <ProfileMenu />
    </MemoryRouter>
  );
};

describe("ProfileMenu", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    signOutNow.mockReset();
    signingOut = false;
    help.url = "https://fortress-qms.com/help";
    profile = { first_name: "Ada", surname: "Lovelace", email: "ada@example.com" };
  });

  it("opens from the profile picture and shows who is signed in", async () => {
    await renderMenu();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = screen.getByRole("menu", { name: "Account menu" });
    expect(within(menu).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(menu).getByText("ada@example.com")).toBeInTheDocument();
  });

  it("offers Settings, Help, Dark mode and Logout", async () => {
    await renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "/Settings");
    expect(screen.getByRole("menuitemcheckbox", { name: "Dark mode" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Logout" })).toBeInTheDocument();
  });

  it("opens the contents page of the website guides in a new tab", async () => {
    await renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const link = screen.getByRole("menuitem", { name: "Help" });
    expect(link).toHaveAttribute("href", "https://fortress-qms.com/help");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("follows VITE_HELP_URL when it is set", async () => {
    help.url = "https://staging.example.com/help";
    await renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menuitem", { name: "Help" })).toHaveAttribute("href", "https://staging.example.com/help");
  });

  it("switches dark mode on and off, remembers it, and keeps the menu open", async () => {
    await renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const toggle = screen.getByRole("menuitemcheckbox", { name: "Dark mode" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(screen.getByRole("menuitemcheckbox", { name: "Dark mode" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Dark mode" }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("signs out through the shared sign-out", async () => {
    await renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Logout" }));
    expect(signOutNow).toHaveBeenCalledTimes(1);
  });

  it("falls back to the email when there is no name, without repeating it", async () => {
    profile = { email: "ada@example.com" };
    await renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getAllByText("ada@example.com")).toHaveLength(1);
  });
});
