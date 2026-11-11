// legend-vz93: a render that fell back to defaults after a transient upstream
// failure is flagged on the request context so start.ts keeps it out of
// shared caches.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { isRequestDegraded, markRequestDegraded, runWithRequestContext } =
  await import("../apps/web/src/lib/request-context.server.ts");

test("legend-vz93: a fresh request is not degraded", () => {
  runWithRequestContext(null, () => {
    assert.equal(isRequestDegraded(), false);
  });
});

test("legend-vz93: marking degrades only that request", () => {
  runWithRequestContext(null, () => {
    markRequestDegraded();
    assert.equal(isRequestDegraded(), true);
  });
  runWithRequestContext(null, () => {
    assert.equal(isRequestDegraded(), false);
  });
});

test("legend-vz93: marking outside a request is a no-op", () => {
  markRequestDegraded();
  assert.equal(isRequestDegraded(), false);
});
