// Screenshot evidence helper (bead legend-nt8q, tall pages legend-ivz8).
//
// UI beads keep their evidence under docs/design/screenshots/<bead>/, which is
// tracked by git. A plain `page.screenshot({ path: "docs/..." })` rewrites those
// files on every mock e2e run, dirtying every worktree and main even when the
// screen did not change. Specs call `captureScreenshot` instead:
//
//   await captureScreenshot(page, "legend-baa/masuk-hubungkan-390-light.png");
//
// Default: the file lands under test-results/screenshots/<bead>/ (gitignored),
// so a run still leaves inspectable evidence. Set LEGEND_CAPTURE_SCREENSHOTS=1
// to refresh the tracked evidence under docs/design/screenshots/:
//
//   LEGEND_CAPTURE_SCREENSHOTS=1 pnpm test:e2e:mock e2e/legend-8tv6.mock.spec.ts
//
// App shells scroll an inner <main id="main-content">, not the window, so
// Playwright's fullPage option alone only extends the 900px window and leaves
// everything below the first viewport blank (bead legend-ivz8). For a full-page
// capture the helper measures that scroll container, temporarily grows the
// viewport to its full scrollHeight plus the shell header, captures, and then
// restores the viewport even when the capture throws.
//
// tests/e2e-screenshot-paths.test.mjs fails when an e2e file writes a docs/
// path without going through this module.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";

export const CAPTURE_SCREENSHOTS_ENV = "LEGEND_CAPTURE_SCREENSHOTS";
export const DOCS_SCREENSHOT_ROOT = "docs/design/screenshots";
export const TEST_RESULTS_SCREENSHOT_ROOT = "test-results/screenshots";

/** The scroll area every area shell stamps on its <main>. */
export const DEFAULT_SCROLL_CONTAINER = "#main-content";

/**
 * Chromium fails a screenshot taller than its 16384px texture limit. Stop just
 * below it; a page that tall is beyond what an evidence image can show anyway.
 */
export const MAX_CAPTURE_HEIGHT = 16000;

/** Only an explicit "1" opts in; typo'd values keep the run on test-results. */
export function captureScreenshotsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[CAPTURE_SCREENSHOTS_ENV] === "1";
}

/**
 * Where `relativePath` lands, relative to the repo root (Playwright's cwd).
 * `relativePath` is the part below the root, e.g. "legend-baa/state-390.png".
 */
export function screenshotPath(
  relativePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = captureScreenshotsEnabled(env)
    ? DOCS_SCREENSHOT_ROOT
    : TEST_RESULTS_SCREENSHOT_ROOT;
  return join(root, relativePath);
}

export interface CaptureScreenshotOptions {
  /** Page screenshots default to full page; pass false for the viewport. */
  fullPage?: boolean;
  /**
   * CSS selector for the element that scrolls the page content. Defaults to
   * the shell's `#main-content`. Pass another selector when a screen scrolls
   * somewhere else, e.g. a panel with its own `overflow-y-auto`.
   */
  scrollContainer?: string;
}

/** What a full-page capture has to reveal, in CSS pixels. */
export interface FullPageTarget {
  /** Selector that produced the measurement. */
  scrollContainer: string;
  /** Content height of the scroll container. */
  scrollHeight: number;
  /** Space above the container (shell header) that the viewport must keep. */
  offsetTop: number;
  /** Viewport height the capture needs; capped at MAX_CAPTURE_HEIGHT. */
  viewportHeight: number;
}

/**
 * Measures the inner scroll area of a full-page capture. Returns null when the
 * selector matches nothing or the container already grows with its content: in
 * both cases Playwright's own fullPage capture is correct and no viewport
 * expansion is needed.
 *
 * Exported so evidence specs can compare the captured PNG with the height the
 * helper targeted (bead legend-ivz8).
 */
export async function measureFullPageTarget(
  page: Page,
  scrollContainer: string = DEFAULT_SCROLL_CONTAINER,
): Promise<FullPageTarget | null> {
  return page.evaluate(
    ({ selector, maxHeight }) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      const offsetTop = Math.max(
        0,
        Math.ceil(element.getBoundingClientRect().top + window.scrollY),
      );
      const scrollHeight = element.scrollHeight;
      // Not clipped: the container is as tall as its content (a plain <main>
      // on a window-scrolled page), so fullPage already sees everything.
      if (scrollHeight <= element.clientHeight + 1) return null;
      return {
        scrollContainer: selector,
        scrollHeight,
        offsetTop,
        viewportHeight: Math.min(
          maxHeight,
          Math.ceil(offsetTop + scrollHeight),
        ),
      };
    },
    { selector: scrollContainer, maxHeight: MAX_CAPTURE_HEIGHT },
  );
}

/**
 * One paint barrier: images and fonts may still be in flight on a fresh mock
 * page, so wait for the network to settle (bounded: a persistent connection
 * must not hang a capture) and then for two animation frames.
 */
async function waitForPaint(page: Page): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: 5000 })
    .catch(() => undefined);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

/**
 * Captures the page and returns the path it wrote. With `fullPage` (the
 * default) a clipped inner scroll container is revealed first, then the
 * original viewport is restored.
 */
export async function captureScreenshot(
  page: Page,
  relativePath: string,
  options: CaptureScreenshotOptions = {},
): Promise<string> {
  const path = screenshotPath(relativePath);
  await mkdir(dirname(path), { recursive: true });

  const fullPage = options.fullPage ?? true;
  const viewport = page.viewportSize();
  if (!fullPage || viewport === null) {
    await page.screenshot({ path, fullPage });
    return path;
  }

  const scrollContainer = options.scrollContainer ?? DEFAULT_SCROLL_CONTAINER;
  let expanded = false;
  try {
    await waitForPaint(page);
    const target = await measureFullPageTarget(page, scrollContainer);
    if (target !== null && target.viewportHeight > viewport.height) {
      await page.setViewportSize({
        width: viewport.width,
        height: target.viewportHeight,
      });
      expanded = true;
      // Let the shell re-layout at the taller viewport before capturing.
      await waitForPaint(page);
    }
    await page.screenshot({ path, fullPage: true });
    return path;
  } finally {
    if (expanded && !page.isClosed()) {
      await page.setViewportSize(viewport);
    }
  }
}
