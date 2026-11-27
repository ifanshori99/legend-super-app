import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// legend-wasr7.25 (UI audit f1mmf items 16 c/d): the supervisor dialog of
// "Tagih selisih" at 390px. The first focus lands on the first field to fill,
// the keyboard walks the fields in order, the PIN pad is reachable once the
// reason is in (no manual scroll), and axe finds nothing serious.
// Against the FE mock runtime.
// Run: heavy pnpm test:e2e:mock e2e/legend-wasr7-25-resolve-a11y.mock.spec.ts
// Screenshot: LEGEND_WASR7_25_SHOT=docs/review/img (same command).
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({
  baseURL: mockWebUrl ?? "http://localhost:3320",
  viewport: { width: 390, height: 844 },
});
test.setTimeout(120_000);

const CHARGE = "3f0c1a2b-4d5e-4f60-8a71-92b3c4d5e6f7";
const WAIT = { timeout: 60_000 };
const SHOT = process.env.LEGEND_WASR7_25_SHOT;

test("supervisor dialog at 390: first focus, keyboard order, pad in reach, axe", async ({
  page,
  baseURL,
}) => {
  await page
    .context()
    .addCookies([{ name: "legend-mock-role", value: "all", url: baseURL }]);
  await page.goto(`/pos/tagih-selisih/${CHARGE}?demo=selisih-edc-putus`);
  await page.getByText("EDC kartu", { exact: true }).click(WAIT);
  await page.getByRole("button", { name: /Kirim .* ke mesin EDC/ }).click();
  await expect(page.getByText("Hasil EDC belum pasti")).toBeVisible(WAIT);
  await page
    .getByRole("button", { name: "Minta supervisor", exact: true })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const supervisor = dialog.getByRole("combobox").nth(0);
  const statement = dialog.getByRole("combobox").nth(1);

  // (d) The first focus is the first field to fill: the supervisor.
  await expect(supervisor).toBeFocused();

  // Open the full form (card charged, slip): the longest the dialog gets.
  await supervisor.press("Enter");
  await page.getByRole("option", { name: "Supervisor 02" }).press("Enter");
  await expect(supervisor).toBeFocused();
  await supervisor.press("Tab");
  await expect(statement).toBeFocused();
  await statement.press("Enter");
  await page.getByRole("option", { name: "Kartu terdebet, ada slip" }).click();
  await expect(statement).toBeFocused();

  // The keyboard walks the fields in the order they appear.
  const rrn = dialog.getByLabel(/RRN di slip/);
  const approval = dialog.getByLabel(/Kode approval di slip/);
  const slipAmount = dialog.getByLabel(/Nominal di slip/);
  const reason = dialog.getByRole("textbox", { name: /Alasan/ });
  for (const next of [rrn, approval, slipAmount, reason]) {
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
  }
  await rrn.fill("612345678901");
  await approval.fill("A1B2C3");
  await slipAmount.fill("10000");

  // (c) A reason typed, then a tap on the title (which scrolls the sheet back
  // up): the pad comes into view without the cashier scrolling down.
  await reason.fill("Mesin menampilkan disetujui, slip tercetak");
  await dialog.getByRole("heading").first().click();
  await expect(reason).not.toBeFocused();
  const keyOne = dialog.getByRole("button", { name: "Angka 1", exact: true });
  await expect(keyOne).toBeInViewport({ ratio: 1 });

  // Mouse or finger on the pad works from where it landed.
  const dots = dialog.getByTestId("pin-dots").locator("[data-filled]");
  await keyOne.click();
  await expect(dots).toHaveCount(1);
  await dialog.getByRole("button", { name: "Hapus angka terakhir" }).click();
  await expect(dots).toHaveCount(0);

  if (SHOT) {
    await page.screenshot({
      path: join(SHOT, "wasr7-25-resolve-pad-390.png"),
    });
  }

  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  const violations = await page.evaluate(async () => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            context: Element,
            options: object,
          ) => Promise<{
            violations: { id: string; impact: string; nodes: unknown[] }[];
          }>;
        };
      }
    ).axe.run(document.querySelector('[role="dialog"]')!, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
      },
    });
    return result.violations.map((v) => `${v.id} (${v.impact})`);
  });
  expect(violations).toEqual([]);
});
