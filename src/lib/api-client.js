import supabase from "../supabase-client";
import { browserTimeZone } from "./timeZones";

/** Base URL of the QMS API (see api/README.md). */
export const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:3001").replace(/\/$/, "");

/** Error thrown for every failed API call, carrying the API's { code, message, details, correlationId }. */
export class ApiClientError extends Error {
  constructor({ status, code, message, details, correlationId }) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.correlationId = correlationId;
  }
}

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * Calls the API as the signed-in user.
 * @param {string} path e.g. "/me" (prefixed with /api/v1)
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.body] JSON body
 * @param {string} [options.organisationId] sent as X-Organisation-Id
 * @param {string} [options.reason] sent as X-Change-Reason (recorded in the audit trail)
 * @param {string} [options.idempotencyKey] sent as Idempotency-Key
 */
export async function apiFetch(path, { method = "GET", body, organisationId, reason, idempotencyKey } = {}) {
  const { data } = await supabase.auth.getSession();
  const accessToken = data?.session?.access_token;
  const correlationId = newId();

  const headers = { Accept: "application/json", "X-Correlation-Id": correlationId };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  // Tells the API which calendar day it is for this person, so "not in the future" and "overdue" use their today, not UTC.
  const timeZone = browserTimeZone();
  if (timeZone) headers["X-Time-Zone"] = timeZone;
  if (organisationId) headers["X-Organisation-Id"] = organisationId;
  if (reason) headers["X-Change-Reason"] = reason;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${API_URL}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiClientError({
      status: 0,
      code: "api_unreachable",
      message: `The QMS API could not be reached at ${API_URL}. Is it running?`,
      correlationId,
    });
  }

  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiClientError({
      status: response.status,
      code: error.code ?? "http_error",
      message: error.message ?? `Request failed (${response.status})`,
      details: error.details,
      correlationId: error.correlationId ?? response.headers.get("X-Correlation-Id") ?? correlationId,
    });
  }
  return payload;
}

/** Human-readable message for an error from apiFetch (including field validation issues). */
export function describeApiError(error) {
  if (!(error instanceof ApiClientError)) return error?.message ?? "Something went wrong";
  if (error.code === "validation_failed" && Array.isArray(error.details) && error.details.length) {
    return error.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join("; ");
  }
  return error.message;
}

export const newIdempotencyKey = newId;
