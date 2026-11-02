// Screenshot evidence helper (bead legend-nt8q).
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
// tests/e2e-screenshot-paths.test.mjs fails when an e2e file writes a docs/
// path without going through this module.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";

export const CAPTURE_SCREENSHOTS_ENV = "LEGEND_CAPTURE_SCREENSHOTS";
export const DOCS_SCREENSHOT_ROOT = "docs/design/screenshots";
export const TEST_RESULTS_SCREENSHOT_ROOT = "test-results/screenshots";

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
}

/** Captures the page and returns the path it wrote. */
export async function captureScreenshot(
  page: Page,
  relativePath: string,
  options: CaptureScreenshotOptions = {},
): Promise<string> {
  const path = screenshotPath(relativePath);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: options.fullPage ?? true });
  return path;
}
