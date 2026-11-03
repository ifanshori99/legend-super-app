import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot, measureFullPageTarget } from "./screenshots.ts";

// Screenshot helper evidence (bead legend-ivz8). The area shells scroll an
// inner <main id="main-content">, not the window, so Playwright's fullPage
// option alone stopped at the 900px viewport and the promo editor evidence was
// blank below the fold. captureScreenshot now expands the viewport to the
// scroll container's height, captures, and restores the viewport.
//
// How to run: `LEGEND_MOCK_PORT=3295 pnpm test:e2e:mock e2e/legend-ivz8.mock.spec.ts`
// starts a VITE_API_MOCK=true server and names it in LEGEND_MOCK_WEB_URL. The
// PNGs this spec checks land in test-results/screenshots/legend-ivz8/ (the
// promo evidence under docs/ is refreshed through e2e/legend-oadp.mock.spec.ts).
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };
const VIEWPORT_HEIGHT = 900;

/** Width and height from the PNG IHDR chunk; no image decoder needed. */
async function pngDimensions(path: string) {
  const file = await readFile(path);
  expect(file.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(file.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
  };
}

async function openTallEditor(page: Page, width: number) {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await page.goto(`${MOCK_URL}/kelola/promo/baru?mock=normal`, NAV);
  await expect(
    page.getByRole("button", { name: "Simpan promo" }),
  ).toBeVisible();
}

for (const width of [390, 1440]) {
  test(`legend-ivz8: full-page capture reveals the whole promo editor at ${width}px`, async ({
    page,
  }) => {
    await openTallEditor(page, width);

    const target = await measureFullPageTarget(page);
    // Guard the premise: if the editor ever fits the viewport this test would
    // no longer exercise the inner-scroll expansion.
    if (target === null) throw new Error("promo editor is not scroll-clipped");
    expect(target.scrollHeight).toBeGreaterThan(VIEWPORT_HEIGHT);
    expect(target.viewportHeight).toBeGreaterThan(VIEWPORT_HEIGHT);

    const path = await captureScreenshot(
      page,
      `legend-ivz8/promo-editor-${width}-light.png`,
      { scrollContainer: "#main-content" },
    );

    // Restored before returning, so the next assertions or capture see the
    // viewport the spec configured.
    expect(page.viewportSize()).toEqual({
      width,
      height: VIEWPORT_HEIGHT,
    });

    const png = await pngDimensions(path);
    expect(png.width).toBe(width);
    // The image is tall enough to include the shell header plus the whole
    // scroll container; a window-only capture would stop at ~900px.
    expect(png.height).toBeGreaterThanOrEqual(
      target.offsetTop + target.scrollHeight,
    );
    expect(png.height).toBeGreaterThanOrEqual(target.viewportHeight);
    expect(png.height).toBeLessThanOrEqual(target.viewportHeight + 64);
  });
}

test("legend-ivz8: a failed capture still restores the viewport", async ({
  page,
}) => {
  await openTallEditor(page, 390);

  const original = page.screenshot.bind(page);
  let heightDuringCapture = 0;
  page.screenshot = (() => {
    heightDuringCapture = page.viewportSize()?.height ?? 0;
    return Promise.reject(new Error("capture failed"));
  }) as Page["screenshot"];

  try {
    await expect(
      captureScreenshot(page, "legend-ivz8/failing-capture.png"),
    ).rejects.toThrow("capture failed");
  } finally {
    page.screenshot = original;
  }

  // The helper had already expanded the viewport when the capture threw...
  expect(heightDuringCapture).toBeGreaterThan(VIEWPORT_HEIGHT);
  // ...and still restored it through its finally block.
  expect(page.viewportSize()).toEqual({ width: 390, height: VIEWPORT_HEIGHT });
});
