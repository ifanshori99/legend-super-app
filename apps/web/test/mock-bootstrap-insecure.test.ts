// legend-dq4y3 / legend-zrdy: the mock transport eagerly imports every handler.
// A seed in an unrelated feature must not stop payment routing from loading on
// an HTTP LAN origin, where getRandomValues exists but randomUUID does not.
import { getPaymentRouting } from "@starter/shared/payment/admin";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("the full mock transport boots and serves routing without crypto.randomUUID", async () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(
    globalThis.crypto,
  );
  vi.stubGlobal("crypto", { getRandomValues, randomUUID: undefined });
  // Vite normally injects this compile-time flag. The unit-test runner does
  // not load vite.config.ts; false keeps the real logger on its JSON path
  // without starting the development-only pino-pretty worker.
  vi.stubGlobal("__WEB_DEV_SERVER__", false);
  vi.stubEnv("VITE_API_MOCK", "true");
  vi.stubEnv("VITE_API_MOCK_LATENCY_MS", "0");
  vi.resetModules();

  expect(typeof crypto.randomUUID).toBe("undefined");
  expect(typeof crypto.getRandomValues).toBe("function");

  // Import the actual eager graph after removing randomUUID, rather than
  // importing a single feature handler or replacing handlers with doubles.
  const { mockFetch } = await import("@/lib/mock/transport");
  const { resetMocks } = await import("@/lib/mock/runtime");

  const readRouting = async () =>
    getPaymentRouting.response.parse(
      await mockFetch(getPaymentRouting.path, {
        method: getPaymentRouting.method,
      }),
    );

  const first = await readRouting();
  expect(first.data.scope).toBe("tenant");
  expect(first.data.routes.some((route) => route.method === "qris")).toBe(true);
  expect(first.data.outlets.length).toBeGreaterThan(0);

  // The browser's reset action runs every seed again under the same crypto
  // capabilities; it must keep the transport usable too.
  resetMocks();
  expect(await readRouting()).toEqual(first);
  // The eager graph imports every mock handler; a cold transform under a
  // loaded full run took over the 5 s default (batch104 full run 4).
}, 60_000);
