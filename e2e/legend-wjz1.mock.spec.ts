// legend-wjz1: prep label print polish (PRD §3 food safety "Label prep";
// mockup design/mockups/pos/pos-extra-wjz1-label-prep.html): the printed page
// has no trailing blank page, the selected row has a left bar and not only a
// background colour, and the list/preview/empty/error/validation states work.
//
// ASSUMPTION: "no blank page" is checked through the print CSS the browser
// applies under print media (label sheet is one block that never breaks to a
// second page, and the page content is shorter than one A4 page).
// Run: pnpm test:e2e:mock e2e/legend-wjz1.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";

const COLD_START_TIMEOUT_MS = 30_000;
const A4_HEIGHT_PX = 1123; // 297 mm at 96 dpi

async function openLabels(page: Page, query = "") {
  await page.goto(`/operasional/label-prep${query}`);
  await expect(
    page.getByRole("heading", { name: "Label prep" }).first(),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
}

// The row's accessible name is the item's name; the selected row is marked with
// aria-current (not aria-pressed), so rows are found by their list slot.
const rows = (page: Page) => page.locator('[data-slot="prep-label"] button');
const printButton = (page: Page) =>
  page.locator('[data-slot="prep-label-print"]');

test("labels list with the first one selected and previewed", async ({
  page,
}) => {
  await openLabels(page);
  await expect(
    page.getByRole("region", { name: "Label terbaru" }),
  ).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).first()).toHaveAttribute("aria-current", "true");
  await expect(page.getByText("Pratinjau label").first()).toBeVisible();
  await expect(printButton(page)).toBeVisible();
});

test("the selected row carries a left bar, not just a tint", async ({
  page,
}) => {
  await openLabels(page);
  const selected = rows(page).first();
  const width = await selected.evaluate(
    (el) => getComputedStyle(el).borderLeftWidth,
  );
  expect(parseFloat(width)).toBeGreaterThanOrEqual(4);
  if ((await rows(page).count()) > 1) {
    const other = await rows(page)
      .nth(1)
      .evaluate((el) => getComputedStyle(el).borderLeftWidth);
    expect(parseFloat(other)).toBeLessThan(parseFloat(width));
    await rows(page).nth(1).click();
    await expect(rows(page).nth(1)).toHaveAttribute("aria-current", "true");
    await expect(rows(page).first()).not.toHaveAttribute(
      "aria-current",
      "true",
    );
  }
});

test("print media keeps only the label, on one page without a blank tail", async ({
  page,
}) => {
  await openLabels(page);
  await page.emulateMedia({ media: "print" });
  const sheet = page.locator(".label-print-sheet");
  await expect(sheet).toBeVisible();
  // Everything but the label (controls, list, form) is out of the print layout.
  await expect(printButton(page)).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Label terbaru" }),
  ).toBeHidden();
  const style = await sheet.evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      breakAfter: css.breakAfter,
      pageBreakAfter: css.getPropertyValue("page-break-after"),
      breakInside: css.breakInside,
      heightPx: el.getBoundingClientRect().height,
    };
  });
  expect(["avoid", "auto"]).toContain(style.breakAfter);
  expect(style.breakAfter).not.toMatch(/page|always|left|right/);
  expect(style.pageBreakAfter).not.toMatch(/always|left|right/);
  expect(style.breakInside).toBe("avoid");
  expect(style.heightPx).toBeLessThan(A4_HEIGHT_PX);
  const pageHeight = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  expect(pageHeight).toBeLessThanOrEqual(A4_HEIGHT_PX);
});

test("printing records the print and says so", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed += 1;
    };
  });
  await openLabels(page);
  await printButton(page).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __printed: number }).__printed,
      ),
    )
    .toBe(1);
  await expect(page.getByText(/Sudah dicetak/).first()).toBeVisible();
});

test("no labels shows the empty state", async ({ page }) => {
  await page.goto("/operasional/label-prep?mock=empty");
  await expect(page.getByText("Belum ada label prep")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
});

test("a failed load shows an error with 'Coba lagi' that recovers", async ({
  page,
}) => {
  await page.goto("/operasional/label-prep?mock=error");
  await expect(page.getByText("Label prep tidak dapat dimuat")).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await page.evaluate(() =>
    (
      window as unknown as {
        __legendMock: { setScenario: (s: string) => void };
      }
    ).__legendMock.setScenario("normal"),
  );
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(rows(page).first()).toBeVisible();
});

test("saving a label without choosing an item names the problem", async ({
  page,
}) => {
  await openLabels(page);
  await page.getByRole("button", { name: "Buat label", exact: true }).click();
  await expect(page.getByText("Pilih bahan untuk label.")).toBeVisible();
});

test("on a phone the order is list, then preview, then the create form", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLabels(page);
  const top = async (name: string) =>
    (await page.getByRole("region", { name }).boundingBox())!.y;
  const list = await top("Label terbaru");
  const preview = await top("Pratinjau label");
  const form = await top("Buat label prep");
  expect(list).toBeLessThan(preview);
  expect(preview).toBeLessThan(form);
});

test("on a phone the labels stay inside the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLabels(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
