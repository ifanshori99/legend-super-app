import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";
import { waitForHydration } from "./hydration.ts";

// WS-14 FE — equipment registry, breakdown tickets (OPS-04) and shift handover
// confirmation (OPS-05). Mock mode only: the screens read
// @starter/shared/operations fixtures through features/operations-equipment/mock.ts.
//
// Run: pnpm test:e2e:mock e2e/legend-cz9g.mock.spec.ts
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });

test.describe.configure({ timeout: 60_000 });

/** The operations fixtures live on 1 November 2026 (Asia/Jakarta). Pinning the
 * browser clock keeps "servis jatuh tempo" and handover ordering deterministic.
 * 23:30 WIB is after the fixture handover's 15:05Z submission. */
const FIXTURE_NOW = new Date("2026-11-01T23:30:00.000+07:00");
const ESPRESSO_EQUIPMENT_ID = "00000000-0000-4000-8000-000000008303";

async function openRegistry(page: Page) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/operasional/peralatan?mock=normal");
  await expect(
    page.getByRole("heading", { name: "Peralatan & perawatan", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("9 baris")).toBeVisible({ timeout: 30_000 });
  await waitForHydration(page);
}

async function openHandover(page: Page) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/operasional/serah-terima?mock=normal");
  await expect(
    page.getByRole("heading", { name: "Serah terima shift", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-slot="handover-card"]').first()).toBeVisible(
    { timeout: 30_000 },
  );
  await waitForHydration(page);
}

test("OPS-04 registry shows down equipment, due service and its disabled menu items", async ({
  page,
}) => {
  await openRegistry(page);

  const strip = page.locator('[data-slot="action-strip"]');
  await expect(strip).toContainText("Peralatan rusak");
  await expect(strip).toContainText("Blender Bar Nonkopi");
  await expect(strip).toContainText("Servis jatuh tempo");

  const blender = page
    .getByRole("row")
    .filter({ hasText: "Blender Bar Nonkopi" });
  await expect(blender).toContainText("Rusak");

  const disabled = page.locator('[data-slot="disabled-menu-card"]');
  await expect(disabled).toContainText("Jus Alpukat");
  await expect(disabled).toContainText("Jus Mangga");
  await expect(disabled).toContainText("Es Cokelat");
});

test("OPS-04 breakdown ticket marks the equipment broken and disables its mapped menu items", async ({
  page,
}) => {
  await openRegistry(page);
  await page.getByRole("button", { name: "Laporkan kerusakan" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Laporkan kerusakan" }),
  ).toBeVisible();

  await dialog
    .getByRole("combobox", { name: "Peralatan", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Mesin Espresso La Marzocco Linea" })
    .click();
  await dialog.getByRole("combobox", { name: "Urgensi", exact: true }).click();
  await page.getByRole("option", { name: "Kritis" }).click();
  await dialog
    .getByLabel("Deskripsi kerusakan")
    .fill("Pompa tidak mengalir dan mesin berhenti saat ekstraksi.");
  await dialog.getByLabel("Foto kerusakan").setInputFiles(
    // A real image: the browser re-encodes it before upload.
    "apps/web/demo/sample/menu/croissant-mentega.jpg",
  );
  // The photo uploads before the ticket can be sent (mock storage).
  await expect(dialog.getByText("Foto terunggah.")).toBeVisible();

  // OPS-04 preview: the equipment's mapped menu items before submitting.
  const preview = dialog.locator('[data-slot="affected-menu-preview"]');
  await expect(preview).toContainText("Espresso");
  await expect(preview).toContainText("Cappuccino");

  await dialog.getByRole("combobox", { name: /Vendor servis/ }).click();
  await page.getByRole("option", { name: "CV Kopi Priangan" }).click();
  await dialog.getByLabel("Perkiraan biaya (Rp)").fill("450000");
  await dialog.getByRole("button", { name: "Kirim tiket" }).click();

  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Tiket kerusakan dikirim.", { exact: true }),
  ).toBeVisible();

  const espresso = page.getByRole("row").filter({
    hasText: "Mesin Espresso La Marzocco Linea",
  });
  await expect(espresso).toContainText("Rusak");

  const disabled = page.locator('[data-slot="disabled-menu-card"]');
  await expect(disabled).toContainText("Cafe Latte");
  await expect(disabled).toContainText("Kopi Susu Aren");
  await expect(disabled).toContainText("Jus Alpukat");
});

test("OPS-04 equipment detail shows status, service history and cost history", async ({
  page,
}) => {
  await openRegistry(page);
  await page
    .getByRole("link", { name: "Blender Bar Nonkopi", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Blender Bar Nonkopi", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-slot="equipment-header"]')).toContainText(
    "Rusak",
  );
  await expect(page.locator('[data-slot="equipment-broken"]')).toContainText(
    "Jus Alpukat",
  );
  await expect(page.locator('[data-slot="maintenance-tickets"]')).toContainText(
    "Pisau blender berhenti berputar saat menggiling es.",
  );
  await expect(page.locator('[data-slot="service-schedules"]')).toContainText(
    "Belum ada jadwal servis.",
  );

  // The espresso machine has no resolved ticket with a cost (the oven carries
  // the fixture's cost), so its cost history is honestly empty.
  await page.goto(
    `/operasional/peralatan/${ESPRESSO_EQUIPMENT_ID}?mock=normal`,
  );
  await expect(
    page.getByRole("heading", {
      name: "Mesin Espresso La Marzocco Linea",
      level: 1,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await waitForHydration(page);
  await expect(page.locator('[data-slot="cost-history"]')).toContainText(
    "Belum ada biaya servis tercatat.",
  );
});

test("OPS-04 breakdown ticket moves reported -> in progress -> resolved with a rupiah cost", async ({
  page,
}) => {
  await openRegistry(page);
  await page
    .getByRole("link", { name: "Blender Bar Nonkopi", exact: true })
    .click();
  const ticket = page
    .locator('[data-slot="maintenance-ticket"]')
    .filter({ hasText: "Pisau blender berhenti berputar" });
  await expect(ticket).toContainText("Dilaporkan");
  // The contract machine offers only start/cancel on a reported ticket.
  await expect(
    ticket.getByRole("button", { name: "Selesaikan tiket" }),
  ).toHaveCount(0);

  await ticket.getByRole("button", { name: "Mulai perawatan" }).click();
  await expect(ticket).toContainText("Dikerjakan");

  await ticket.getByRole("button", { name: "Selesaikan tiket" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Biaya servis (Rp)").fill("350000");
  await dialog.getByRole("button", { name: "Tandai selesai" }).click();
  await expect(dialog).toBeHidden();
  await expect(ticket).toContainText("Selesai");
  await expect(ticket.getByRole("button")).toHaveCount(0);
  const costs = page.locator('[data-slot="cost-history"]');
  await expect(costs).toContainText("350.000");
  await expect(costs).not.toContainText("Belum ada biaya servis tercatat.");
});

test("OPS-05 handover cannot close before the receiving shift confirms", async ({
  page,
}) => {
  await openHandover(page);
  await page.getByRole("button", { name: "Serah terima baru" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Kas")
    .fill("Kas shift pengujian sesuai; selisih Rp0.");
  await dialog.getByLabel("Stok kritis").fill("Susu UHT tersisa 6 liter.");
  await dialog.getByRole("button", { name: "Kirim serah terima" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Serah terima dikirim.", { exact: true }),
  ).toBeVisible();

  const card = page
    .locator('[data-slot="handover-card"]')
    .filter({ hasText: "Kas shift pengujian sesuai" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Menunggu konfirmasi");

  // OPS-05: the close action is blocked until the receiving shift confirms.
  const blockedClose = card.getByRole("button", {
    name: "Tutup serah terima",
  });
  await expect(blockedClose).toBeDisabled();
  await expect(card).toContainText(
    "Shift penerima harus mengonfirmasi sebelum serah terima dapat ditutup.",
  );

  await card.getByRole("button", { name: "Konfirmasi penerimaan" }).click();
  await expect(card).toContainText("Dikonfirmasi");
  const close = card.getByRole("button", { name: "Tutup serah terima" });
  await expect(close).toBeEnabled();
  await close.click();

  const closeDialog = page.getByRole("dialog");
  await expect(
    closeDialog.getByRole("heading", { name: "Tutup serah terima?" }),
  ).toBeVisible();
  await closeDialog.getByRole("button", { name: "Tutup serah terima" }).click();
  await expect(card).toContainText("Ditutup");
  await expect(
    card.getByRole("button", { name: "Tutup serah terima" }),
  ).toHaveCount(0);
});

test("OPS-04 empty registry and OPS-05 empty handover show honest empty states", async ({
  page,
}) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/operasional/peralatan?mock=empty");
  await expect(
    page.getByRole("heading", { name: "Peralatan & perawatan", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Belum ada peralatan")).toBeVisible({
    timeout: 30_000,
  });
  await waitForHydration(page);

  await page.goto("/operasional/serah-terima?mock=empty");
  await expect(
    page.getByRole("heading", { name: "Serah terima shift", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Belum ada serah terima")).toBeVisible({
    timeout: 30_000,
  });
  await waitForHydration(page);
});

test("OPS-04 and OPS-05 error states offer a retry", async ({ page }) => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/operasional/peralatan?mock=error");
  await expect(
    page.getByRole("heading", { name: "Peralatan & perawatan", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible({
    timeout: 30_000,
  });
  await waitForHydration(page);
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();

  await page.goto("/operasional/serah-terima?mock=error");
  await expect(
    page.getByRole("heading", { name: "Serah terima shift", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible({
    timeout: 30_000,
  });
  await waitForHydration(page);
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`OPS-04 registry visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await openRegistry(page);
      await captureScreenshot(
        page,
        `legend-cz9g/peralatan-${width}-${theme}.png`,
      );
    });

    test(`OPS-04 detail visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await page.clock.setFixedTime(FIXTURE_NOW);
      await page.goto(
        "/operasional/peralatan/00000000-0000-4000-8000-000000008305?mock=normal",
      );
      await expect(
        page.getByRole("heading", { name: "Blender Bar Nonkopi", level: 1 }),
      ).toBeVisible({ timeout: 30_000 });
      await waitForHydration(page);
      await captureScreenshot(
        page,
        `legend-cz9g/peralatan-detail-${width}-${theme}.png`,
      );
    });

    test(`OPS-05 handover visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await openHandover(page);
      await captureScreenshot(
        page,
        `legend-cz9g/serah-terima-${width}-${theme}.png`,
      );
    });
  }
}

test("OPS-04 registry empty and error screenshots", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto("/operasional/peralatan?mock=empty");
  await expect(page.getByText("Belum ada peralatan")).toBeVisible({
    timeout: 30_000,
  });
  await waitForHydration(page);
  await captureScreenshot(page, "legend-cz9g/peralatan-390-empty.png");

  await page.goto("/operasional/peralatan?mock=error");
  await expect(page.getByText("Data tidak dapat dimuat")).toBeVisible({
    timeout: 30_000,
  });
  await waitForHydration(page);
  await captureScreenshot(page, "legend-cz9g/peralatan-390-error.png");
});
