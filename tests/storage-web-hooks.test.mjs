import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

// Invoke the hook with the React/query boundaries controlled, then exercise
// its actual expiry subscription. QueryObserver integration lives alongside
// the transport tests and covers the real renewal scheduler.
const harness = { result: {}, options: undefined, store: undefined };
globalThis.__storageHookTest = harness;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "react")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(`
        export const useCallback = (callback) => callback;
        export function useSyncExternalStore(subscribe, snapshot, serverSnapshot) {
          globalThis.__storageHookTest.store = { subscribe, snapshot, serverSnapshot };
          return typeof window === 'undefined' ? serverSnapshot() : snapshot();
        }
      `),
        shortCircuit: true,
      };
    if (specifier === "@tanstack/react-query")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(`
        export const queryOptions = (options) => options;
        export const useMutation = (options) => options;
        export function useQuery(options) {
          globalThis.__storageHookTest.options = options;
          return globalThis.__storageHookTest.result;
        }
      `),
        shortCircuit: true,
      };
    if (specifier === "@/lib/api/mock-flag")
      return {
        url: "data:text/javascript,export const API_MOCK=false",
        shortCircuit: true,
      };
    if (specifier === "@/lib/env")
      return {
        url: "data:text/javascript,export const API_URL='https://api.example.test'",
        shortCircuit: true,
      };
    if (specifier.startsWith("@/"))
      return nextResolve(
        new URL(`../apps/web/src/${specifier.slice(2)}.ts`, import.meta.url)
          .href,
        context,
      );
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { useStorageObjectUrl } =
  await import("../apps/web/src/features/storage/hooks.ts");
const originalWindow = globalThis.window;
afterEach(() => {
  globalThis.window = originalWindow;
});
const objectId = "00000000-0000-4000-8000-000000000003";

test("[legend-avf8m M1-04] hook expires a rendered URL and unsubscribes its timer", (context) => {
  const now = Date.parse("2026-11-14T07:00:00.000Z");
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  globalThis.window = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
  };
  harness.result = {
    data: {
      url: "https://storage.example.test/photo",
      expiresAt: new Date(now + 300_000).toISOString(),
    },
    isError: false,
  };
  assert.equal(useStorageObjectUrl(objectId).url, harness.result.data.url);
  assert.equal(harness.options.enabled, true);
  let changes = 0;
  const unsubscribe = harness.store.subscribe(() => {
    changes++;
  });
  context.mock.timers.tick(299_999);
  assert.equal(changes, 0);
  assert.equal(harness.store.snapshot(), true);
  context.mock.timers.tick(2);
  assert.equal(changes, 1);
  assert.equal(harness.store.snapshot(), false);
  assert.equal(useStorageObjectUrl(objectId).url, undefined);
  unsubscribe();

  harness.result.data.expiresAt = new Date(Date.now() + 100).toISOString();
  useStorageObjectUrl(objectId);
  const cancel = harness.store.subscribe(() => {
    changes++;
  });
  cancel();
  context.mock.timers.tick(101);
  assert.equal(
    changes,
    1,
    "unmount or a new object removes the old expiry timer",
  );
});

test("[legend-avf8m M1-04] hook exposes image-error renewal and hides refused URLs", () => {
  globalThis.window = {};
  let calls = 0;
  harness.result = {
    data: {
      url: "https://storage.example.test/photo",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
    isError: false,
    refetch: () => {
      calls++;
      return Promise.resolve();
    },
  };
  useStorageObjectUrl(objectId, "thumbnail").onError();
  assert.equal(calls, 1);
  harness.result.isError = true;
  assert.equal(useStorageObjectUrl(objectId).url, undefined);
  useStorageObjectUrl(null).onError();
  assert.equal(harness.options.enabled, false);
  assert.equal(calls, 1);
  delete globalThis.window;
  assert.equal(
    useStorageObjectUrl(objectId).url,
    undefined,
    "SSR does not emit a browser-only signed URL",
  );
  assert.equal(harness.options.enabled, false);
});
