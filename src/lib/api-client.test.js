import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase-client", () => ({
  default: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "tok-123" } } })) } },
}));

import { apiFetch, ApiClientError, describeApiError, API_URL } from "./api-client";

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("apiFetch", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("sends the access token, organisation, correlation id, reason and idempotency key", async () => {
    fetch.mockResolvedValue(jsonResponse(200, { ok: true }));
    const result = await apiFetch("/sites", {
      method: "POST",
      body: { code: "A" },
      organisationId: "org-1",
      reason: "Because",
      idempotencyKey: "key-1",
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/sites`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ code: "A" }));
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok-123",
      "X-Organisation-Id": "org-1",
      "X-Change-Reason": "Because",
      "Idempotency-Key": "key-1",
      "Content-Type": "application/json",
    });
    expect(init.headers["X-Correlation-Id"]).toBeTruthy();
  });

  it("turns the API error format into an ApiClientError", async () => {
    fetch.mockResolvedValue(
      jsonResponse(409, { error: { code: "conflict", message: "A site with this code already exists", correlationId: "c-1" } })
    );
    const error = await apiFetch("/sites", { method: "POST", body: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 409, code: "conflict", correlationId: "c-1" });
    expect(describeApiError(error)).toBe("A site with this code already exists");
  });

  it("lists field problems for validation errors", async () => {
    fetch.mockResolvedValue(
      jsonResponse(400, {
        error: { code: "validation_failed", message: "Request validation failed", details: [{ path: "name", message: "Too short" }] },
      })
    );
    const error = await apiFetch("/organisations", { method: "POST", body: {} }).catch((e) => e);
    expect(describeApiError(error)).toBe("name: Too short");
  });

  it("reports an unreachable API clearly", async () => {
    fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await apiFetch("/me").catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: "api_unreachable" });
    expect(error.message).toContain(API_URL);
  });
});
