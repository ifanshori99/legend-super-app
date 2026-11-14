import {
  matchEndpointPath,
  type AnyEndpoint,
  type EndpointOutput,
} from "@starter/shared/api";
import type { z } from "zod";
import type { CallHeaders } from "../api/endpoint-core.ts";
import type { MockScenario } from "./control.ts";

type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;
type WireOut<E extends AnyEndpoint> = E["response"] extends z.ZodType
  ? z.input<E["response"]>
  : void;

/** What a mock handler receives: input already validated like the real API. */
export type MockContext<E extends AnyEndpoint> = {
  endpoint: E;
  params: Parsed<E["params"]>;
  query: Parsed<E["query"]>;
  body: Parsed<E["body"]>;
  scenario: MockScenario;
  signal?: AbortSignal;
  headers?: CallHeaders;
};

/**
 * Returns the response body (wire shape; it is validated against the
 * endpoint's schema) or throws `ApiError(status, CODE, message)` to simulate
 * a failure such as `CONFLICT`.
 */
export type MockHandler<E extends AnyEndpoint> = (
  context: MockContext<E>,
) => WireOut<E> | Promise<WireOut<E>>;

export type { EndpointOutput };

type Entry = {
  endpoint: AnyEndpoint;
  handler: MockHandler<AnyEndpoint>;
  /** Where it was registered, so a duplicate names both owners. */
  origin: string;
};
const entries = new Map<string, Entry>();

/** The first stack frame outside this file, e.g. `mock.ts:87:1`. */
function originOf(): string {
  const stack = new Error().stack?.split("\n").slice(2) ?? [];
  const frame = stack.find((line) => !line.includes("registry.ts"));
  return frame?.trim().replace(/^at\s+/, "") ?? "unknown";
}

/**
 * Registers the one mock for an endpoint. A second registration of the same
 * endpoint is a bug: the registry used to keep whichever module loaded last, so
 * two features silently fought over one route and the UI showed the loser's
 * fixtures (review legend-7ko, bead legend-jzud). Own the endpoint in one
 * feature (or a shared module in `lib/mock/handlers/`) and import the other
 * feature's handler function instead of registering again.
 *
 * `replace` is only for an arbiter that deliberately re-registers a default a
 * shared module already registered (GET /api/auth/me, current-auth.ts); it must
 * not be used to paper over two features owning one endpoint.
 *
 * Hot reload: `transport.ts` clears the registry when Vite disposes the mock
 * module graph, so a re-evaluated module registers into an empty registry
 * rather than throwing at itself.
 */
export function registerMock<E extends AnyEndpoint>(
  endpoint: E,
  handler: MockHandler<E>,
  options: { replace?: boolean } = {},
) {
  const existing = entries.get(endpoint.id);
  if (existing && !options.replace)
    throw new Error(
      `[mock] Duplicate handler for "${endpoint.id}".\n` +
        `  first:  ${existing.origin}\n` +
        `  second: ${originOf()}\n` +
        "One owner per endpoint: export the handler and import it instead of calling registerMock twice.",
    );
  entries.set(endpoint.id, {
    endpoint,
    handler,
    origin: originOf(),
  } as unknown as Entry);
}

export function clearMocks() {
  entries.clear();
}

export function registeredMockIds(): string[] {
  return [...entries.keys()];
}

/** Finds the mock for a request; a static path beats one with `:params`. */
export function findMock(method: string, pathname: string) {
  let best: {
    entry: Entry;
    params: Record<string, string>;
    weight: number;
  } | null = null;
  for (const entry of entries.values()) {
    if (entry.endpoint.method !== method) continue;
    const params = matchEndpointPath(entry.endpoint.path, pathname);
    if (!params) continue;
    const weight = Object.keys(params).length;
    if (!best || weight < best.weight) best = { entry, params, weight };
  }
  return best;
}
