// Real photo and signature upload on the facility screens (beads legend-wf37,
// legend-xxx6; brief 787): cleaning completion, breakdown ticket and checklist
// evidence against the FE mock runtime.
//
// Assumption: in mock mode the storage client serves uploads locally and makes
// no network request, so a 413/503 cannot be produced with page.route(). The
// failure path is driven with a file the browser cannot decode (the same
// client-side rejection users get for a broken photo); it renders the same
// error line and "Coba lagi" retry as an API failure. The HTTP statuses
// themselves (413, 415/422, 503) are covered by the unit mapping tests.
//
// Run: pnpm test:e2e:mock e2e/legend-wf37.mock.spec.ts — mock mode only.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });

// 1269 F0: showers are deferred, so the booth fixture is served as an open
// facility type (features/facility/mock-facilities.ts).
test.beforeEach(({ page }) =>
  page.addInitScript(() =>
    window.localStorage.setItem("legend.mock.boothType", "coworking"),
  ),
);

const COLD_START_TIMEOUT_MS = 30_000;
// A real image: the browser decodes and re-encodes it before upload.
const REAL_PHOTO = "apps/web/demo/sample/menu/croissant-mentega.jpg";
const BROKEN_PHOTO = {
  name: "rusak.jpg",
  mimeType: "image/jpeg",
  buffer: Buffer.from("ini-bukan-gambar"),
};
const CLOSING_RUN_ID = "00000000-0000-4000-8000-000000008202";

function coldStart(page: Page) {
  test.setTimeout(120_000);
  page.setDefaultTimeout(COLD_START_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(60_000);
}

// Evidence for both widths inside the flow that is already running (no extra
// navigation). Lands under legend-wf37/<screen>-<state>-<width>.png. Every
// capture is the viewport (fullPage: false) so it shows exactly what a user
// sees: dialogs as they are, the checklist scrolled to the item card under test.
const SHOT_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

// Toasts ("Mulai tugas" confirmation etc.) sit bottom-right/bottom and cover
// the "Coba lagi" button. Close them before every capture. While a modal dialog
// is open the toast region is aria-hidden and body has pointer-events: none, so
// neither a role query nor a mouse click reaches the close button: select it by
// its aria-label and trigger the click on the element itself.
async function dismissToasts(page: Page) {
  const closeButtons = page.locator('button[aria-label="Tutup notifikasi"]');
  await expect
    .poll(
      async () => {
        const count = await closeButtons.count();
        for (let index = count - 1; index >= 0; index -= 1) {
          await closeButtons
            .nth(index)
            .evaluate((button) => (button as HTMLButtonElement).click())
            .catch(() => undefined);
        }
        return closeButtons.count();
      },
      { message: "all toasts are dismissed before the capture" },
    )
    .toBe(0);
}

// Brings the card to the top of the scroll area (app shells scroll an inner
// <main>, not the window) so its photo field and signature are in the viewport.
// A card shorter than the viewport is centered instead.
async function scrollCardIntoView(card: Locator) {
  await card.evaluate((element) => {
    const fits = element.getBoundingClientRect().height < window.innerHeight;
    element.scrollIntoView({
      block: fits ? "center" : "start",
      inline: "nearest",
      behavior: "instant",
    });
  });
  await expect(card).toBeInViewport();
}

async function shootBothWidths(
  page: Page,
  screen: "cleaning" | "ticket" | "checklist",
  state: "uploaded" | "failed",
  anchor: Locator,
  // The element that must be on screen in the capture (checklist item card).
  card?: Locator,
) {
  for (const viewport of SHOT_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect(anchor).toBeVisible();
    if (card) await scrollCardIntoView(card);
    await dismissToasts(page);
    // Two frames so the toast exit animation and the scroll are painted out.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await captureScreenshot(
      page,
      `legend-wf37/${screen}-${state}-${viewport.width}.png`,
      { fullPage: false },
    );
  }
}

async function openCleaningDialog(page: Page) {
  await page.goto("/fasilitas/kebersihan?mock=normal");
  await expect(
    page.getByRole("heading", { level: 1, name: "Kebersihan bilik" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await page
    .locator('[data-slot="cleaning-task"][data-unit-code="W1"]')
    .getByRole("button", { name: "Buka checklist" })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Mulai tugas" }).click();
  for (const label of [
    "Lantai bersih dan kering",
    "Saluran air lancar",
    "Perlengkapan lengkap",
    "Sampah dibuang",
  ]) {
    await dialog.getByRole("checkbox", { name: label }).click();
  }
  return dialog;
}

test("FAC-06 cleaning photo uploads, then the task completes", async ({
  page,
}) => {
  coldStart(page);
  const dialog = await openCleaningDialog(page);
  await dialog.getByLabel("Foto hasil pembersihan").setInputFiles(REAL_PHOTO);
  await expect(dialog.getByText("Foto terunggah.")).toBeVisible();
  await shootBothWidths(
    page,
    "cleaning",
    "uploaded",
    dialog.getByText("Foto terunggah."),
  );
  await dialog.getByRole("button", { name: "Selesaikan pembersihan" }).click();
  await expect(
    page
      .getByText("Bilik W1 selesai dibersihkan dan kembali bisa dibooking.")
      .first(),
  ).toBeVisible();
});

test("FAC-06 cleaning photo failure shows the error, blocks completing and recovers with another photo", async ({
  page,
}) => {
  coldStart(page);
  const dialog = await openCleaningDialog(page);
  await dialog.getByLabel("Foto hasil pembersihan").setInputFiles(BROKEN_PHOTO);
  await expect(dialog.getByRole("alert")).toContainText("Foto");
  await expect(dialog.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Selesaikan pembersihan" }),
  ).toBeDisabled();
  await shootBothWidths(
    page,
    "cleaning",
    "failed",
    dialog.getByRole("button", { name: "Coba lagi" }),
  );

  await dialog.getByLabel("Foto hasil pembersihan").setInputFiles(REAL_PHOTO);
  await expect(dialog.getByText("Foto terunggah.")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Selesaikan pembersihan" }),
  ).toBeEnabled();
});

async function openTicketDialog(page: Page) {
  await page.goto("/operasional/peralatan?mock=normal");
  await expect(
    page.getByRole("heading", { name: "Peralatan & perawatan", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await page.getByRole("button", { name: "Laporkan kerusakan" }).click();
  const dialog = page.getByRole("dialog");
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
  return dialog;
}

test("OPS-04 breakdown ticket photo failure shows the error and retry, and nothing is sent", async ({
  page,
}) => {
  coldStart(page);
  const dialog = await openTicketDialog(page);
  await dialog.getByLabel("Foto kerusakan").setInputFiles(BROKEN_PHOTO);
  await expect(dialog.getByRole("alert").first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await shootBothWidths(
    page,
    "ticket",
    "failed",
    dialog.getByRole("button", { name: "Coba lagi" }),
  );

  await dialog.getByRole("button", { name: "Kirim tiket" }).click();
  await expect(dialog).toBeVisible();
  await expect(
    page.getByText("Tiket kerusakan dikirim.", { exact: true }),
  ).toHaveCount(0);

  await dialog.getByLabel("Foto kerusakan").setInputFiles(REAL_PHOTO);
  await expect(dialog.getByText("Foto terunggah.")).toBeVisible();
  await shootBothWidths(
    page,
    "ticket",
    "uploaded",
    dialog.getByText("Foto terunggah."),
  );
  await dialog.getByRole("button", { name: "Kirim tiket" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Tiket kerusakan dikirim.", { exact: true }),
  ).toBeVisible();
});

test("OPS-01 checklist photo failure shows the error and retry; a valid photo then completes the item", async ({
  page,
}) => {
  coldStart(page);
  await page.goto(`/operasional/checklist/${CLOSING_RUN_ID}?mock=normal`);
  await expect(
    page.getByRole("heading", { name: "Checklist Tutup Toko", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await page.getByRole("button", { name: "Mulai checklist" }).click();

  const photoItem = page
    .locator('[data-slot="checklist-item"]')
    .filter({ hasText: "Cek semua pintu dan jendela terkunci" });
  await photoItem.locator('input[type="file"]').setInputFiles(BROKEN_PHOTO);
  await expect(photoItem.getByRole("alert")).toBeVisible();
  await expect(
    photoItem.getByRole("button", { name: "Coba lagi" }),
  ).toBeVisible();
  await shootBothWidths(
    page,
    "checklist",
    "failed",
    photoItem.getByRole("button", { name: "Coba lagi" }),
    photoItem,
  );

  await photoItem.locator('input[type="file"]').setInputFiles(REAL_PHOTO);
  await expect(photoItem.getByText("Foto terunggah.")).toBeVisible();
  await shootBothWidths(
    page,
    "checklist",
    "uploaded",
    photoItem.getByText("Foto terunggah."),
    photoItem,
  );
  await photoItem.getByRole("button", { name: "Tandai selesai" }).click();
  await expect(photoItem.getByText("Selesai", { exact: true })).toBeVisible();
});

test("OPS-01 a signature needs ink or a typed name; a typed name alone is rendered and uploaded", async ({
  page,
}) => {
  coldStart(page);
  await page.goto(`/operasional/checklist/${CLOSING_RUN_ID}?mock=normal`);
  await expect(
    page.getByRole("heading", { name: "Checklist Tutup Toko", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await page.getByRole("button", { name: "Mulai checklist" }).click();

  const cashItem = page
    .locator('[data-slot="checklist-item"]')
    .filter({ hasText: "Rekap kas akhir shift" });
  await cashItem.getByLabel("Angka", { exact: true }).fill("500000");
  // Neither ink nor a name: the required evidence is missing.
  await cashItem.getByRole("button", { name: "Tandai selesai" }).click();
  await expect(
    cashItem.getByText("Lengkapi bukti wajib sebelum menyimpan."),
  ).toBeVisible();
  await expect(cashItem.getByText("Selesai", { exact: true })).toHaveCount(0);

  // Keyboard alternative: the typed name is drawn onto the pad and uploaded.
  await cashItem.getByLabel("Nama penanda tangan").fill("Yusuf Hidayat");
  await cashItem.getByRole("button", { name: "Tandai selesai" }).click();
  await expect(cashItem.getByText("Selesai", { exact: true })).toBeVisible();
});
