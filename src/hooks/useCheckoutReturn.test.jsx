import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createElement } from "react";

const mutateAsync = vi.fn();
vi.mock("./useSubscription", () => ({ useConfirmCheckout: () => ({ mutateAsync }) }));

import { useCheckoutReturn } from "./useCheckoutReturn";

const run = (url) => {
  const wrapper = ({ children }) => createElement(MemoryRouter, { initialEntries: [url] }, children);
  return renderHook(() => ({ checkout: useCheckoutReturn(), location: useLocation() }), { wrapper });
};

beforeEach(() => {
  mutateAsync.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("coming back from Stripe Checkout", () => {
  it("does nothing on an ordinary visit", () => {
    const { result } = run("/Settings/Subscription");
    expect(result.current.checkout.phase).toBe("idle");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("remembers a cancelled checkout and cleans the address", async () => {
    const { result } = run("/setup/plan?checkout=cancelled");
    expect(result.current.checkout.phase).toBe("cancelled");
    await waitFor(() => expect(result.current.location.search).toBe(""));
    act(() => result.current.checkout.dismiss());
    expect(result.current.checkout.phase).toBe("idle");
  });

  it("asks the server to check the session (the redirect alone proves nothing), then reports done and cleans the address", async () => {
    mutateAsync.mockResolvedValue({ status: "complete" });
    const { result } = run("/setup/plan?checkout=success&session_id=cs_test_1");
    expect(result.current.checkout.phase).toBe("confirming");
    await waitFor(() => expect(result.current.checkout.phase).toBe("done"));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith({ sessionId: "cs_test_1" });
    expect(result.current.location.search).toBe("");
  });

  it("an address with success but no session id does not pretend to confirm anything", () => {
    const { result } = run("/setup/plan?checkout=success");
    expect(result.current.checkout.phase).toBe("idle");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("keeps asking every few seconds while Stripe says the person has not finished, then gives up with a way to try again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mutateAsync.mockResolvedValue({ status: "open" });
    const { result } = run("/setup/plan?checkout=success&session_id=cs_test_2");
    await waitFor(() => expect(result.current.checkout.phase).toBe("waiting"));
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
    }
    expect(result.current.checkout.phase).toBe("timeout");
    expect(mutateAsync).toHaveBeenCalledTimes(10);
    mutateAsync.mockResolvedValue({ status: "complete" });
    await act(async () => result.current.checkout.retry());
    await waitFor(() => expect(result.current.checkout.phase).toBe("done"));
  });

  it("reports an expired checkout", async () => {
    mutateAsync.mockResolvedValue({ status: "expired" });
    const { result } = run("/setup/plan?checkout=success&session_id=cs_test_3");
    await waitFor(() => expect(result.current.checkout.phase).toBe("expired"));
  });

  it("reports a failure with its error, and can try again", async () => {
    const error = new Error("nope");
    mutateAsync.mockRejectedValueOnce(error).mockResolvedValue({ status: "complete" });
    const { result } = run("/setup/plan?checkout=success&session_id=cs_test_4");
    await waitFor(() => expect(result.current.checkout.phase).toBe("failed"));
    expect(result.current.checkout.error).toBe(error);
    await act(async () => result.current.checkout.retry());
    await waitFor(() => expect(result.current.checkout.phase).toBe("done"));
    expect(result.current.checkout.error).toBeNull();
  });
});
