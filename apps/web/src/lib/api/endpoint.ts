import { queryOptions } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import { apiFetch } from "./client";
import { createEndpointCaller } from "./endpoint-core.ts";
import type { CallArgs } from "./endpoint-core.ts";
import { API_MOCK } from "./mock-flag.ts";

export type { CallArgs, CallOptions } from "./endpoint-core.ts";

/**
 * Calls a contract endpoint with typed params/query/body and a typed result.
 * Response parsing is on in development and mock mode.
 */
export const callEndpoint = createEndpointCaller(apiFetch, {
  validateResponse: () => import.meta.env.DEV || API_MOCK,
});

/** Stable TanStack Query key: endpoint id + the input that was passed. */
export function endpointQueryKey<E extends AnyEndpoint>(
  endpoint: E,
  ...args: CallArgs<E>
) {
  return [endpoint.id, args[0] ?? {}] as const;
}

/** queryOptions for a GET endpoint: key, signal and typed result included. */
export function endpointQueryOptions<E extends AnyEndpoint & { method: "GET" }>(
  endpoint: E,
  ...args: CallArgs<E>
) {
  const [input] = args;
  return queryOptions({
    queryKey: endpointQueryKey(endpoint, ...args),
    queryFn: ({ signal }) =>
      callEndpoint(
        endpoint,
        ...([input, { signal }] as unknown as CallArgs<E>),
      ),
  });
}
