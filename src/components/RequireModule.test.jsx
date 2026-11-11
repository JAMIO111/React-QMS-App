import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let access = null;
let permissions = [];
const catalogueCalls = [];
vi.mock("../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../hooks/useSubscription", () => ({
  useSubscriptionAccess: () => ({ data: access, isLoading: false, error: null }),
  usePlanCatalogue: (opts) => (catalogueCalls.push(opts), { data: opts?.enabled ? { modules: [{ slug: "capa", name: "CAPA" }], plans: [{ name: "Pro", levels: { capa: "full" } }] } : undefined }),
}));

import RequireModule from "./RequireModule";

const at = () =>
  render(
    <MemoryRouter initialEntries={["/x"]}>
      <Routes>
        <Route element={<RequireModule module="capa" />}>
          <Route path="/x" element={<p>inside</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  catalogueCalls.length = 0;
  permissions = [];
});

describe("RequireModule", () => {
  it("never asks for the plan catalogue when the module is open", () => {
    access = { enforced: true, modules: { capa: "full" } };
    at();
    expect(screen.getByText("inside")).toBeInTheDocument();
    expect(catalogueCalls.every((o) => o.enabled === false)).toBe(true);
  });

  it("asks for it only for someone who may read subscriptions when the module is locked", () => {
    access = { enforced: true, modules: { capa: "none" }, plan: { name: "Starter" } };
    const { unmount } = at();
    expect(screen.getByRole("alert")).toHaveTextContent("capa");
    expect(catalogueCalls.every((o) => o.enabled === false)).toBe(true);
    unmount();
    permissions = ["subscription.read"];
    at();
    expect(catalogueCalls.some((o) => o.enabled === true)).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("Required package: Pro");
  });
});
