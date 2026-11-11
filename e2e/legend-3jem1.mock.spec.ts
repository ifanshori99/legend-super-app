// HR review of attendance logged on an approved leave day (bead legend-3jem1).
// Mock-mode spec: `pnpm test:e2e:mock e2e/legend-3jem1.mock.spec.ts` starts a web
// dev server with VITE_API_MOCK=true (no API, no database). Expected behaviour
// comes from design/mockups/hr-leave-clockin-review/README.md, the brief
// docs/briefs/sub-3jem1-hr-leave-review-ui.md and the i18n catalog
// packages/shared/src/i18n/messages/hr-leave-clockin-review.ts, never from the
// implementation.
//
// Fixture assumptions (brief "Mock"): four pending cases on 2026-10-26, shown
// in one queue: (1) annual leave over several days with a clock-out, (2) one
// leave day without a clock-out, (3) re-review (leave approved after the
// clock-in), (4) manual correction. Employee names are NOT asserted: a case is
// found by what its row says (pill, leave type, "Belum absen keluar"), and a
// card on mobile is found by the index its row had on desktop (same data, same
// order, same page session).
//
// Mock switches this spec relies on (agreed with the brief, document them in
// features/hr-leave-clockin-review/mock.ts):
//   ?mock=empty | error | slow | offline   standard lib/mock/control.ts scenarios
//   ?leaveRights=keep-only  AND localStorage["legend-mock-leave-rights"]="keep-only"
//     the reviewer holds hr.attendance.manage but not hr.leave.approve. The
//     query param covers the first load, the localStorage key covers the client
//     side navigation to the detail page (the param is dropped there).
//   POST /api/hris/attendance/logs/:logId/review failures use the standard
//     window.__legendMock.failNext (endpoint id from packages/shared endpoints.ts).
// Heading levels follow the kelola shell (same as e2e/legend-0z5k.mock.spec.ts):
// the shell banner owns the page's h1 (the menu label "Tinjauan absensi") and the
// screen's own title "Tinjauan absensi" is an h2.
// The queue renders a table (desktop) and cards (mobile) side by side and hides
// one with CSS, so text locators on the queue page only count visible matches.
// The browser clock is frozen on the fixture day; screenshots go through
// e2e/screenshots.ts (tracked evidence only with LEGEND_CAPTURE_SCREENSHOTS=1).
import {
  expect as baseExpect,
  test,
  type Locator,
  type Page,
} from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL ?? "";
test.skip(
  base === "",
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

// Timeouts are short on purpose: mock-global-setup warms every route, so a
// missing element is a real failure and must cost seconds, not minutes.
const expect = baseExpect.configure({ timeout: 5_000 });
test.use({ actionTimeout: 5_000, navigationTimeout: 10_000 });
test.setTimeout(20_000);
/** First paint of a warmed route, and the mock's own "slow" scenario (3 s). */
const COLD_START_TIMEOUT_MS = 8_000;
const HYDRATION_TIMEOUT_MS = 8_000;
/** 17:00 WIB on the fixture day. */
const FIXTURE_CLOCK = new Date("2026-10-26T10:00:00.000Z");
const QUEUE_PATH = "/kelola/absensi/tinjauan-cuti";
const CASE_COUNT = 4;
const WIDTHS = [1280, 390] as const;
type Width = (typeof WIDTHS)[number];

/** "Tinjau" or the longer accessible name "Tinjau absensi {nama} tanggal {tanggal}". */
const REVIEW_LINK = /^Tinjau(\s|$)/;
// Assumption: dates render in the id-ID long form ("26 Oktober 2026"), as the
// ws10 helper formatBusinessDate does and as the mockups show. "Okt" tolerated.
const FIXTURE_DATE = /26 Okt(?:ober)? 2026/;

const DECISION_PATH = "POST /api/hris/attendance/logs/:logId/review";
const RE_REVIEW_NOTE = "Perlu ditinjau ulang: ada cuti baru disetujui";
const NO_CANCEL_RIGHT =
  "Anda tidak memiliki hak untuk membatalkan cuti. Minta HR yang berwenang meninjau keputusan ini.";
const MULTI_DAY_NOTE =
  "Hanya cuti pada tanggal ini yang dibatalkan; hari cuti lain tetap berlaku.";

type CaseKind = "annual" | "single" | "reReview" | "manual";

/** What each fixture case says in its queue row / card (see header). */
const CASE_MATCH: Record<CaseKind, (text: string) => boolean> = {
  reReview: (text) => text.includes("Perlu ditinjau ulang"),
  manual: (text) =>
    text.includes("Koreksi absen manual") &&
    !text.includes("Perlu ditinjau ulang"),
  single: (text) =>
    text.includes("Belum absen keluar") &&
    !text.includes("Koreksi absen manual") &&
    !text.includes("Perlu ditinjau ulang"),
  annual: (text) =>
    text.includes("Absen saat cuti") &&
    text.toLowerCase().includes("cuti tahunan") &&
    !text.includes("Belum absen keluar") &&
    !text.includes("Koreksi absen manual") &&
    !text.includes("Perlu ditinjau ulang"),
};

async function prepare(page: Page, width: number = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem("legend-theme", "light"));
  // Dialog and banner screenshots must not catch an enter animation mid-fade.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.setFixedTime(FIXTURE_CLOCK);
}

/**
 * Same two signals as ./hydration.ts (html data-hydrated, every control in the
 * main area carries React props) with a short timeout.
 */
async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: HYDRATION_TIMEOUT_MS },
  );
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#main-content") ?? document.body;
      return Array.from(
        root.querySelectorAll("input, button, textarea, select, a[href]"),
      ).every((el) =>
        Object.keys(el).some((key) => key.startsWith("__reactProps$")),
      );
    },
    undefined,
    { timeout: HYDRATION_TIMEOUT_MS },
  );
}

/** Only the matches a user can see (the hidden table/card twin is ignored). */
function seen(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

/** The screen's own title: an h2 under the shell's h1 "Tinjauan absensi". */
function queueTitle(page: Page) {
  return page.getByRole("heading", { level: 2, name: "Tinjauan absensi" });
}

function reviewLinks(page: Page) {
  return page.getByRole("link", { name: REVIEW_LINK });
}

async function expectQueueLoaded(page: Page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Tinjauan absensi" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(queueTitle(page)).toBeVisible();
  await expect(reviewLinks(page)).toHaveCount(CASE_COUNT, {
    timeout: COLD_START_TIMEOUT_MS,
  });
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    [document.documentElement, document.querySelector("#main-content")].every(
      (el) => !el || el.scrollWidth <= el.clientWidth + 1,
    ),
  );
}

/**
 * Opens the queue (always measured on desktop), remembers the position of the
 * wanted case, switches to `width`, and returns the link to its detail page.
 */
async function queueWithCase(
  page: Page,
  kind: CaseKind,
  width: Width,
  query = "",
) {
  await prepare(page, 1280);
  await page.goto(`${base}${QUEUE_PATH}${query}`);
  await expectQueueLoaded(page);
  const rows = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: REVIEW_LINK }) });
  const texts = await rows.allInnerTexts();
  const index = texts.findIndex(CASE_MATCH[kind]);
  expect(index, `queue has a "${kind}" case`).toBeGreaterThanOrEqual(0);
  if (width !== 1280) await page.setViewportSize({ width, height: 900 });
  return reviewLinks(page).nth(index);
}

async function openDetail(
  page: Page,
  kind: CaseKind,
  width: Width,
  query = "",
) {
  const link = await queueWithCase(page, kind, width, query);
  await waitForHydration(page);
  await link.click();
  await expect(page).toHaveURL(/\/kelola\/absensi\/tinjauan-cuti\/[^/?#]+/);
  await expect(
    page.getByRole("heading", { name: "Tinjau absensi saat cuti" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await waitForHydration(page);
}

function keepButton(page: Page) {
  return page.getByRole("button", { name: "Tetap cuti", exact: true });
}
function cancelButton(page: Page) {
  return page.getByRole("button", {
    name: "Batalkan cuti hari ini, hitung hadir",
    exact: true,
  });
}
function backToQueue(page: Page) {
  return page
    .getByRole("link", { name: "Kembali ke antrean" })
    .or(page.getByRole("button", { name: "Kembali ke antrean" }))
    .first();
}

/** Mock control from the page, as a local cast (specs share one tsconfig). */
async function failNextDecision(
  page: Page,
  failure: { status: number; code: string },
) {
  await page.evaluate(
    ([match, value]) => {
      (
        window as unknown as {
          __legendMock: {
            failNext: (m: string, f: { status: number; code: string }) => void;
          };
        }
      ).__legendMock.failNext(match, value);
    },
    [DECISION_PATH, failure] as const,
  );
}

async function noRightsMode(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("legend-mock-leave-rights", "keep-only"),
  );
}

// ---------------------------------------------------------------------------
// 1 + 8 + 9: queue

test("legend-3jem1 queue 1280: HR sees the cases that need a decision, with leave and clock times", async ({
  page,
}) => {
  await prepare(page, 1280);
  await page.goto(`${base}${QUEUE_PATH}`);
  await expectQueueLoaded(page);

  await expect(
    page.getByText("Tinjau absensi yang memerlukan keputusan HR."),
  ).toBeVisible();
  await expect(
    page
      .getByRole("searchbox", { name: "Cari nama karyawan" })
      .or(page.getByRole("textbox", { name: "Cari nama karyawan" })),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Perlu ditinjau" }),
  ).toBeVisible();
  // The area menu offers the screen.
  await expect(
    page.getByRole("link", { name: "Tinjauan absensi" }).first(),
  ).toBeVisible();

  const table = page.getByRole("table");
  for (const column of [
    "Status",
    "Nama karyawan",
    "Tanggal",
    "Cuti",
    "Jam masuk",
    "Jam pulang",
    "Aksi",
  ]) {
    await expect(
      table.getByRole("columnheader", { name: column, exact: true }),
    ).toBeVisible();
  }

  const rows = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: REVIEW_LINK }) });
  const texts = await rows.allInnerTexts();
  expect(texts.length).toBe(CASE_COUNT);
  for (const kind of ["annual", "single", "reReview", "manual"] as const) {
    expect(
      texts.filter(CASE_MATCH[kind]).length,
      `exactly one "${kind}" row`,
    ).toBe(1);
  }

  const annual = rows.nth(texts.findIndex(CASE_MATCH.annual));
  await expect(
    annual.getByText("Absen saat cuti", { exact: true }),
  ).toBeVisible();
  await expect(annual.getByText("Cuti tahunan")).toBeVisible();
  await expect(annual.getByText(FIXTURE_DATE)).toBeVisible();
  // Clock times are shown as times, never as "Belum absen keluar".
  await expect(annual.getByText(/\d{2}[.:]\d{2}/).first()).toBeVisible();
  await expect(annual.getByText("Belum absen keluar")).toHaveCount(0);

  // A missing clock-out is said in words, not shown as a number.
  const single = rows.nth(texts.findIndex(CASE_MATCH.single));
  await expect(single.getByText("Belum absen keluar")).toBeVisible();

  // Status is icon + text, never colour alone.
  const manual = rows.nth(texts.findIndex(CASE_MATCH.manual));
  await expect(
    manual.getByText("Koreksi absen manual", { exact: true }),
  ).toBeVisible();

  // State 8: an accepted log that got a new approved leave comes back.
  await expect(
    seen(page.getByText("Perlu ditinjau ulang", { exact: true })),
  ).toBeVisible();
  await expect(
    seen(page.getByText(RE_REVIEW_NOTE, { exact: true })),
  ).toBeVisible();

  // Touch target of the row action.
  const box = await reviewLinks(page).first().boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);

  await captureScreenshot(page, "legend-3jem1/queue-1280.png");
});

test("legend-3jem1 queue 390: cards, a full-width Tinjau action, and no horizontal scroll", async ({
  page,
}) => {
  await prepare(page, 390);
  await page.goto(`${base}${QUEUE_PATH}`);
  await expectQueueLoaded(page);

  await expect(seen(page.getByText("Belum absen keluar"))).toBeVisible();
  await expect(
    seen(page.getByText(RE_REVIEW_NOTE, { exact: true })),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);

  const box = await reviewLinks(page).first().boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  // Full-width inside the card: most of the 390px screen.
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(390 * 0.6);
  expect(await noHorizontalScroll(page)).toBe(true);
  await captureScreenshot(page, "legend-3jem1/queue-390.png");

  await page.setViewportSize({ width: 320, height: 800 });
  await expect(reviewLinks(page)).toHaveCount(CASE_COUNT);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("legend-3jem1 queue: search by employee name narrows the list, an unknown name says so", async ({
  page,
}) => {
  await prepare(page, 1280);
  await page.goto(`${base}${QUEUE_PATH}`);
  await expectQueueLoaded(page);
  await waitForHydration(page);

  const rows = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: REVIEW_LINK }) });
  // Column order is fixed by the brief: Status | Nama karyawan | ...
  const name = (await rows.first().getByRole("cell").nth(1).innerText()).trim();
  expect(name.length).toBeGreaterThan(0);

  const search = page
    .getByRole("searchbox", { name: "Cari nama karyawan" })
    .or(page.getByRole("textbox", { name: "Cari nama karyawan" }));
  await search.fill(name);
  await expect(rows.first()).toContainText(name);
  const shown = await rows.allInnerTexts();
  expect(shown.length).toBeGreaterThanOrEqual(1);
  expect(shown.every((text) => text.includes(name))).toBe(true);

  await search.fill("zzzz tidak ada nama ini");
  // The queue uses the kit's DataTableShell texts (coordinator decision).
  await expect(
    page.getByText("Tidak ada hasil untuk “zzzz tidak ada nama ini”", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Coba kata lain atau hapus filter.", { exact: true }),
  ).toBeVisible();
  await expect(reviewLinks(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 2 + 3 + 5: detail, keep leave

for (const width of WIDTHS) {
  test(`legend-3jem1 keep leave ${width}: queue, detail, confirm, result "Tetap cuti" (never "Ditolak"), back to queue`, async ({
    page,
  }) => {
    await openDetail(page, "single", width);

    // The detail is a page with a way back, not a modal.
    await expect(backToQueue(page)).toBeVisible();
    for (const label of [
      "Nama karyawan",
      "Jenis cuti",
      "Periode cuti (disetujui)",
      "Tanggal absensi",
      "Jam masuk",
      "Jam keluar",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    // Several elements carry the date (some hidden, e.g. a "Sampai ..." note);
    // only a match the user can see counts.
    await expect(seen(page.getByText(FIXTURE_DATE)).first()).toBeVisible();
    await expect(page.getByText("Belum absen keluar")).toBeVisible();
    await expect(
      page.getByText("Saldo cuti dan gaji belum berubah sampai HR memutuskan."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Keputusan", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Pilih tindakan untuk absensi pada .*26 Okt(?:ober)? 2026/,
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Tetap cuti mempertahankan saldo dan status cuti; membatalkan cuti mengembalikan saldo untuk hari ini dan menghitung hari ini sebagai hadir untuk dasar gaji.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Gaji aktual mengikuti proses penggajian yang berlaku, bukan perubahan langsung saat absen.",
      ),
    ).toBeVisible();
    // A one-day leave has nothing to say about "other days".
    await expect(page.getByText(MULTI_DAY_NOTE)).toHaveCount(0);
    await expect(keepButton(page)).toBeEnabled();
    await expect(cancelButton(page)).toBeEnabled();
    if (width === 390) expect(await noHorizontalScroll(page)).toBe(true);
    await captureScreenshot(page, `legend-3jem1/detail-${width}.png`);

    // 3: confirm dialog names the impact and the date; Kembali leaves nothing changed.
    await keepButton(page).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Tetap cuti untuk tanggal ini?" }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        /Cuti dan saldo tetap\. Absen pada .*26 Okt(?:ober)? 2026 tidak dihitung sebagai hadir\./,
      ),
    ).toBeVisible();
    await captureScreenshot(page, `legend-3jem1/confirm-keep-${width}.png`);
    await dialog.getByRole("button", { name: "Kembali", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Keputusan tersimpan")).toHaveCount(0);

    await keepButton(page).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Tetap cuti", exact: true })
      .click();

    // 5: result on the same page.
    await expect(
      page.getByText("Keputusan tersimpan", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Tetap cuti", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Cuti dan saldo pada .*26 Okt(?:ober)? 2026 tetap\. Absen pada hari itu tidak dihitung sebagai hadir\./,
      ),
    ).toBeVisible();
    // Keeping leave is not a rejection.
    await expect(page.getByText("Ditolak")).toHaveCount(0);
    await captureScreenshot(page, `legend-3jem1/result-keep-${width}.png`);

    await backToQueue(page).click();
    await expect(page).toHaveURL(new RegExp(`${QUEUE_PATH}/?(\\?.*)?$`));
    // The decided case left the queue.
    await expect(reviewLinks(page)).toHaveCount(CASE_COUNT - 1);
  });
}

// ---------------------------------------------------------------------------
// 2 + 4 + 6: detail, cancel leave of one day in a multi-day leave

for (const width of WIDTHS) {
  test(`legend-3jem1 cancel leave ${width}: multi-day leave, only this date is cancelled, result "Cuti hari ini dibatalkan"`, async ({
    page,
  }) => {
    await openDetail(page, "annual", width);

    await expect(page.getByText("Cuti tahunan").first()).toBeVisible();
    await expect(
      page.getByText(/\d{1,2}( \w+)?( 2026)? sampai \d{1,2} \w+ 2026/),
    ).toBeVisible();
    await expect(page.getByText(MULTI_DAY_NOTE)).toBeVisible();
    await expect(cancelButton(page)).toBeEnabled();

    await cancelButton(page).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", {
        name: "Batalkan cuti hari ini dan hitung hadir?",
      }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        /Hanya cuti pada .*26 Okt(?:ober)? 2026 yang dibatalkan\. Saldo cuti untuk hari itu dikembalikan, dan hari itu menjadi dasar hadir\./,
      ),
    ).toBeVisible();
    await captureScreenshot(page, `legend-3jem1/confirm-cancel-${width}.png`);

    await dialog.getByRole("button", { name: "Kembali", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Keputusan tersimpan")).toHaveCount(0);

    await cancelButton(page).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Batalkan cuti hari ini", exact: true })
      .click();

    await expect(
      page.getByText("Keputusan tersimpan", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Cuti hari ini dibatalkan", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Cuti pada .*26 Okt(?:ober)? 2026 dibatalkan dan saldo untuk hari itu dikembalikan\. Hari itu menjadi dasar hadir; cuti di tanggal lain tetap berlaku\./,
      ),
    ).toBeVisible();
    await expect(page.getByText("Ditolak")).toHaveCount(0);
    await captureScreenshot(page, `legend-3jem1/result-cancel-${width}.png`);

    await backToQueue(page).click();
    await expect(reviewLinks(page)).toHaveCount(CASE_COUNT - 1);
  });
}

// ---------------------------------------------------------------------------
// Confirm fails: error inside the dialog, dialog stays open.
// Assumption: a refusal that retrying cannot fix (409 "cuti tidak disetujui")
// and a transient failure (500) both keep the dialog open with a human message;
// only the transient one is promised to be retryable ("tombol bisa diulang").

for (const width of WIDTHS) {
  test(`legend-3jem1 failed confirmation ${width}: the error stays in the dialog and a transient failure can be retried`, async ({
    page,
  }) => {
    await openDetail(page, "single", width);
    const dialog = page.getByRole("dialog");

    // A refusal from the server: human message, never the raw code.
    await failNextDecision(page, {
      status: 409,
      code: "ATTENDANCE_LEAVE_NOT_APPROVED",
    });
    await keepButton(page).click();
    await dialog
      .getByRole("button", { name: "Tetap cuti", exact: true })
      .click();
    await expect(
      dialog.getByText(/Tidak ada cuti disetujui pada hari itu\./),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("ATTENDANCE_LEAVE_NOT_APPROVED")).toHaveCount(
      0,
    );
    await expect(page.getByText("Keputusan tersimpan")).toHaveCount(0);
    await captureScreenshot(page, `legend-3jem1/confirm-failed-${width}.png`);
    await dialog.getByRole("button", { name: "Kembali", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // A transient failure: the same button saves the decision on the next try.
    await failNextDecision(page, { status: 500, code: "INTERNAL_ERROR" });
    await keepButton(page).click();
    const retry = dialog.getByRole("button", {
      name: "Tetap cuti",
      exact: true,
    });
    await retry.click();
    await expect(
      dialog.getByText("Keputusan belum tersimpan", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Terjadi kesalahan. Coba lagi."),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Keputusan tersimpan")).toHaveCount(0);
    await expect(retry).toBeEnabled();

    // The failure was one-shot.
    await retry.click();
    await expect(
      page.getByText("Keputusan tersimpan", { exact: true }),
    ).toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// 7: reviewer without the right to cancel leave

for (const width of WIDTHS) {
  test(`legend-3jem1 no cancel right ${width}: cancel is disabled with a readable reason, keep leave still works`, async ({
    page,
  }) => {
    await noRightsMode(page);
    await openDetail(page, "annual", width, "?leaveRights=keep-only");

    const cancel = cancelButton(page);
    await expect(cancel).toBeDisabled();
    await expect(page.getByText(NO_CANCEL_RIGHT)).toBeVisible();
    // The reason is tied to the button for assistive technology.
    await expect(cancel).toHaveAccessibleDescription(NO_CANCEL_RIGHT);
    await expect(keepButton(page)).toBeEnabled();
    await captureScreenshot(page, `legend-3jem1/no-cancel-right-${width}.png`);

    await keepButton(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// 8 (README 7): manual correction

for (const width of WIDTHS) {
  test(`legend-3jem1 manual correction ${width}: same two actions, no Terima or Tolak, whole day only`, async ({
    page,
  }) => {
    await openDetail(page, "manual", width);

    await expect(
      page.getByText("Koreksi absen manual", { exact: true }).first(),
    ).toBeVisible();
    await expect(keepButton(page)).toBeEnabled();
    await expect(cancelButton(page)).toBeEnabled();
    await expect(
      page.getByRole("button", { name: /^(Terima|Tolak)$/ }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Pembatalan selalu satu hari penuh, bukan setengah hari."),
    ).toBeVisible();
    await captureScreenshot(
      page,
      `legend-3jem1/manual-correction-${width}.png`,
    );
  });
}

// ---------------------------------------------------------------------------
// Deep link and unknown case

test("legend-3jem1 detail is a real page: a deep link opens it after a reload", async ({
  page,
}) => {
  await openDetail(page, "annual", 1280);
  const url = page.url();

  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Tinjau absensi saat cuti" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByText("Jenis cuti", { exact: true })).toBeVisible();
  await expect(cancelButton(page)).toBeVisible();
});

for (const width of WIDTHS) {
  test(`legend-3jem1 unknown case ${width}: says it was not found and leads back to the queue`, async ({
    page,
  }) => {
    await prepare(page, width);
    await page.goto(`${base}${QUEUE_PATH}/01JZZZZZZZZZZZZZZZZZZZZZZZ`);

    await expect(
      page.getByText("Tinjauan tidak ditemukan", { exact: true }),
    ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
    await expect(
      page.getByText(
        "Absensi ini tidak ada atau sudah diputuskan. Kembali ke antrean untuk melihat tinjauan terbaru.",
      ),
    ).toBeVisible();
    await expect(keepButton(page)).toHaveCount(0);
    await captureScreenshot(page, `legend-3jem1/not-found-${width}.png`);

    await waitForHydration(page);
    await backToQueue(page).click();
    await expect(queueTitle(page)).toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// 10 + loading + error + offline

for (const width of WIDTHS) {
  test(`legend-3jem1 empty queue ${width}`, async ({ page }) => {
    await prepare(page, width);
    await page.goto(`${base}${QUEUE_PATH}?mock=empty`);

    await expect(queueTitle(page)).toBeVisible({
      timeout: COLD_START_TIMEOUT_MS,
    });
    await expect(
      page.getByText("Tidak ada tinjauan absensi", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Absensi yang memerlukan tinjauan akan muncul di sini."),
    ).toBeVisible();
    await expect(reviewLinks(page)).toHaveCount(0);
    if (width === 390) expect(await noHorizontalScroll(page)).toBe(true);
    await captureScreenshot(page, `legend-3jem1/empty-${width}.png`);
  });

  test(`legend-3jem1 loading ${width}: a skeleton announces that the queue is loading`, async ({
    page,
  }) => {
    await prepare(page, width);
    await page.goto(`${base}${QUEUE_PATH}?mock=slow`);

    // The mock "slow" scenario answers after 3 seconds. The queue uses the
    // kit's DataTableShell loading state: the "Perlu ditinjau" region is busy
    // and says "Memuat…" to screen readers (coordinator decision).
    const region = page.getByRole("region", { name: "Perlu ditinjau" });
    await expect(region).toHaveAttribute("aria-busy", "true", {
      timeout: COLD_START_TIMEOUT_MS,
    });
    await expect(region.getByText("Memuat…", { exact: true })).toBeAttached();
    await expect(reviewLinks(page)).toHaveCount(0);
    await captureScreenshot(page, `legend-3jem1/loading-${width}.png`);

    await expect(reviewLinks(page)).toHaveCount(CASE_COUNT, {
      timeout: 25_000,
    });
  });

  test(`legend-3jem1 load error ${width}: says what failed and Coba lagi recovers`, async ({
    page,
  }) => {
    await prepare(page, width);
    await page.goto(`${base}${QUEUE_PATH}?mock=error`);

    await expect(
      page.getByText("Tinjauan absensi tidak dapat dimuat", { exact: true }),
    ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
    await expect(
      page.getByText(
        "Daftar tinjauan gagal dimuat. Periksa koneksi, lalu coba lagi.",
      ),
    ).toBeVisible();
    const retry = page.getByRole("button", { name: "Coba lagi" });
    await expect(retry).toBeVisible();
    await captureScreenshot(page, `legend-3jem1/error-${width}.png`);

    await waitForHydration(page);
    await page.evaluate(() => {
      (
        window as unknown as {
          __legendMock: { setScenario: (s: string) => void };
        }
      ).__legendMock.setScenario("normal");
    });
    await retry.click();
    await expect(reviewLinks(page)).toHaveCount(CASE_COUNT, {
      timeout: COLD_START_TIMEOUT_MS,
    });
  });
}

test("legend-3jem1 offline: losing the connection says so on the queue", async ({
  page,
  context,
}) => {
  // Assumption: the offline notice follows the browser's connectivity
  // (navigator.onLine), like the other WS-10 screens, so the test cuts the
  // network after the queue loaded. `?mock=offline` (every API call fails with
  // a network error) is a load failure and is covered by the load error state.
  await prepare(page, 390);
  await page.goto(`${base}${QUEUE_PATH}`);
  await expectQueueLoaded(page);
  await waitForHydration(page);
  await expect(page.getByText("Anda sedang offline")).toHaveCount(0);

  await context.setOffline(true);
  await expect(
    page.getByText("Anda sedang offline", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Sambungkan kembali koneksi untuk memuat atau memutuskan tinjauan.",
    ),
  ).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText("Anda sedang offline")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Access guard

test("legend-3jem1 guard: a role without the attendance review right gets no page and no menu entry", async ({
  page,
}) => {
  await prepare(page, 1280);
  // Finance enters /kelola (dashboard.management.view) but holds no
  // hr.attendance.manage (packages/shared/src/access/roles.ts).
  await page
    .context()
    .addCookies([{ name: "legend-mock-role", value: "finance", url: base }]);
  await page.goto(`${base}${QUEUE_PATH}`);

  await expect(
    page.getByText("Halaman tidak ditemukan", { exact: true }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByRole("heading", { name: "Tinjauan absensi" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Tinjauan absensi" }),
  ).toHaveCount(0);
});
