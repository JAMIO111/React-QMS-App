import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

let allowed = () => true;
let found = [];
const setTheme = vi.fn();
const signOut = vi.fn();
vi.mock("../../hooks/useQmsApi", () => ({ useCanSee: () => (permission) => allowed(permission) }));
vi.mock("../../hooks/useSubscription", () => ({ useModuleAccess: () => () => true }));
vi.mock("../../hooks/useProduction", () => ({ useProductionSettings: () => ({ useLotsAndSerials: true }) }));
vi.mock("../../hooks/useRecordSearch", () => ({
  SEARCH_MIN_LENGTH: 2,
  useRecordSearch: ({ q, kind }) => ({
    groups: q.trim().length >= 2 ? found.filter((g) => !kind || g.kind === kind) : [],
    searching: false,
    failed: false,
  }),
}));
vi.mock("../../hooks/useSignOut", () => ({ default: () => [signOut, false] }));
vi.mock("../../hooks/useTheme", () => ({ default: () => ["light", setTheme, "light"] }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import { CommandPaletteProvider } from "../../contexts/CommandPaletteProvider";
import { useCommandPalette } from "../../contexts/CommandPaletteProvider";
import { recentKey } from "../../lib/commandPalette";

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
const Opener = () => {
  const { openPalette } = useCommandPalette();
  return <button onClick={openPalette}>open the palette</button>;
};
const mount = (path = "/Dashboard") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <CommandPaletteProvider>
        <Opener />
        <Where />
      </CommandPaletteProvider>
    </MemoryRouter>,
  );
const open = () => fireEvent.keyDown(document, { key: "k", ctrlKey: true });
const box = () => screen.getByRole("combobox", { name: /search pages, actions and records/i });
const type = (text) => fireEvent.change(box(), { target: { value: text } });
const options = () => screen.getAllByRole("option");

beforeEach(() => {
  window.localStorage.clear();
  allowed = () => true;
  found = [];
  setTheme.mockReset();
  signOut.mockReset();
});

describe("opening", () => {
  it("opens with Ctrl+K and again with ⌘+K, closes with the same keys and with Escape, and starts empty", () => {
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    expect(screen.getByRole("dialog", { name: /command palette/i })).toBeInTheDocument();
    expect(box()).toHaveValue("");
    expect(box()).toHaveFocus();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from a button too, and a click on the dimmed page closes it", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /open the palette/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog.parentElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with nothing typed and nothing opened lately, lists pages and quick actions", () => {
    mount();
    open();
    expect(screen.getByRole("region", { name: "Pages" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Quick actions" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Recently opened" })).toBeNull();
  });

  it("with screens opened lately, leads with those", () => {
    window.localStorage.setItem(recentKey("u1", "org-1"), JSON.stringify([{ path: "/Parts/p1", label: "HOUS-100 · Pump housing" }]));
    mount();
    open();
    const recent = screen.getByRole("region", { name: "Recently opened" });
    expect(within(recent).getByText(/HOUS-100/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pages" })).toBeNull();
  });
});

describe("choosing", () => {
  it("finds pages by what is typed, marks the words, and Enter opens the first one", () => {
    mount();
    open();
    type("register");
    const pages = screen.getByRole("region", { name: "Pages" });
    expect(within(pages).getAllByText("Register").length).toBeGreaterThan(0);
    expect(pages.querySelector("mark")).toHaveTextContent(/register/i);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("where").textContent).toMatch(/Register$/);
  });

  it("moves with the arrow keys and wraps round", () => {
    mount();
    open();
    type("register");
    const count = options().length;
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(options()[count - 1]).toHaveAttribute("aria-selected", "true");
    expect(box()).toHaveAttribute("aria-activedescendant", options()[count - 1].id);
  });

  it("opens a record on its own screen and remembers it", () => {
    found = [{ kind: "ncr", total: 1, items: [{ id: "n1", title: "SNC-26-0012", subtitle: "Cracked housing", status: "awaiting_closure" }] }];
    mount();
    open();
    type("crack");
    const group = screen.getByRole("region", { name: "Non-conformances" });
    expect(within(group).getByText("Awaiting closure")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("option", { name: /SNC-26-0012/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Register/n1");
    expect(JSON.parse(window.localStorage.getItem(recentKey("u1", "org-1")))[0]).toMatchObject({ path: "/Non-Conformance/Register/n1", hint: "Non-conformance" });
    open();
    expect(within(screen.getByRole("region", { name: "Recently opened" })).getByText(/SNC-26-0012/)).toBeInTheDocument();
  });

  it("runs an action on the spot instead of opening a page", () => {
    mount();
    open();
    type("dark");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(screen.getByTestId("where")).toHaveTextContent("/Dashboard");
    open();
    type("sign out");
    fireEvent.click(screen.getByRole("option", { name: /sign out/i }));
    expect(signOut).toHaveBeenCalled();
  });

  it("offers only the pages and actions the person may use", () => {
    allowed = (p) => !p || p === "ncr.read";
    mount();
    open();
    type("calibration");
    expect(screen.getByText(/nothing found/i)).toBeInTheDocument();
    type("new non");
    expect(screen.getByText(/nothing found/i)).toBeInTheDocument();
    allowed = () => true;
    type("new non-");
    expect(screen.getByRole("option", { name: /new non.?\s?conformance/i })).toBeInTheDocument();
  });
});

describe("records and chips", () => {
  const groups = () => [
    { kind: "ncr", total: 9, items: [{ id: "n1", title: "SNC-26-0001", subtitle: "Cracked housing", status: null }] },
    { kind: "part", total: 1, items: [{ id: "p1", title: "HOUS-100", subtitle: "Pump housing", status: null }] },
  ];

  it("gives each kind that matched a chip with how many, and the group header the same", () => {
    found = groups();
    mount();
    open();
    expect(screen.queryByRole("region", { name: "Non-conformances" })).toBeNull();
    type("hous");
    expect(screen.getByRole("button", { name: /Non-conformances\s*9/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Parts\s*1/ })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Non-conformances" })).getByText("9")).toBeInTheDocument();
  });

  it("'Show all' on a group switches to that kind's chip and keeps the words", () => {
    found = groups();
    mount();
    open();
    type("hous");
    fireEvent.click(screen.getByRole("option", { name: /show all 9/i }));
    expect(screen.getByRole("button", { name: /Non-conformances\s*9/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "Parts" })).toBeNull();
    expect(box()).toHaveValue("hous");
  });

  it("says what is going on when nothing matches or too little is typed", () => {
    mount();
    open();
    type("#");
    expect(screen.getByRole("status")).toHaveTextContent(/keep typing/i);
    type("zzzz");
    expect(screen.getByRole("status")).toHaveTextContent(/nothing found for “zzzz”/i);
    act(() => {});
  });
});
