// WS-08 ojek online: lencana platformSync (bead legend-u37u3).
// Runs against the mock-mode web server (no API, no database):
// `pnpm test:e2e:mock`.
//
// Fixture contract (apps/web/src/features/ws08-delivery/mock.ts):
//   GF-2026-1101-4471 GoFood, received   -> needs_action
//   GF-2026-1101-4452 GoFood, preparing  -> retrying
//   SHP-77120         ShopeeFood         -> ok (no mark)
//
// Assumptions:
// - The list may render rows as a table; each row has a button named
//   "Lihat rincian pesanan {id}" that opens the detail sheet (role dialog).
// - The single list screenshot per viewport holds all three states, so it is
//   named daftar-semua-<size>.png (the brief's <state> slot has no one value).
// - "Kirim ulang" and "Tandai sudah ditangani" live inside the needs_action
//   box of the detail dialog, shown only to staff who may handle orders; the
//   mock session is assumed to have that permission.
// - Mock mode answers in the client, so POST .../platform-sync/resend may not
//   appear on the network. "One press = one request" is asserted through what
//   the user sees (exactly one success toast after a double click) and, when a
//   request is visible on the network, that it was sent at most once.
// - 4468 (FINAL_ID, closed order) is the mock's failing resend; 4471 succeeds.
// - Each test starts with a page load, which resets the mock fixture.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

const NEEDS_ACTION_ID = "GF-2026-1101-4471";
const RETRYING_ID = "GF-2026-1101-4452";
const OK_ID = "SHP-77120";
const FINAL_ID = "GF-2026-1101-4468";

const RETRYING_BADGE = "Mengirim ulang ke platform";
const NEEDS_ACTION_BADGE = "Belum sinkron, perlu tindakan";
const NEEDS_ACTION_HEADING =
  "GoFood belum menerima status terakhir pesanan ini";
const NEEDS_ACTION_INTRO =
  "Pesanan tetap berjalan di outlet; hanya status di platform yang belum sama.";
const NEEDS_ACTION_STEPS = [
  "Buka aplikasi mitra GoFood dan cek status pesanan GF-2026-1101-4471.",
  "Bila berbeda, ubah status di aplikasi mitra agar sama dengan layar ini.",
  "Lanjutkan pesanan seperti biasa. Tanda ini hilang sendiri setelah GoFood menerima langkah status berikutnya.",
];
const RESEND = "Kirim ulang";
const MARK_HANDLED = "Tandai sudah ditangani";
const RESEND_OK_TOAST = "Terkirim ke GoFood. Tanda belum sinkron dihapus.";
const RESEND_FAIL_TEXT =
  "Kirim ulang belum berhasil: GoFood masih menolak. Cek aplikasi mitra, lalu tekan Tandai sudah ditangani.";
const HANDLED_TOAST = "Pesanan ditandai sudah ditangani.";
const NOTE_LABEL = "Catatan (opsional)";
const CONFIRM_HANDLED = "Ya, sudah ditangani";
const RETRYING_NOTE =
  "Sistem sedang mengirim ulang status pesanan ini ke GoFood. Tidak ada yang perlu Anda lakukan.";

async function openList(page: Page) {
  await page.goto("/kelola/delivery?tab=pesanan", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { level: 1, name: "Ojek online" }),
  ).toBeVisible();
  await expect(rowOf(page, NEEDS_ACTION_ID)).toBeVisible();
}

/**
 * Server-rendered controls drop a click that lands before hydration. Opening
 * the sheet is safe to repeat, so retry until React owns the button.
 */
async function openDetail(page: Page, id: string): Promise<Locator> {
  await openList(page);
  await expect(async () => {
    if ((await page.getByRole("dialog").count()) === 0)
      await page
        .getByRole("button", { name: `Lihat rincian pesanan ${id}` })
        .click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  const sheet = page.getByRole("dialog");
  await expect(
    sheet.getByRole("heading", { name: `Pesanan ${id}` }),
  ).toBeVisible();
  // Let the slide-in finish before any screenshot: the sheet must sit fully
  // inside the viewport.
  await expect(async () => {
    const box = await sheet.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  }).toPass({ timeout: 5_000 });
  return sheet;
}

function rowOf(page: Page, id: string): Locator {
  return page.getByRole("row").filter({ hasText: id });
}

/** Deepest element holding both the label and an aria-hidden icon. */
function badgeWithIcon(scope: Locator, label: string): Locator {
  return scope
    .locator("*")
    .filter({ hasText: label })
    .filter({ has: scope.page().locator("svg[aria-hidden='true']") })
    .last();
}

test("u37u3 daftar: lencana sinkron muncul per baris pesanan", async ({
  page,
}) => {
  await openList(page);

  const needsAction = rowOf(page, NEEDS_ACTION_ID);
  await expect(needsAction.getByText(NEEDS_ACTION_BADGE)).toBeVisible();
  await expect(needsAction.getByText(RETRYING_BADGE)).toHaveCount(0);

  const retrying = rowOf(page, RETRYING_ID);
  await expect(retrying).toBeVisible();
  await expect(retrying.getByText(RETRYING_BADGE)).toBeVisible();
  await expect(retrying.getByText(NEEDS_ACTION_BADGE)).toHaveCount(0);

  const ok = rowOf(page, OK_ID);
  await expect(ok).toBeVisible();
  await expect(ok.getByText(RETRYING_BADGE)).toHaveCount(0);
  await expect(ok.getByText(NEEDS_ACTION_BADGE)).toHaveCount(0);

  // Action controls live in the detail dialog only, never in the list.
  await expect(
    page.getByRole("button", { name: /Kirim ulang|Tandai sudah ditangani/ }),
  ).toHaveCount(0);
});

test("u37u3 detail: pesanan needs_action memuat catatan dan tiga langkah", async ({
  page,
}) => {
  const sheet = await openDetail(page, NEEDS_ACTION_ID);

  // Header badge.
  await expect(sheet.getByText(NEEDS_ACTION_BADGE).first()).toBeVisible();

  const note = sheet
    .getByRole("note")
    .filter({ hasText: NEEDS_ACTION_HEADING });
  await expect(note).toBeVisible();
  await expect(
    note.getByRole("heading", { level: 3, name: NEEDS_ACTION_HEADING }),
  ).toBeVisible();
  await expect(note.getByText(NEEDS_ACTION_INTRO)).toBeVisible();

  const steps = note.locator("ol > li");
  await expect(steps).toHaveCount(3);
  await expect(steps).toHaveText(NEEDS_ACTION_STEPS);

  await expect(note.getByRole("button", { name: RESEND })).toBeVisible();
  await expect(note.getByRole("button", { name: MARK_HANDLED })).toBeVisible();
});

test("u37u3 detail: pesanan retrying hanya memuat teks kirim ulang", async ({
  page,
}) => {
  const sheet = await openDetail(page, RETRYING_ID);

  await expect(sheet.getByText(RETRYING_BADGE, { exact: true })).toBeVisible();

  const note = sheet.getByRole("note").filter({ hasText: RETRYING_NOTE });
  await expect(note).toBeVisible();
  await expect(note.getByRole("heading")).toHaveCount(0);
  await expect(note.locator("ol, ul, li")).toHaveCount(0);

  // The needs_action guidance must not leak into a retrying order.
  await expect(sheet.getByText(NEEDS_ACTION_BADGE)).toHaveCount(0);
  await expect(sheet.getByText(NEEDS_ACTION_HEADING)).toHaveCount(0);
  // Buttons are for needs_action only.
  await expect(
    sheet.getByRole("button", { name: /Kirim ulang|Tandai sudah ditangani/ }),
  ).toHaveCount(0);
});

test("u37u3 detail: pesanan ok tidak punya catatan sinkron", async ({
  page,
}) => {
  const sheet = await openDetail(page, OK_ID);

  await expect(sheet.getByText(RETRYING_BADGE)).toHaveCount(0);
  await expect(sheet.getByText(NEEDS_ACTION_BADGE)).toHaveCount(0);
  await expect(
    sheet
      .getByRole("note")
      .filter({ hasText: /belum menerima status|mengirim ulang status/ }),
  ).toHaveCount(0);
  await expect(
    sheet.getByRole("button", { name: /Kirim ulang|Tandai sudah ditangani/ }),
  ).toHaveCount(0);
});

test("u37u3 detail: tanda hilang setelah langkah status berikutnya diterima platform", async ({
  page,
}) => {
  const sheet = await openDetail(page, NEEDS_ACTION_ID);
  await expect(sheet.getByRole("note")).toBeVisible();

  await sheet.getByRole("button", { name: "Terima pesanan" }).click();
  await expect(sheet.getByText(/D-0\d{3}/)).toBeVisible();
  await expect(sheet.getByText(NEEDS_ACTION_BADGE)).toHaveCount(0);
  await expect(sheet.getByRole("note")).toHaveCount(0);
});

test("u37u3 detail: pesanan final needs_action tidak menjanjikan tanda hilang", async ({
  page,
}) => {
  const sheet = await openDetail(page, FINAL_ID);
  const note = sheet.getByRole("note").filter({ hasText: "belum menerima" });
  await expect(note).toBeVisible();
  await expect(note.locator("ol > li")).toHaveCount(2);
  await expect(
    note.getByText(/tidak ada langkah status berikutnya/),
  ).toBeVisible();
  await expect(note.getByText(/hilang sendiri/)).toHaveCount(0);
});

test("u37u3 aksesibel: lencana punya ikon aria-hidden dan teks terbaca", async ({
  page,
}) => {
  await openList(page);

  for (const [id, label] of [
    [NEEDS_ACTION_ID, NEEDS_ACTION_BADGE],
    [RETRYING_ID, RETRYING_BADGE],
  ] as const) {
    const row = rowOf(page, id);
    // Meaning is carried by text, not by colour alone.
    await expect(row.getByText(label)).toBeVisible();
    // The decorative icon is hidden from assistive tech and sits in the badge.
    await expect(badgeWithIcon(row, label)).toBeVisible();
    expect(
      await badgeWithIcon(row, label)
        .locator("svg[aria-hidden='true']")
        .count(),
    ).toBeGreaterThan(0);
  }

  // The same holds in the detail header.
  const sheet = await openDetail(page, NEEDS_ACTION_ID);
  await expect(sheet.getByText(NEEDS_ACTION_BADGE).first()).toBeVisible();
  await expect(badgeWithIcon(sheet, NEEDS_ACTION_BADGE)).toBeVisible();
});

async function closeDetail(page: Page) {
  // A visible toast takes the first Escape; the second one closes the sheet.
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

test("u37u3 kirim ulang: berhasil menghapus tanda di dialog dan daftar", async ({
  page,
}) => {
  const sheet = await openDetail(page, NEEDS_ACTION_ID);
  await sheet.getByRole("button", { name: RESEND, exact: true }).click();

  await expect(page.getByText(RESEND_OK_TOAST, { exact: true })).toBeVisible();
  await expect(sheet.getByText(NEEDS_ACTION_BADGE)).toHaveCount(0);
  await expect(sheet.getByRole("note")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: RESEND })).toHaveCount(0);

  await closeDetail(page);
  await expect(rowOf(page, NEEDS_ACTION_ID)).toBeVisible();
  await expect(
    rowOf(page, NEEDS_ACTION_ID).getByText(NEEDS_ACTION_BADGE),
  ).toHaveCount(0);
});

test("u37u3 kirim ulang: klik ganda cepat hanya mengirim satu kali", async ({
  page,
}) => {
  const resendRequests: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /platform-sync\/resend/.test(req.url()))
      resendRequests.push(req.url());
  });

  const sheet = await openDetail(page, NEEDS_ACTION_ID);
  await sheet
    .getByRole("button", { name: RESEND, exact: true })
    .dblclick({ delay: 0 });

  await expect(page.getByText(RESEND_OK_TOAST, { exact: true })).toHaveCount(1);
  await expect(sheet.getByText(NEEDS_ACTION_BADGE)).toHaveCount(0);
  // Only observable when the call reaches the network; in mock mode it stays
  // in the client and the single-toast check above carries the assertion.
  expect(resendRequests.length).toBeLessThanOrEqual(1);
});

test("u37u3 kirim ulang: gagal tetap perlu tindakan dan bisa dicoba lagi", async ({
  page,
}) => {
  const sheet = await openDetail(page, FINAL_ID);
  const resend = sheet.getByRole("button", { name: RESEND, exact: true });
  await resend.click();

  await expect(
    sheet.getByRole("status").filter({ hasText: RESEND_FAIL_TEXT }),
  ).toBeVisible();
  await expect(sheet.getByText(NEEDS_ACTION_BADGE).first()).toBeVisible();
  await expect(sheet.getByRole("note")).toBeVisible();
  await expect(page.getByText(RESEND_OK_TOAST, { exact: true })).toHaveCount(0);
  // Enabled again once the attempt has finished.
  await expect(resend).toBeEnabled();
  await expect(
    sheet.getByRole("button", { name: MARK_HANDLED, exact: true }),
  ).toBeVisible();
});

test("u37u3 tandai ditangani: batal menutup area tanpa perubahan", async ({
  page,
}) => {
  const sheet = await openDetail(page, NEEDS_ACTION_ID);
  await sheet.getByRole("button", { name: MARK_HANDLED, exact: true }).click();

  await expect(sheet.getByLabel(NOTE_LABEL)).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: CONFIRM_HANDLED, exact: true }),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Batal", exact: true }).click();

  await expect(sheet.getByLabel(NOTE_LABEL)).toHaveCount(0);
  await expect(
    sheet.getByRole("button", { name: CONFIRM_HANDLED }),
  ).toHaveCount(0);
  await expect(sheet.getByText(NEEDS_ACTION_BADGE).first()).toBeVisible();
  await expect(page.getByText(HANDLED_TOAST, { exact: true })).toHaveCount(0);
  await expect(
    sheet.getByRole("button", { name: MARK_HANDLED, exact: true }),
  ).toBeVisible();
});

for (const [label, note] of [
  ["tanpa catatan", ""],
  ["dengan catatan", "Sudah dicek di aplikasi mitra, status sama."],
] as const) {
  test(`u37u3 tandai ditangani: konfirmasi ${label} menghapus tanda`, async ({
    page,
  }) => {
    const sheet = await openDetail(page, NEEDS_ACTION_ID);
    await sheet
      .getByRole("button", { name: MARK_HANDLED, exact: true })
      .click();
    if (note) await sheet.getByLabel(NOTE_LABEL).fill(note);
    await sheet
      .getByRole("button", { name: CONFIRM_HANDLED, exact: true })
      .click();

    await expect(page.getByText(HANDLED_TOAST, { exact: true })).toBeVisible();
    await expect(sheet.getByText(NEEDS_ACTION_BADGE)).toHaveCount(0);
    await expect(sheet.getByRole("note")).toHaveCount(0);

    await closeDetail(page);
    await expect(
      rowOf(page, NEEDS_ACTION_ID).getByText(NEEDS_ACTION_BADGE),
    ).toHaveCount(0);
  });
}

test("screenshots tombol", async ({ page }) => {
  test.setTimeout(180_000);

  for (const [width, height, size] of [
    [1280, 900, "1280"],
    [390, 844, "390"],
  ] as const) {
    await page.setViewportSize({ width, height });

    const sheet = await openDetail(page, NEEDS_ACTION_ID);
    await expect(
      sheet.getByRole("button", { name: RESEND, exact: true }),
    ).toBeVisible();
    await captureScreenshot(page, `u37u3/tombol-needs-action-${size}.png`, {
      fullPage: false,
    });

    await sheet
      .getByRole("button", { name: MARK_HANDLED, exact: true })
      .click();
    await expect(sheet.getByLabel(NOTE_LABEL)).toBeVisible();
    await captureScreenshot(page, `u37u3/konfirmasi-tandai-${size}.png`, {
      fullPage: false,
    });

    const finalSheet = await openDetail(page, FINAL_ID);
    await finalSheet.getByRole("button", { name: RESEND, exact: true }).click();
    await expect(
      finalSheet.getByRole("status").filter({ hasText: RESEND_FAIL_TEXT }),
    ).toBeVisible();
    await captureScreenshot(page, `u37u3/kirim-ulang-gagal-${size}.png`, {
      fullPage: false,
    });
  }
});

test("screenshots", async ({ page }) => {
  test.setTimeout(180_000);

  for (const [width, height, size] of [
    [390, 844, "390"],
    [1280, 900, "1280"],
  ] as const) {
    await page.setViewportSize({ width, height });

    await openList(page);
    await expect(rowOf(page, RETRYING_ID)).toBeVisible();
    await expect(rowOf(page, OK_ID)).toBeVisible();
    await captureScreenshot(page, `u37u3/daftar-semua-${size}.png`);

    for (const [id, state] of [
      [OK_ID, "ok"],
      [RETRYING_ID, "retrying"],
      [NEEDS_ACTION_ID, "needs-action"],
      [FINAL_ID, "needs-action-final"],
    ] as const) {
      await openDetail(page, id);
      // The sheet is a fixed overlay: capture the viewport, not the page.
      await captureScreenshot(page, `u37u3/detail-${state}-${size}.png`, {
        fullPage: false,
      });
    }
  }

  // 320 px: the long final-state copy must neither clip nor scroll sideways.
  await page.setViewportSize({ width: 320, height: 700 });
  await openDetail(page, FINAL_ID);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await captureScreenshot(page, "u37u3/detail-needs-action-final-320.png", {
    fullPage: false,
  });
});
