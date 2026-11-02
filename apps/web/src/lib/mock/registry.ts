import {
  matchEndpointPath,
  type AnyEndpoint,
  type EndpointOutput,
} from "@starter/shared/api";
import type { z } from "zod";
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
};

/**
 * A handler answers `MOCK_UNHANDLED` when the request belongs to another
 * screen that mocks the same endpoint — one endpoint can serve several
 * screens (`GET /api/dashboards/:dashboard` feeds owner, shareholder and
 * management). The runtime then asks the next registration for that endpoint,
 * so parallel FE beads never take each other's screens out of mock mode.
 */
export const MOCK_UNHANDLED: unique symbol = Symbol("mock-unhandled");

/**
 * Returns the response body (wire shape; it is validated against the
 * endpoint's schema) or throws `ApiError(status, CODE, message)` to simulate
 * a failure such as `CONFLICT`. Returns `MOCK_UNHANDLED` to decline.
 */
export type MockHandler<E extends AnyEndpoint> = (
  context: MockContext<E>,
) => WireOut<E> | typeof MOCK_UNHANDLED | Promise<WireOut<E> | typeof MOCK_UNHANDLED>;

export type { EndpointOutput };

type Entry = {
  endpoint: AnyEndpoint;
  handler: MockHandler<AnyEndpoint>;
  /** Registration order; the newest registration is asked first. */
  sequence: number;
};
const entries = new Map<string, Entry[]>();
let sequence = 0;

/** Registers (or replaces, for hot reload) the mock for one endpoint. */
export function registerMock<E extends AnyEndpoint>(
  endpoint: E,
  handler: MockHandler<E>,
) {
  const previous = entries.get(endpoint.id) ?? [];
  // Hot reload re-registers the same handler; keep only the newest per id and
  // order every registration so a declining handler falls through.
  const kept = previous.filter((entry) => entry.handler !== handler);
  entries.set(endpoint.id, [
    ...kept,
    { endpoint, handler, sequence: ++sequence } as unknown as Entry,
  ]);
}

export function clearMocks() {
  entries.clear();
}

export function registeredMockIds(): string[] {
  return [...entries.keys()];
}

export type FoundMock = {
  entry: Entry;
  params: Record<string, string>;
  weight: number;
};

function matches(method: string, pathname: string): FoundMock[] {
  const found: FoundMock[] = [];
  for (const group of entries.values())
    for (const entry of group) {
      if (entry.endpoint.method !== method) continue;
      const params = matchEndpointPath(entry.endpoint.path, pathname);
      if (!params) continue;
      found.push({ entry, params, weight: Object.keys(params).length });
    }
  return found;
}

/**
 * Every mock for a request, in the order to try them: a static path beats one
 * with `:params`, and for the same path the newest registration goes first.
 */
export function findMocks(method: string, pathname: string): FoundMock[] {
  return matches(method, pathname).sort(
    (a, b) => a.weight - b.weight || b.entry.sequence - a.entry.sequence,
  );
}

/** Finds the first mock for a request; see `findMocks` for the order. */
export function findMock(method: string, pathname: string) {
  return findMocks(method, pathname)[0] ?? null;
}
