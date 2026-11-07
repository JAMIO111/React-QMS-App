import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

const apiFetch = vi.fn();
vi.mock("./api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1", selectOrganisation: vi.fn() }) }));
vi.mock("../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

import { orgRoot, refreshOrganisation } from "./refresh";
import { useInspectionMutation } from "../hooks/useInspection";
import { useMemberMutation, useStructureMutation, useUpdateProfile } from "../hooks/useQmsApi";
import { useAcknowledgeAlert, useCreateBaseline } from "../hooks/useSpc";
import { useNcrMutation } from "../hooks/useNcr";
import { useMasterDataMutation } from "../hooks/useMasterData";
import { useProcessControlMutation } from "../hooks/useProcessControl";
import { useCalibrationMutation } from "../hooks/useCalibration";
import { useChangeSeats, useConfirmCheckout, usePortalSession, useSeatPreview, useStartCheckout, useSubscriptionMutation } from "../hooks/useSubscription";
import { useAlertMutation } from "../hooks/useDocumentation";
import { useMarkNotificationsRead } from "../hooks/useNotifications";
import { useCapaMutation } from "../hooks/useCapa";
import { useOnboardingMutation } from "../hooks/useOnboarding";
import { useJobMutation } from "../hooks/useJobs";

/** What other modules have on screen: each must be marked stale by an action in any module. */
const watched = [
  ["api", "org", "org-1", "inspection", "a"],
  ["api", "org", "org-1", "spc", "chart"],
  ["api", "org", "org-1", "spc", "alerts", "open"],
  ["api", "org", "org-1", "ncr", "list"],
  ["api", "org", "org-1", "calibration", "gauges"],
  ["api", "org", "org-1", "master", "parts"],
  ["api", "org", "org-1", "documentation", "mine-count"],
  ["api", "org", "org-1", "documentation", "active"],
  ["api", "org", "org-1", "process-control-dashboard", "a", "b"],
  ["api", "org", "org-1", "notifications", "list"],
  ["api", "org", "org-1", "subscription", "assignments"],
  ["api", "org", "org-1", "members"],
  ["api", "org", "org-1", "departments"],
];
const elsewhere = [["api", "org", "org-2", "ncr", "list"], ["api", "units"]];

const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  [...watched, ...elsewhere, ["api", "me", "u1"]].forEach((k) => client.setQueryData(k, { data: [] }));
  const wrapper = ({ children }) => createElement(QueryClientProvider, { client }, children);
  const stale = (k) => client.getQueryState(k)?.isInvalidated === true;
  return { client, wrapper, stale };
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });
});

describe("refreshOrganisation", () => {
  it("marks everything cached for the organisation stale, and nothing of another organisation or global data", () => {
    const { client, stale } = setup();
    refreshOrganisation(client, "org-1");
    watched.forEach((k) => expect(stale(k), k.join("/")).toBe(true));
    elsewhere.forEach((k) => expect(stale(k), k.join("/")).toBe(false));
    expect(stale(["api", "me", "u1"])).toBe(false);
  });

  it("refreshes the signed-in person's permissions only when asked", () => {
    const { client, stale } = setup();
    refreshOrganisation(client, "org-1", { me: true });
    expect(stale(["api", "me", "u1"])).toBe(true);
  });

  it("orgRoot is the prefix every organisation query key starts with", () => {
    expect(orgRoot("org-1")).toEqual(["api", "org", "org-1"]);
  });
});

describe("every action refreshes every module's data", () => {
  const cases = [
    ["inspection (add a sample, raise an NC)", useInspectionMutation, { path: "/inspections/x/samples", body: {} }],
    ["NC", useNcrMutation, { path: "/ncrs", body: { title: "x" } }],
    ["master data", useMasterDataMutation, { path: "/parts", body: { partNumber: "x" } }],
    ["process control", useProcessControlMutation, { path: "/machines", body: { code: "x" } }],
    ["calibration", useCalibrationMutation, { path: "/gauges", body: { assetNumber: "x" } }],
    ["quality alert", useAlertMutation, { action: "issue", id: "a1" }],
    ["members and departments", useMemberMutation, { action: "status", membershipId: "m1", body: { status: "active" } }],
    ["invite many", useMemberMutation, { action: "inviteMany", body: { invitations: [] } }],
    ["resend invitation", useMemberMutation, { action: "resend", membershipId: "m1" }],
    ["revoke invitation", useMemberMutation, { action: "revoke", membershipId: "m1" }],
    ["own profile", useUpdateProfile, { firstName: "Ada" }],
    ["sites and departments", useStructureMutation, { resource: "departments", body: { name: "x" } }],
    ["SPC alert", useAcknowledgeAlert, { id: "a1", note: "seen" }],
    ["SPC baseline", useCreateBaseline, { partId: "p1" }],
    ["subscription", useSubscriptionMutation, { action: "seats", planSlug: "controller", quantity: 2 }],
    ["notifications read", useMarkNotificationsRead, { all: true }],
    ["CAPA / 8D", useCapaMutation, { action: "update", id: "c1", body: { title: "x" } }],
    ["start checkout", useStartCheckout, { interval: "month", seats: { controller: 1 } }],
    ["confirm checkout", useConfirmCheckout, { sessionId: "cs_test_1" }],
    ["billing portal", usePortalSession, undefined],
    ["seat preview", useSeatPreview, { seats: { controller: 2 } }],
    ["seat change", useChangeSeats, { seats: { controller: 2 } }],
    ["set-up wizard step", useOnboardingMutation, { action: "setStep", body: { step: "details", status: "done" } }],
    ["set-up wizard finish", useOnboardingMutation, { action: "complete" }],
    ["start a job", useJobMutation, { machineId: "m1", partId: "p1" }],
    ["job details", useJobMutation, { id: "11111111-1111-1111-1111-111111111111", workOrder: "WO-1" }],
    ["CAPA / 8D action", useCapaMutation, { action: "completeAction", id: "a1", body: {} }],
  ];

  it.each(cases)("%s", async (_name, useHook, variables) => {
    const { client, wrapper, stale } = setup();
    const { result } = renderHook(() => useHook(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(variables);
    });
    await waitFor(() => watched.forEach((k) => expect(stale(k), k.join("/")).toBe(true)));
    elsewhere.forEach((k) => expect(stale(k), k.join("/")).toBe(false));
    expect(client.getQueryState(["api", "org", "org-2", "ncr", "list"]).isInvalidated).toBe(false);
  });
});
