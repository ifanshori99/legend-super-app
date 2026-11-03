// WS-07 profit share back office (bead legend-ogx3; PRD v1.7 §3 F37 "Bagi
// Hasil & Dividen", §4 "Alur P"; SH-03 "Versi porsi yang tidak berjumlah tepat
// 100% atau tanpa approval tidak dapat diaktifkan", SH-04 "Distribusi yang
// sudah disetujui tidak dapat diubah; koreksi dilakukan melalui distribusi
// penyesuaian dengan jurnal pembalik").
//
// Mock-mode spec: it runs against the web dev server with VITE_API_MOCK=true
// that `pnpm test:e2e:mock` starts (playwright.mock.config.ts) — no API, no
// database. Without LEGEND_MOCK_WEB_URL every test skips, so `pnpm test:e2e`
// (production build, mock compiled out) never fails on it.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;

// The first test on a route pays Vite's cold compile.
const COLD_START_TIMEOUT_MS = 30_000;

// The wizard mutates state and re-fetches the run after each decision.
test.describe.configure({ timeout: 60_000 });

test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL to a web server running VITE_API_MOCK.",
);

const SHAREHOLDERS_PATH = "/kelola/akuntansi/bagi-hasil";
const DISTRIBUTIONS_PATH = "/kelola/akuntansi/bagi-hasil/distribusi";

async function open(page: Page, path: string, heading: string) {
  await page.goto(`${base}${path}?mock=normal`);
  // Hydration settles after load; a fill before React attaches would be wiped
  // by the first client render.
  await page.waitForLoadState("networkidle");
  // v3 (legend-vvth): the management topbar owns the page h1; the page body
  // renders h2 sections only (DESIGN.md v3 §5).
  await expect(
    page.getByRole("heading", { name: "Akuntansi", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
}

test.describe("profit share back office", () => {
  test("SH-03: the live sum blocks a short version and a fixed version needs approval", async ({
    page,
  }) => {
    await open(page, SHAREHOLDERS_PATH, "Bagi Hasil");
    await expect(
      page.getByRole("heading", { name: "Versi 3", exact: true }),
    ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

    // The seeded draft sums 9,500 bp: the live indicator says how much is
    // missing and both activation paths are disabled with the reason.
    await expect(page.getByText("Kurang 500 bp")).toBeVisible();
    await expect(
      page.getByText(/Ajukan persetujuan dinonaktifkan: total 9\.500 bp/),
    ).toBeVisible();
    const submit = page.getByRole("button", { name: "Ajukan persetujuan" });
    await expect(submit).toBeDisabled();

    // Fix the second shareholder to 3,000 bp: 4,000 + 3,000 + 3,000 = 100%.
    await page.getByRole("button", { name: "Ubah porsi" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Kurang 500 bp")).toBeVisible();
    await dialog.getByLabel("Porsi (bp)").nth(1).fill("3000");
    await expect(dialog.getByText("Tepat 100%")).toBeVisible();
    await dialog.getByRole("button", { name: "Simpan draf" }).click();
    await expect(
      page.getByText("Versi porsi tersimpan.", { exact: true }),
    ).toBeVisible();

    // The live sum now allows the request; the approval still needs a second
    // person, so the card asks for it instead of activating automatically.
    await expect(
      page.getByRole("button", { name: "Ajukan persetujuan" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Ajukan persetujuan" }).click();
    await expect(page.getByText("Menunggu persetujuan").first()).toBeVisible();
    await expect(
      page.getByText(/Penyetuju harus orang yang berbeda dari pemohon/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Aktifkan" }).click();
    await expect(
      page.getByText(
        "Versi ini sudah disetujui dan berlaku sesuai tanggalnya.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Aktifkan" })).toHaveCount(0);
  });

  test("SH-04: a run walks calculate, simulate, approve, pay, then an adjustment corrects it", async ({
    page,
  }) => {
    await open(page, DISTRIBUTIONS_PATH, "Bagi Hasil");
    await expect(
      page.getByRole("heading", { name: "Siklus distribusi" }),
    ).toBeVisible();

    // The outlet entity has an approved share version and no distributions.
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: /Cafe Legend Bandung/ }).click();
    await expect(
      page.getByText("Belum ada distribusi", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Distribusi baru" }).first().click();
    const wizard = page.getByRole("dialog");
    await expect(
      wizard.getByRole("heading", { name: "Distribusi baru" }),
    ).toBeVisible();

    // 1. Hitung: a closed period (October 2026 is closed in the fixtures).
    await wizard.getByRole("combobox").click();
    await page.getByRole("option", { name: "Okt 2026" }).click();
    await wizard
      .getByRole("button", { name: "Hitung dan simulasikan" })
      .click();

    // 2. Simulasi: per-shareholder amounts with reserve and tax deducted.
    await expect(
      wizard.getByRole("heading", { name: "Simulasi per pemegang saham" }),
    ).toBeVisible();
    await expect(wizard.getByText("Raka Pratama")).toBeVisible();
    await expect(wizard.getByText("Total bersih")).toBeVisible();
    await wizard
      .getByRole("button", { name: "Kirim untuk persetujuan" })
      .click();

    // 3. Persetujuan: a different person than the requester approves.
    await expect(
      wizard.getByRole("heading", {
        name: "Persetujuan Owner atau Direksi",
      }),
    ).toBeVisible();
    await wizard.getByRole("button", { name: "Setujui distribusi" }).click();

    // 4. Pembayaran: the approved run is locked, payments are per line.
    await expect(wizard.getByText("Distribusi terkunci")).toBeVisible();
    await expect(
      wizard.getByText(
        /Distribusi yang sudah disetujui tidak dapat diubah\. Koreksi dilakukan melalui distribusi penyesuaian/,
      ),
    ).toBeVisible();
    await wizard
      .getByRole("button", { name: /Catat pembayaran/ })
      .first()
      .click();
    await wizard.getByLabel("Referensi pembayaran").fill("TRF/E2E-SH04");
    await wizard.getByRole("button", { name: "Simpan pembayaran" }).click();
    await expect(wizard.getByText("Sudah dibayar").first()).toBeVisible();

    // SH-04: the correction is an adjustment distribution, with a reason and
    // a reversing journal — never an edit of the approved run.
    await wizard
      .getByRole("button", { name: "Distribusi penyesuaian" })
      .click();
    const adjustment = page.getByRole("dialog").last();
    await expect(
      adjustment.getByRole("heading", { name: "Distribusi penyesuaian" }),
    ).toBeVisible();
    await adjustment.getByLabel("Nilai penyesuaian (Rp)").fill("-1000000");
    await adjustment
      .getByLabel("Alasan penyesuaian")
      .fill("Koreksi uji E2E: kelebihan bayar periode Oktober.");
    await adjustment
      .getByRole("button", { name: "Buat distribusi penyesuaian" })
      .click();

    // The wizard switches to the new adjustment draft; its reversing journal
    // is part of the run's record.
    await expect(wizard.getByText("Jurnal pembalik")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      wizard.getByRole("heading", { name: "Simulasi per pemegang saham" }),
    ).toBeVisible();
  });

  test("both screens have empty and error states with a way forward", async ({
    page,
  }) => {
    await page.goto(`${base}${SHAREHOLDERS_PATH}?mock=empty`);
    await expect(page.getByText("Belum ada entitas bagi hasil")).toBeVisible();

    await page.goto(`${base}${SHAREHOLDERS_PATH}?mock=error`);
    await expect(page.getByText("Data tidak dapat dimuat").first()).toBeVisible(
      { timeout: 20_000 },
    );
    await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  });
});

for (const [name, path, heading] of [
  ["pemegang-saham", SHAREHOLDERS_PATH, "Bagi Hasil"],
  ["distribusi", DISTRIBUTIONS_PATH, "Siklus distribusi"],
] as const) {
  for (const width of [390, 1440]) {
    for (const theme of ["light", "dark"]) {
      test(`legend-ogx3 visual ${name} ${width} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(
          (value) => localStorage.setItem("legend-theme", value),
          theme,
        );
        await page.goto(`${base}${path}?mock=normal`, {
          waitUntil: "networkidle",
        });
        await expect(
          page.getByRole("heading", { name: heading }).first(),
        ).toBeVisible();
        await captureScreenshot(
          page,
          `legend-ogx3/${name}-${width}-${theme}.png`,
        );
      });
    }
  }
}

for (const scenario of ["empty", "error"]) {
  test(`legend-ogx3 visual ${scenario}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${base}${SHAREHOLDERS_PATH}?mock=${scenario}`, {
      waitUntil: "networkidle",
    });
    await expect(
      page
        .getByText(
          scenario === "error"
            ? "Data tidak dapat dimuat"
            : "Belum ada entitas bagi hasil",
        )
        .first(),
    ).toBeVisible({ timeout: 20_000 });
    await captureScreenshot(page, `legend-ogx3/${scenario}-390.png`);
  });
}
