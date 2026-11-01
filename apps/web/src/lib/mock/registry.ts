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
 * Returns the response body (wire shape; it is validated against the
 * endpoint's schema) or throws `ApiError(status, CODE, message)` to simulate
 * a failure such as `CONFLICT`.
 */
export type MockHandler<E extends AnyEndpoint> = (
  context: MockContext<E>,
) => WireOut<E> | Promise<WireOut<E>>;

export type { EndpointOutput };

type Entry = { endpoint: AnyEndpoint; handler: MockHandler<AnyEndpoint> };
const entries = new Map<string, Entry>();

/** Registers (or replaces, for hot reload) the mock for one endpoint. */
export function registerMock<E extends AnyEndpoint>(
  endpoint: E,
  handler: MockHandler<E>,
) {
  entries.set(endpoint.id, { endpoint, handler } as unknown as Entry);
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
