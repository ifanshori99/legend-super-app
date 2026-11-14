import { createIsomorphicFn } from "@tanstack/react-start";
import { API_URL } from "@/lib/env";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/lib/api/errors";
import { bearerHeaderFor } from "@/lib/api/credentials";
import type { CallHeaders } from "@/lib/api/endpoint-core";
import {
  ACTING_STAFF_HELD_MESSAGE,
  actingStaffHeaderFor,
  handleActingStaffRejection,
} from "@/lib/api/acting-staff";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import type { ApiErrorBody } from "@starter/shared/types";
import {
  apiBaseUrl,
  forwardedHeaders,
  logUpstreamFailure,
} from "@/lib/api/upstream.server";

export { ApiError };

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type FailureLogger = (
  path: string,
  detail: { status?: number; err?: unknown },
) => void;

type ApiRequest = {
  method?: Method;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: CallHeaders;
};

// Where and how to call the API from the current environment. The .server()
// branch (and its server-only imports) is compiled out of the browser bundle;
// keep server-only names out of the .client() branch, even in types.
// - Browser: the public API origin, with the visitor's cookies.
// - Server (SSR loaders, e.g. queryClient.ensureQueryData during render): the
//   internal API origin, forwarding the visitor's cookie and request ID.
// Only GETs run on the server; mutations come from the browser, which sends
// the Origin header the API's CSRF check requires.
const target = createIsomorphicFn()
  .server(() => ({
    baseUrl: apiBaseUrl(),
    headers: forwardedHeaders(),
    onFailure: logUpstreamFailure as FailureLogger,
  }))
  .client(() => ({
    baseUrl: API_URL,
    headers: {} as Record<string, string>,
    onFailure: (() => {}) as FailureLogger,
  }));

export async function apiFetch<T>(
  path: string,
  {
    method = "GET",
    query,
    body,
    signal,
    headers: callHeaders,
  }: ApiRequest = {},
): Promise<T> {
  // Mock mode (VITE_API_MOCK): fixtures instead of the network. The dynamic
  // import is compiled out of builds that do not set the flag.
  if (import.meta.env.VITE_API_MOCK === "true") {
    const { mockFetch } = await import("@/lib/mock/transport");
    return mockFetch<T>(path, {
      method,
      query,
      body,
      signal,
      headers: callHeaders,
    });
  }
  const { baseUrl, headers, onFailure } = target();
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {}))
    if (value !== undefined) url.searchParams.set(key, String(value));

  // POS mutation without a live cashier: never send it as the session owner.
  const actingHeader = actingStaffHeaderFor(path, method);
  if (actingHeader === null)
    throw new ApiError(
      401,
      ACTING_STAFF_ERROR_CODES.EXPIRED,
      ACTING_STAFF_HELD_MESSAGE,
    );

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...bearerHeaderFor(path),
        // Browser only, POS paths only (see acting-staff.ts).
        ...actingHeader,
        ...headers,
        // Per-call headers are allow-listed (contracts.md "Typed web client &
        // idempotency headers"): only Idempotency-Key and X-Reservation-Link-Token
        // are forwarded, so no caller can override the cookie, request id or
        // bearer set above.
        ...(callHeaders?.["Idempotency-Key"] === undefined
          ? {}
          : { "Idempotency-Key": callHeaders["Idempotency-Key"] }),
        ...(callHeaders?.["X-Reservation-Link-Token"] === undefined
          ? {}
          : {
              "X-Reservation-Link-Token":
                callHeaders["X-Reservation-Link-Token"],
            }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    onFailure(path, { err });
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  }

  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as
    (T & Partial<ApiErrorBody>) | null;
  if (!response.ok) {
    onFailure(path, { status: response.status });
    const error = payload?.error as
      | (ApiErrorBody["error"] & {
          remainingAttempts?: number;
          lockedUntil?: string;
          acknowledgedBy?: { displayName?: unknown };
          acknowledgedAt?: string;
        })
      | undefined;
    if (error?.code) handleActingStaffRejection(error.code, method);
    throw new ApiError(
      response.status,
      error?.code ?? "HTTP_ERROR",
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details,
      {
        remainingAttempts:
          typeof error?.remainingAttempts === "number"
            ? error.remainingAttempts
            : undefined,
        lockedUntil:
          typeof error?.lockedUntil === "string"
            ? error.lockedUntil
            : undefined,
        acknowledgedBy:
          typeof error?.acknowledgedBy?.displayName === "string"
            ? { displayName: error.acknowledgedBy.displayName }
            : undefined,
        acknowledgedAt:
          typeof error?.acknowledgedAt === "string"
            ? error.acknowledgedAt
            : undefined,
      },
    );
  }
  return payload as T;
}
