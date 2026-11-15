import { expect, test, type Page } from "@playwright/test";
import { CHECKLIST_ANSWER_QUEUE_KEY } from "../apps/web/src/features/operations-checklist/queue.ts";
import { captureScreenshot } from "./screenshots.ts";

// WS-14 operational checklists against the mock runtime: the board's OPS-01
// escalation badge, phone execution with photo/number/signature evidence, and
// the template builder. Reviewable before the operations API exists.
//
// Run: pnpm test:e2e:mock e2e/legend-td4f.mock.spec.ts — mock mode only.
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });

/** First navigation pays Vite's cold compile of the new route. */
const COLD_START_TIMEOUT_MS = 30_000;

// Fixture ids (cafeLegendOperationsFixtures.checklistRuns).
const CLOSING_RUN_ID = "00000000-0000-4000-8000-000000008202";
const CLEANING_RUN_ID = "00000000-0000-4000-8000-000000008203";
// The opening template (cafeLegendOperationsFixtures.checklistTemplates).
const OPENING_TEMPLATE_ID = "00000000-0000-4000-8000-000000008101";

// The photo is decoded and re-encoded in the browser before upload, so the
// fixture must be a real image (arbitrary bytes are rejected as unreadable).
const REAL_PHOTO = "apps/web/demo/sample/menu/croissant-mentega.jpg";

const BOARD_HEADING = "Checklist operasional";

async function queuedAnswerCount(page: Page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return 0;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("entries" in parsed) ||
      !Array.isArray(parsed.entries)
    )
      throw new Error("Stored checklist answer queue has an invalid format.");
    return parsed.entries.length;
  }, CHECKLIST_ANSWER_QUEUE_KEY);
}

test("OPS-01 board shows an overdue checklist with the supervisor escalation badge", async ({
  page,
}) => {
  await page.goto("/operasional/checklist?mock=normal");
  await expect(
    page.getByRole("heading", { name: BOARD_HEADING, level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

  // The "Perlu tindakan" strip comes first (DESIGN.md §5): solid urgent pill,
  // then the counts. The seeded cleaning run is in progress past its deadline
  // by more than the 15-minute grace, so it shows as reported.
  await expect(page.getByText("Perlu tindakan", { exact: true })).toBeVisible();
  // Two open runs are past their deadline, one run is missed and one failed.
  await expect(
    page.getByText("4 perlu tindakan", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("2 terlambat", { exact: true })).toBeVisible();

  const cleaning = page
    .locator('[data-slot="checklist-run-card"]')
    .filter({ hasText: "Checklist Kebersihan Toilet Umum" });
  await expect(cleaning).toBeVisible();
  await expect(cleaning).toHaveAttribute("data-escalation", "reported");
  await expect(
    cleaning
      .locator('[data-slot="status-pill"]')
      .filter({ hasText: "Dilaporkan ke supervisor" }),
  ).toHaveCount(1);

  // Shift/station/zone filters are segmented groups with counts, not chips.
  await expect(
    page.getByRole("radio", { name: /^Semua shift \(\d+\)$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: /^Semua zona \(\d+\)$/ }),
  ).toBeVisible();
});

test("OPS-01 records photo, number and signature evidence then completes the checklist", async ({
  page,
}) => {
  await page.goto(`/operasional/checklist/${CLOSING_RUN_ID}?mock=normal`);
  await expect(
    page.getByRole("heading", { name: "Checklist Tutup Toko", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

  // A pending run must be started through the contract machine.
  await page.getByRole("button", { name: "Mulai checklist" }).click();
  await expect(
    page.getByRole("button", { name: "Tandai selesai" }).first(),
  ).toBeVisible();

  const plainItem = page
    .locator('[data-slot="checklist-item"]')
    .filter({ hasText: "Matikan peralatan dapur yang tidak dipakai" });
  await plainItem.getByRole("button", { name: "Tandai selesai" }).click();
  await expect(plainItem.getByText("Selesai", { exact: true })).toBeVisible();

  const photoItem = page
    .locator('[data-slot="checklist-item"]')
    .filter({ hasText: "Cek semua pintu dan jendela terkunci" });
  await photoItem.locator('input[type="file"]').setInputFiles(REAL_PHOTO);
  // The photo is uploaded (mock storage) and the API-minted id is kept.
  await expect(photoItem.getByText("Foto terunggah.")).toBeVisible();
  await photoItem.getByRole("button", { name: "Tandai selesai" }).click();
  await expect(photoItem.getByText("Selesai", { exact: true })).toBeVisible();

  const cashItem = page
    .locator('[data-slot="checklist-item"]')
    .filter({ hasText: "Rekap kas akhir shift" });
  await cashItem.getByLabel("Angka", { exact: true }).fill("500000");
  // Drawn ink is uploaded as the signature image (a typed name alone is also
  // accepted: it is rendered onto the pad; covered in legend-wf37).
  await cashItem.getByLabel("Nama penanda tangan").fill("Yusuf Hidayat");
  const pad = cashItem.getByRole("img", { name: "Tanda tangan" });
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  if (!box) throw new Error("The signature pad has no layout box.");
  await page.mouse.move(box.x + 20, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 90, { steps: 8 });
  await page.mouse.move(box.x + 140, box.y + 50, { steps: 8 });
  await page.mouse.up();
  await cashItem.getByRole("button", { name: "Tandai selesai" }).click();
  await expect(cashItem.getByText("Selesai", { exact: true })).toBeVisible();

  // The close action unlocks only with every item's required evidence.
  const close = page.getByRole("button", { name: "Selesaikan checklist" });
  await expect(close).toBeEnabled();
  await close.click();
  await expect(
    page.getByText("Checklist sudah ditutup; hasil tidak dapat diubah.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Selesai", { exact: true }).first(),
  ).toBeVisible();
});

test("OPS-01 template builder creates a template with evidence requirements", async ({
  page,
}) => {
  await page.goto("/operasional/checklist/template?mock=normal");
  await expect(
    page.getByRole("heading", { name: "Template checklist", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

  await page.getByRole("link", { name: "Template baru" }).click();
  await expect(
    page.getByRole("heading", { name: "Template checklist baru", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

  await page.getByLabel("Nama template").fill("Checklist Uji OPS-01");
  await page.getByLabel("Label butir").fill("Foto area kasir setelah dibuka");
  await page.getByRole("checkbox", { name: "Foto" }).check();
  await page.getByRole("checkbox", { name: "Tanda tangan" }).check();
  await page.getByRole("button", { name: "Simpan template" }).click();

  await expect(page.getByText("Template tersimpan.").first()).toBeVisible();
  await expect(page).toHaveURL(
    /\/operasional\/checklist\/template\/[0-9a-f-]{36}$/,
  );
  await expect(
    page.getByRole("heading", { name: "Ubah template checklist", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Foto" })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Tanda tangan" }),
  ).toBeChecked();
});

test("legend-ga0n OPS-01 queues an answer offline and changes progress only after replay confirmation", async ({
  page,
  context,
}) => {
  await page.goto(`/operasional/checklist/${CLEANING_RUN_ID}?mock=normal`);
  await expect(
    page.getByRole("heading", {
      name: "Checklist Kebersihan Toilet Umum",
      level: 1,
    }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  const item = page
    .locator('[data-slot="checklist-item"]')
    .filter({ hasText: "Isi ulang sabun dan tisu" });
  const done = item.getByRole("button", { name: "Tandai selesai" });
  await expect(item).toHaveAttribute("data-item-status", "pending");
  await expect(done).toBeEnabled();

  await context.setOffline(true);
  try {
    await expect(page.locator('[data-slot="offline-notice"]')).toBeVisible();
    await expect(done).toBeEnabled();
    await done.click();
    await expect(item).toHaveAttribute("data-queue-state", "pending");
    await expect(
      item.locator('[data-slot="checklist-item-queued"]'),
    ).toContainText("Jawaban menunggu konfirmasi server.");
    await expect(item).toHaveAttribute("data-item-status", "pending");
    await expect(
      item.locator('[data-slot="checklist-item-result"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-slot="checklist-answer-queue"]'),
    ).toContainText("1 jawaban menunggu konfirmasi server.");

    // The device has a durable attempt, while the screen still shows the
    // last confirmed server progress. Queue recreation is covered by the
    // unit test: a dev-server app shell is not available for offline reload.
    await expect.poll(() => queuedAnswerCount(page)).toBe(1);
  } finally {
    await context.setOffline(false);
  }

  await expect(item).toHaveAttribute("data-item-status", "done");
  await expect(
    item.locator('[data-slot="checklist-item-result"]'),
  ).toBeVisible();
  await expect(item.getByText("Selesai", { exact: true })).toBeVisible();
  await expect(item).not.toHaveAttribute("data-queue-state", "pending");
  await expect(
    page.locator('[data-slot="checklist-answer-queue"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-slot="offline-notice"]')).toHaveCount(0);
  await expect.poll(() => queuedAnswerCount(page)).toBe(0);
});

test("OPS-01 template builder reorders items with buttons and keeps focus", async ({
  page,
}) => {
  await page.goto(
    `/operasional/checklist/template/${OPENING_TEMPLATE_ID}?mock=normal`,
  );
  await expect(
    page.getByRole("heading", { name: "Ubah template checklist", level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

  const editors = page.locator('[data-slot="checklist-item-editor"]');
  const firstLabel = await editors
    .nth(0)
    .getByLabel("Label butir")
    .inputValue();
  const secondLabel = await editors
    .nth(1)
    .getByLabel("Label butir")
    .inputValue();

  // Each arrow names its item position, so a screen reader can tell them apart.
  await expect(
    page.getByRole("button", { name: "Naikkan butir 1", exact: true }),
  ).toBeDisabled();
  const moveDown = page.getByRole("button", {
    name: "Turunkan butir 1",
    exact: true,
  });
  await moveDown.focus();
  await page.keyboard.press("Enter");

  await expect(editors.nth(0).getByLabel("Label butir")).toHaveValue(
    secondLabel,
  );
  await expect(editors.nth(1).getByLabel("Label butir")).toHaveValue(
    firstLabel,
  );
  await expect(
    page.getByRole("status").filter({ hasText: "posisi 2" }),
  ).toHaveText(/Butir dipindah ke posisi 2 dari \d+\./);
  // Focus follows the moved item (now at position 2).
  await expect(
    page.getByRole("button", { name: "Turunkan butir 2", exact: true }),
  ).toBeFocused();
});

test("OPS-01 board has empty and error states with a way forward", async ({
  page,
}) => {
  await page.goto("/operasional/checklist?mock=empty");
  await expect(
    page.getByRole("heading", { name: BOARD_HEADING, level: 1 }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByText("Belum ada checklist", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mulai checklist" }).first(),
  ).toBeVisible();

  await page.goto("/operasional/checklist?mock=error");
  await expect(
    page.getByText("Checklist tidak dapat dimuat", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`OPS-01 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );

      await page.goto("/operasional/checklist?mock=normal", {
        waitUntil: "networkidle",
      });
      await expect(
        page.getByRole("heading", { name: BOARD_HEADING, level: 1 }),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-td4f/papan-checklist-${width}-${theme}.png`,
      );

      await page.goto(`/operasional/checklist/${CLEANING_RUN_ID}?mock=normal`, {
        waitUntil: "networkidle",
      });
      await expect(
        page.getByRole("heading", {
          name: "Checklist Kebersihan Toilet Umum",
          level: 1,
        }),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-td4f/jalankan-checklist-${width}-${theme}.png`,
      );

      await page.goto(
        `/operasional/checklist/template/${OPENING_TEMPLATE_ID}?mock=normal`,
        { waitUntil: "networkidle" },
      );
      await expect(
        page.getByRole("heading", {
          name: "Ubah template checklist",
          level: 1,
        }),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `legend-td4f/template-checklist-${width}-${theme}.png`,
      );
    });
  }
}
