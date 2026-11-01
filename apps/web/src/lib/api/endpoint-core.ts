import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
  PathParamValue,
} from "@starter/shared/api";
import { buildEndpointPath, zodIssuesToDetails } from "@starter/shared/api";
import type { z } from "zod";
import { ApiError } from "./errors.ts";

// The typed layer over a transport (apiFetch). Pure: no framework imports, so
// it is unit-tested in Node with a fake transport.

export type TransportRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
};
export type Transport = (
  path: string,
  request: TransportRequest,
) => Promise<unknown>;

export type CallOptions = { signal?: AbortSignal };

/** `[input]` is required only when the endpoint declares params, query or body. */
export type CallArgs<E extends AnyEndpoint> =
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {} extends EndpointInput<E>
    ? [input?: EndpointInput<E>, options?: CallOptions]
    : [input: EndpointInput<E>, options?: CallOptions];

function parseInput(schema: z.ZodType, value: unknown, where: string) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `Input ${where} tidak valid.`,
      zodIssuesToDetails(result.error),
    );
  return result.data;
}

function primitiveQuery(value: unknown): TransportRequest["query"] {
  if (value === undefined || value === null) return undefined;
  const query: NonNullable<TransportRequest["query"]> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || item === null) continue;
    if (
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    )
      throw new TypeError(`Query "${key}" must be a string, number or boolean`);
    query[key] = item;
  }
  return query;
}

/**
 * Builds the endpoint caller. With `validateResponse` on (development and mock
 * mode) every response is parsed with the endpoint's schema, so a contract
 * drift between FE, mock and API surfaces at once instead of as a blank screen.
 */
export function createEndpointCaller(
  transport: Transport,
  options: { validateResponse: () => boolean },
) {
  return async function callEndpoint<E extends AnyEndpoint>(
    endpoint: E,
    ...args: CallArgs<E>
  ): Promise<EndpointOutput<E>> {
    const [input = {} as EndpointInput<E>, callOptions] = args;
    const given = input as {
      params?: unknown;
      query?: unknown;
      body?: unknown;
    };
    const params = endpoint.params
      ? parseInput(endpoint.params, given.params, "path")
      : undefined;
    const query = endpoint.query
      ? parseInput(endpoint.query, given.query ?? {}, "query")
      : undefined;
    const body = endpoint.body
      ? parseInput(endpoint.body, given.body, "body")
      : undefined;

    const path = buildEndpointPath(
      endpoint.path,
      params as Record<string, PathParamValue> | undefined,
    );
    const payload = await transport(path, {
      method: endpoint.method,
      query: primitiveQuery(query),
      body,
      signal: callOptions?.signal,
    });

    if (!endpoint.response) return undefined as EndpointOutput<E>;
    if (!options.validateResponse()) return payload as EndpointOutput<E>;
    const result = (endpoint.response as z.ZodType).safeParse(payload);
    if (!result.success)
      throw new ApiError(
        502,
        "RESPONSE_SHAPE_INVALID",
        `Respons ${endpoint.id} tidak sesuai kontrak.`,
        zodIssuesToDetails(result.error),
      );
    return result.data as EndpointOutput<E>;
  };
}
