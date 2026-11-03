// Evidence captured at the width its file name promises (squad-platformfe
// review). Several specs name a capture "...-390-..." or "...-1440-..." but
// take it in the default 1280x720 viewport. This wrapper resizes to the named
// width first, waits two frames for layout, then hands over to the shared
// helper in ./screenshots.ts (which owns the docs/ path).
import type { Page } from "@playwright/test";
import { captureScreenshot as captureToEvidence } from "./screenshots.ts";

const NAMED_WIDTH = /-(390|1440)(?:-|\.png$)/;
const HEIGHT_FOR: Record<number, number> = { 390: 844, 1440: 900 };

export async function captureScreenshot(
  page: Page,
  relativePath: string,
): Promise<void> {
  const match = NAMED_WIDTH.exec(relativePath);
  if (match) {
    const width = Number(match[1]);
    if (page.viewportSize()?.width !== width) {
      await page.setViewportSize({ width, height: HEIGHT_FOR[width] ?? 900 });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    }
  }
  await captureToEvidence(page, relativePath);
}
