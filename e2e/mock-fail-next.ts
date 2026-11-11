// Fault injection for mock specs (window.__legendMock.failNext, see
// apps/web/src/lib/mock/control.ts). `failNext` is a one-shot: the next call
// of that endpoint fails, later ones succeed, so a "Coba lagi" button can be
// proven to recover. Use a 4xx status for a query: the app retries 5xx twice
// (router.tsx), so a one-shot 5xx would heal silently before the error shows.
import type { Page } from "@playwright/test";

export type MockFailure = { status: number; code: string; message?: string };

/**
 * Queues the failure BEFORE the app boots: the control object is installed by
 * assignment to `window.__legendMock`, so a setter caught here runs
 * `failNext` at the very moment it exists, ahead of every query. No timers.
 */
export async function failFirstCall(
  page: Page,
  endpointId: string,
  failure: MockFailure,
) {
  await page.addInitScript(
    ({ endpointId, failure }) => {
      let control: unknown;
      Object.defineProperty(window, "__legendMock", {
        configurable: true,
        get: () => control,
        set: (value: { failNext: (id: string, f: MockFailure) => void }) => {
          control = value;
          value.failNext(endpointId, failure);
        },
      });
    },
    { endpointId, failure },
  );
}

/** Queues the failure on an already loaded page (e.g. before a click). */
export async function failNextCall(
  page: Page,
  endpointId: string,
  failure: MockFailure,
) {
  await page.evaluate(
    ({ endpointId, failure }) =>
      (
        window as unknown as {
          __legendMock: {
            failNext: (id: string, f: MockFailure) => void;
          };
        }
      ).__legendMock.failNext(endpointId, failure),
    { endpointId, failure },
  );
}
