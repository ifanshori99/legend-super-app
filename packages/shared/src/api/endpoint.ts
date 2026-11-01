// Endpoint contracts: one object per HTTP endpoint that carries its method,
// path template and the Zod schemas for params, query, body and response.
// The web app's typed client and mock mode, and later the API's route
// validation, all read the same object, so the contract is written once
// (PRD v1.7 §3 "Kontrak Bersama": contract first, FE and BE in parallel).
//
// Browser- and Node-safe: no framework imports. Relative imports end in .ts.

import type { z } from "zod";
import type { ApiErrorDetail } from "../core/errors.ts";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

type Schema = z.ZodType;
type MaybeSchema = Schema | undefined;

/** Path params are strings on the wire; numbers are accepted and stringified. */
export type PathParamValue = string | number;

export type EndpointDef<
  M extends HttpMethod = HttpMethod,
  Params extends MaybeSchema = MaybeSchema,
  Query extends MaybeSchema = MaybeSchema,
  Body extends MaybeSchema = MaybeSchema,
  Res extends MaybeSchema = MaybeSchema,
> = {
  /** "GET /api/orders/:orderId": unique key for registries and query keys. */
  readonly id: string;
  readonly method: M;
  /** Absolute path with `:name` segments, e.g. "/api/orders/:orderId". */
  readonly path: string;
  readonly params: Params;
  readonly query: Query;
  readonly body: Body;
  /** `undefined` means 204 No Content. */
  readonly response: Res;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEndpoint = EndpointDef<any, any, any, any, any>;

type Part<Key extends string, S extends MaybeSchema> = S extends Schema
  ? { [K in Key]: z.input<S> }
  : { [K in Key]?: never };

/** What a caller passes: `params`, `query`, `body` only where declared. */
export type EndpointInput<E extends AnyEndpoint> = Part<"params", E["params"]> &
  Part<"query", E["query"]> &
  Part<"body", E["body"]>;

/** What the server answers: the parsed response, or `void` for 204. */
export type EndpointOutput<E extends AnyEndpoint> = E["response"] extends Schema
  ? z.output<E["response"]>
  : void;

const PARAM_SEGMENT = /^:([A-Za-z][A-Za-z0-9]*)$/;

/** Names of the `:param` segments in a path template, in order. */
export function pathParamNames(path: string): string[] {
  return path
    .split("/")
    .map((segment) => PARAM_SEGMENT.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

export function defineEndpoint<
  M extends HttpMethod,
  Params extends MaybeSchema = undefined,
  Query extends MaybeSchema = undefined,
  Body extends MaybeSchema = undefined,
  Res extends MaybeSchema = undefined,
>(spec: {
  method: M;
  path: string;
  params?: Params;
  query?: Query;
  body?: Body;
  response?: Res;
}): EndpointDef<M, Params, Query, Body, Res> {
  if (!spec.path.startsWith("/"))
    throw new TypeError(`Endpoint path must start with "/": ${spec.path}`);
  if (pathParamNames(spec.path).length > 0 && !spec.params)
    throw new TypeError(
      `Endpoint ${spec.method} ${spec.path} has :params but declares no params schema`,
    );
  if (spec.method === "GET" && spec.body)
    throw new TypeError(`GET ${spec.path} cannot have a body`);
  return Object.freeze({
    id: `${spec.method} ${spec.path}`,
    method: spec.method,
    path: spec.path,
    params: spec.params as Params,
    query: spec.query as Query,
    body: spec.body as Body,
    response: spec.response as Res,
  });
}

/** Fills a path template; every `:param` must be present and is URL-encoded. */
export function buildEndpointPath(
  path: string,
  params: Readonly<Record<string, PathParamValue>> = {},
): string {
  return path
    .split("/")
    .map((segment) => {
      const name = PARAM_SEGMENT.exec(segment)?.[1];
      if (name === undefined) return segment;
      const value = params[name];
      if (value === undefined || String(value) === "")
        throw new TypeError(`Missing path param "${name}" for ${path}`);
      return encodeURIComponent(String(value));
    })
    .join("/");
}

/** Matches a concrete pathname against a template; returns params or null. */
export function matchEndpointPath(
  path: string,
  pathname: string,
): Record<string, string> | null {
  const template = path.split("/");
  const actual = pathname.split("/");
  if (template.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < template.length; index += 1) {
    const name = PARAM_SEGMENT.exec(template[index])?.[1];
    if (name === undefined) {
      if (template[index] !== actual[index]) return null;
      continue;
    }
    if (actual[index] === "") return null;
    try {
      params[name] = decodeURIComponent(actual[index]);
    } catch {
      return null;
    }
  }
  return params;
}

/** Zod issues → the API error envelope's `details` (dotted field paths). */
export function zodIssuesToDetails(error: z.ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
