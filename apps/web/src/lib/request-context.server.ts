import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type RequestContext = { reqId: string; degraded: boolean };

const storage = new AsyncLocalStorage<RequestContext>();
const SAFE_REQUEST_ID = /^[\w-]{1,128}$/;

export function getRequestContext() {
  return storage.getStore();
}

// An SSR read failed transiently (429, 5xx, network) or returned an unusable
// answer, so the page may be rendered with defaults instead of the tenant's
// data. start.ts then refuses shared caching of that response (legend-vz93).
export function markRequestDegraded() {
  const context = storage.getStore();
  if (context) context.degraded = true;
}

export function isRequestDegraded() {
  return storage.getStore()?.degraded === true;
}

// Reuses a well-formed incoming X-Request-Id (e.g. from a load balancer),
// otherwise mints one, and runs the rest of the request inside that context.
export function runWithRequestContext<T>(
  incoming: string | null,
  fn: (reqId: string) => T,
) {
  const reqId =
    incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  return storage.run({ reqId, degraded: false }, () => fn(reqId));
}
