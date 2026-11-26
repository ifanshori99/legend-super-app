import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
  PathParamValue,
} from "@starter/shared/api";
import { buildEndpointPath, zodIssuesToDetails } from "@starter/shared/api";
import { z } from "zod";
import { idempotencyKeySchema } from "@starter/shared/core";
import { reservationLinkTokenSchema } from "@starter/shared/reservation";
import { ApiError } from "./errors.ts";

// The typed layer over a transport (apiFetch). Pure: no framework imports, so
// it is unit-tested in Node with a fake transport.

export type TransportRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: CallOptions["headers"];
};
export type Transport = (
  path: string,
  request: TransportRequest,
) => Promise<unknown>;

/**
 * Per-call headers a caller may set. Allow-list: Idempotency-Key and the
 * reservation link token (a bearer secret for the public guest page; the token
 * lives in the URL fragment and travels only in this header).
 */
export type CallHeaders = {
  "Idempotency-Key"?: string;
  "X-Reservation-Link-Token"?: string;
};

export type CallOptions = {
  signal?: AbortSignal;
  headers?: CallHeaders;
};

const headersSchema = z
  .object({
    "Idempotency-Key": idempotencyKeySchema.optional(),
    "X-Reservation-Link-Token": reservationLinkTokenSchema.optional(),
  })
  .strict();

/** `[input]` is required only when the endpoint declares params, query or body. */
export type CallArgs<E extends AnyEndpoint> =
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {} extends EndpointInput<E>
    ? [input?: EndpointInput<E>, options?: CallOptions]
    : [input: EndpointInput<E>, options?: CallOptions];

function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  where: string,
): z.output<S> {
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
    // A query schema that splits a comma list (`status=a,b`) parses to an
    // array; it goes out again as the same comma list (brief 1268 W5).
    if (
      Array.isArray(item) &&
      item.every((entry) => typeof entry === "string")
    ) {
      query[key] = item.join(",");
      continue;
    }
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
      headers:
        callOptions?.headers === undefined
          ? undefined
          : parseInput(headersSchema, callOptions.headers, "headers"),
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
