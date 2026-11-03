import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

let me;
vi.mock("../lib/api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => me, useMutation: vi.fn(), useQueryClient: vi.fn() }));
vi.mock("../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import { useCanSee } from "./useQmsApi";

const membership = (permissions) => ({ data: { memberships: [{ organisation: { id: "org-1" }, permissions }] }, isLoading: false, error: null });

describe("useCanSee", () => {
  it("shows items the user has permission for, hides the rest", () => {
    me = membership(["ncr.read"]);
    const { result } = renderHook(() => useCanSee());
    expect(result.current("ncr.read")).toBe(true);
    expect(result.current("members.read")).toBe(false);
    expect(result.current(undefined)).toBe(true);
  });

  it("keeps everything visible while permissions are unknown (the server still enforces them)", () => {
    me = { data: undefined, isLoading: false, error: new Error("API unreachable") };
    const { result } = renderHook(() => useCanSee());
    expect(result.current("members.read")).toBe(true);
  });
});
