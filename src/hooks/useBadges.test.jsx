import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

const apiFetch = vi.fn();
vi.mock("../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import { BADGE_POLL_MS, badgesKey, useBadges } from "./useBadges";
import { guessBellRead } from "./useNotifications";

beforeEach(() => {
  apiFetch.mockReset();
});

describe("useBadges", () => {
  it("asks one endpoint, for the organisation, and keeps the answer under the organisation's key", async () => {
    apiFetch.mockResolvedValue({ notifications: 3, tasks: 1, alerts: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useBadges(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual({ notifications: 3, tasks: 1, alerts: null }));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/badges", { organisationId: "org-1" });
    expect(client.getQueryData(badgesKey("org-1"))).toBeTruthy();
    // The key is under the organisation's root, so an action anywhere marks it stale.
    expect(badgesKey("org-1").slice(0, 3)).toEqual(["api", "org", "org-1"]);
    expect(BADGE_POLL_MS).toBe(60_000);
  });
});

describe("guessBellRead", () => {
  it("takes the marked notices off the bell, never below zero", () => {
    expect(guessBellRead({ notifications: 5, tasks: 2 }, { ids: ["a", "b"] })).toEqual({ notifications: 3, tasks: 2 });
    expect(guessBellRead({ notifications: 1 }, { ids: ["a", "b"] })).toEqual({ notifications: 0 });
  });
  it("empties the bell when everything is marked read", () => {
    expect(guessBellRead({ notifications: 7, tasks: 1 }, { all: true })).toEqual({ notifications: 0, tasks: 1 });
  });
  it("leaves things alone when there is nothing to change", () => {
    const zero = { notifications: 0 };
    expect(guessBellRead(zero, { all: true })).toBe(zero);
    const other = { tasks: 1 };
    expect(guessBellRead(other, { all: true })).toBe(other);
  });
});
