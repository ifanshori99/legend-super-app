// WS-10 learning back office (bead legend-r0wz; PRD v1.7 §3 F32 "Kinerja,
// Pelatihan & SOP"): KPI reviews, SOP library with read confirmation, graded
// training quizzes and internal announcements with receipts. Runs against the
// mock-mode web server (no API, no database): `pnpm test:e2e:mock`.
//
// The quiz is graded by the mock handler against the fixtures' answer key, so
// these specs exercise the same server-side grading the API will run. The pass
// case answers every question correctly; the fail case answers every question
// wrong and expects score 0.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

async function open(page: Page, path: string, title: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  // The management topbar owns the area h1 (the nav label); the body shows its
  // section as an h2.
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
}

/**
 * Server-rendered controls drop a click that lands before hydration. Every
 * action below is safe to retry (open dialog, choose radio, submit), so retry
 * until React owns the control (same pattern as e2e/legend-vxj.mock.spec.ts).
 */
async function retry(action: () => Promise<void>) {
  await expect(action).toPass({ timeout: 15_000 });
}

test("F32 KPI reviews show the cycle score and open the indicator detail", async ({
  page,
}) => {
  await open(page, "/kelola/kpi", "KPI");
  await expect(
    page.getByRole("heading", { name: "Review per periode" }),
  ).toBeVisible();

  const row = page.getByRole("row", { name: /Rina Kartika/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Diajukan");
  await expect(row).toContainText("Sistem");

  await retry(async () => {
    await row.getByRole("button", { name: "Lihat rincian" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Rincian review KPI" }),
  ).toBeVisible();
  // F32: each indicator keeps its own target, actual value and score.
  await expect(dialog.getByText("Serving time")).toBeVisible();
  await expect(dialog.getByText("300 detik")).toBeVisible();
  await expect(dialog.getByText("285 detik")).toBeVisible();
  await expect(dialog.getByText("Rata-rata skor").first()).toBeVisible();
});

test("F32 SOP acknowledgement flips the read confirmation for the version", async ({
  page,
}) => {
  await open(page, "/kelola/sop", "SOP");
  const row = page.getByRole("row", { name: /SOP Barista/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Belum dikonfirmasi");
  // F29: the library keeps the version history, not only the current version.
  await expect(row.getByRole("button", { name: "v1" })).toBeVisible();
  await expect(row.getByRole("button", { name: "v2" })).toBeVisible();

  await retry(async () => {
    await row.getByRole("button", { name: "Buka dokumen" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Detail SOP" }),
  ).toBeVisible();
  await expect(dialog.getByText(/Tutup shift dengan backflush/)).toBeVisible();

  await retry(async () => {
    await dialog
      .getByRole("button", { name: "Konfirmasi sudah dibaca" })
      .click();
    await expect(dialog.getByText("Sudah dikonfirmasi")).toBeVisible({
      timeout: 1000,
    });
  });

  await expect(dialog.getByText("2 konfirmasi")).toBeVisible();
  await dialog.getByRole("button", { name: "Tutup" }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toContainText("Sudah dikonfirmasi");
});

test("F32 training quiz grades a passing attempt and shows the certificate", async ({
  page,
}) => {
  await open(page, "/kelola/pelatihan", "Pelatihan");
  const row = page.getByRole("row", { name: /Dasar Barista/ });
  await expect(row).toBeVisible();

  await retry(async () => {
    await row.getByRole("link", { name: "Buka modul" }).click();
    await expect(page.getByRole("heading", { name: "Kuis" })).toBeVisible({
      timeout: 1000,
    });
  });

  // Correct answers of the "Dasar Barista" fixture key (3 questions).
  await retry(async () => {
    await page.getByRole("radio", { name: "92–94 °C" }).check();
    await expect(page.getByRole("radio", { name: "92–94 °C" })).toBeChecked({
      timeout: 1000,
    });
  });
  await retry(async () => {
    await page.getByRole("radio", { name: "18–20 g" }).check();
    await expect(page.getByRole("radio", { name: "18–20 g" })).toBeChecked({
      timeout: 1000,
    });
  });
  await retry(async () => {
    await page.getByRole("radio", { name: "Setelah setiap pitcher" }).check();
    await expect(
      page.getByRole("radio", { name: "Setelah setiap pitcher" }),
    ).toBeChecked({ timeout: 1000 });
  });

  await retry(async () => {
    await page.getByRole("button", { name: "Kirim jawaban" }).click();
    await expect(page.getByText("Skor 100 dari 100")).toBeVisible({
      timeout: 1000,
    });
  });
  await expect(page.getByText("Lulus", { exact: true })).toBeVisible();
  await expect(page.getByText(/Sertifikat internal aktif/)).toBeVisible();
  // The contract has no certificate PDF endpoint yet; the result says so.
  await expect(
    page.getByText("Unduhan sertifikat PDF belum tersedia dari API."),
  ).toBeVisible();
});

test("F32 training quiz grades a failing attempt without a certificate", async ({
  page,
}) => {
  await open(page, "/kelola/pelatihan", "Pelatihan");
  const row = page.getByRole("row", { name: /Dasar Barista/ });
  await retry(async () => {
    await row.getByRole("link", { name: "Buka modul" }).click();
    await expect(page.getByRole("heading", { name: "Kuis" })).toBeVisible({
      timeout: 1000,
    });
  });

  // Wrong answers everywhere: weighted score 0, below the 70 pass mark.
  await retry(async () => {
    await page.getByRole("radio", { name: "80–84 °C" }).check();
    await expect(page.getByRole("radio", { name: "80–84 °C" })).toBeChecked({
      timeout: 1000,
    });
  });
  await retry(async () => {
    await page.getByRole("radio", { name: "8–10 g" }).check();
    await expect(page.getByRole("radio", { name: "8–10 g" })).toBeChecked({
      timeout: 1000,
    });
  });
  await retry(async () => {
    await page.getByRole("radio", { name: "Setiap tutup shift" }).check();
    await expect(
      page.getByRole("radio", { name: "Setiap tutup shift" }),
    ).toBeChecked({ timeout: 1000 });
  });

  await retry(async () => {
    await page.getByRole("button", { name: "Kirim jawaban" }).click();
    await expect(page.getByText("Skor 0 dari 100")).toBeVisible({
      timeout: 1000,
    });
  });
  await expect(page.getByText("Belum lulus", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Sertifikat belum terbit karena belum lulus."),
  ).toBeVisible();
});

test("F32 announcement mark-read adds the reader to the receipt table", async ({
  page,
}) => {
  await open(page, "/kelola/pengumuman", "Pengumuman");
  const row = page.getByRole("row", { name: /Pembaruan SOP Bar versi 2/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("2 dibaca");

  await retry(async () => {
    await row.getByRole("button", { name: "Buka pengumuman" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  });

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Detail pengumuman" }),
  ).toBeVisible();
  // F29: the receipt table names every reader and when they read.
  await expect(dialog.getByText("Dewi Lestari")).toBeVisible();
  await expect(dialog.getByText("Agus Setiawan")).toBeVisible();

  await retry(async () => {
    await dialog.getByRole("button", { name: "Baca dan konfirmasi" }).click();
    await expect(dialog.getByText("Sudah dibaca")).toBeVisible({
      timeout: 1000,
    });
  });
  // The signed-in mock employee is Budi Santoso (CL-1003).
  const reader = dialog.getByRole("row", { name: /Budi Santoso/ });
  await expect(reader).toBeVisible();
  await expect(reader).toContainText(/\d{2} \w{3} \d{4}/);

  await dialog.getByRole("button", { name: "Tutup" }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toContainText("3 dibaca");
});

test("F32 training modules show an empty state when none are published", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/pelatihan?mock=empty", "Pelatihan");
  await expect(page.getByText("Belum ada modul pelatihan")).toBeVisible();
  await captureScreenshot(page, "legend-r0wz/pelatihan-390-empty.png");
});

for (const [width, theme] of [
  [390, "light"],
  [390, "dark"],
  [1440, "light"],
] as const) {
  test(`F32 KPI visual ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      (value) => localStorage.setItem("legend-theme", value),
      theme,
    );
    await open(page, "/kelola/kpi", "KPI");
    await expect(page.getByRole("row", { name: /Rina Kartika/ })).toBeVisible();
    await captureScreenshot(page, `legend-r0wz/kpi-${width}-${theme}.png`);
  });
}

test("F32 training quiz visual 390 light", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, "/kelola/pelatihan", "Pelatihan");
  const row = page.getByRole("row", { name: /Dasar Barista/ });
  await retry(async () => {
    await row.getByRole("link", { name: "Buka modul" }).click();
    await expect(page.getByRole("heading", { name: "Kuis" })).toBeVisible({
      timeout: 1000,
    });
  });
  await captureScreenshot(page, "legend-r0wz/pelatihan-kuis-390-light.png");
});
