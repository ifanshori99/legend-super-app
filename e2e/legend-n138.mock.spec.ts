import { expect, test, type Page } from "@playwright/test";

// legend-n138: FormField must name a Radix Select trigger. A Select root
// renders no DOM node, so the id/aria props FormField clones onto its child
// never reach the trigger; the label's htmlFor pointed at nothing and the
// trigger had no accessible name. FormField now carries id/describedby/
// invalid through context and SelectTrigger consumes it.
//
// Runs against the mock web server (no API, no database):
//   pnpm test:e2e:mock e2e/legend-n138.mock.spec.ts

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL, navigationTimeout: 90_000 });

/** The first hit on a cold Vite dev server paints before React hydrates. */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (target) => {
      const node = document.querySelector(target);
      return (
        node !== null &&
        Object.keys(node).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    selector,
    { timeout: 60_000 },
  );
}

test("legend-n138: the journal filters' Select triggers take their label through FormField", async ({
  page,
}) => {
  // This route is not in mock-global-setup's warm list: a cold Vite compile
  // can take 20-35 s on the first hit.
  test.slow();
  await page.goto("/kelola/akuntansi/jurnal");
  await waitForHydration(page, '[data-slot="select-trigger"]');

  // No explicit aria-label on these two: the name can only come from the
  // FormField label ("Sumber"/"Akun" plus the "(opsional)" suffix).
  const source = page.getByRole("combobox", { name: "Sumber" });
  const account = page.getByRole("combobox", { name: "Akun" });
  await expect(source).toBeVisible();
  await expect(account).toBeVisible();
  await expect(source).toHaveAccessibleName(/^Sumber/);
  await expect(account).toHaveAccessibleName(/^Akun/);

  // The label points at the trigger and the trigger points back at the label,
  // so the association survives any name computation.
  const triggerId = await source.getAttribute("id");
  const labelId = await source.getAttribute("aria-labelledby");
  expect(triggerId).toBeTruthy();
  expect(labelId).toBeTruthy();
  await expect(page.locator(`label[for="${triggerId}"]`)).toHaveText(/Sumber/);
  await expect(page.locator(`[id="${labelId}"]`)).toHaveText(/Sumber/);
});

test("legend-n138: an invalid FormField Select exposes aria-invalid and its error description", async ({
  page,
}) => {
  // Same cold-compile budget as the journal route above.
  test.slow();
  await page.goto("/kelola/pembayaran");
  await waitForHydration(page, '[role="tablist"]');

  await page.getByRole("tab", { name: "Refund", exact: true }).click();
  await page.getByRole("button", { name: "Buat refund" }).first().click();

  const payment = page.getByRole("combobox", { name: "Pembayaran lunas" });
  await expect(payment).toBeVisible();
  await expect(payment).not.toHaveAttribute("aria-invalid", "true");

  // The mock fixtures offer refundable payments; submitting without picking
  // one is the error path this FormField owns.
  await page.getByRole("button", { name: "Ajukan refund" }).click();
  await expect(
    page.getByText("Pilih pembayaran yang akan direfund."),
  ).toBeVisible();
  await expect(payment).toHaveAttribute("aria-invalid", "true");

  const describedBy = await payment.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(
    page.locator(`[id="${describedBy?.split(" ").at(-1)}"]`),
  ).toHaveText(/Pilih pembayaran yang akan direfund/);
});
