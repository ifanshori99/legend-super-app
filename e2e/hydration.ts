import type { Page } from "@playwright/test";

/**
 * Waits until the page is interactive (legend-doykg). Server HTML paints and
 * accepts typing before React attaches handlers; a `fill()` or click in that
 * window reaches the DOM but not React state, and the form then submits an
 * empty value. Two signals, both required:
 *  1. `<html data-hydrated="true">`, written by the root route's useEffect
 *     after hydration commits.
 *  2. Every control in the main area carries React props (`__reactProps$*`),
 *     which covers boundaries that hydrate after the root.
 *
 * Standalone on purpose: mock specs cannot import ./helpers.ts, which needs
 * the full `pnpm test:e2e` environment.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#main-content") ?? document.body;
      const controls = root.querySelectorAll(
        "input, button, textarea, select, a[href]",
      );
      return Array.from(controls).every((el) =>
        Object.keys(el).some((key) => key.startsWith("__reactProps$")),
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}
