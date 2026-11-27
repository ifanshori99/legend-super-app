#!/usr/bin/env node
/* global window */
// Screenshots for X2-UI (legend-wasr7.18: Tutup Hari EDC per terminal, unggah CSV settlement):
// starts the mock dev server and the browser inside one heavy job.
//   heavy --browser node scripts/shot-x2ui.mjs
// Output: docs/review/img/x2ui-<layar>-<390|1280>.png
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/review/img");
const PORT = 3372;
const URL_BASE = `http://localhost:${PORT}`;
const NOW = new Date("2026-11-12T10:00:00.000+07:00");
const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 1280, h: 1300 },
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const server = spawn("pnpm", ["--filter", "@starter/web", "dev"], {
  cwd: ROOT,
  stdio: "ignore",
  env: {
    ...process.env,
    PORT: String(PORT),
    WEB_URL: URL_BASE,
    VITE_API_MOCK: "true",
    DEPLOYMENT_MODE: "development",
    DATA_CLASSIFICATION: "synthetic",
    VITE_API_MOCK_LATENCY_MS: "0",
    LOG_LEVEL: "warn",
  },
});
const stop = () => {
  try {
    server.kill("SIGTERM");
  } catch {
    // already stopped
  }
};
process.on("exit", stop);
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  try {
    ready = (await fetch(`${URL_BASE}/`)).status < 500;
  } catch {
    await wait(1000);
  }
}
if (!ready) {
  stop();
  console.error("dev server not ready");
  process.exit(1);
}

let failed = 0;
const browser = await chromium.launch();
const goodCsv =
  "TID,RRN,Nominal\nEDC-SNP-01,000000000001,425000\nEDC-SNP-01,000000000002,300000\nEDC-SNP-01,000000000003,150000\nEDC-SNP-01,000000000004,200000\nEDC-SNP-01,000000000005,125000\n";
const badCsv =
  "TID,RRN,Nominal\nEDC-SNP-01,000000000001,425000\nEDC-SNP-01,000000000002,abc\nEDC-SNP-01,000000000003\n";
try {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
    });
    await ctx.addCookies([
      { name: "legend-mock-role", value: "all", url: URL_BASE },
    ]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const shot = async (name, fullPage = true) => {
      await page.addStyleTag({
        content: '[data-slot="support-session-bar"]{display:none !important}',
      });
      await page.waitForTimeout(400);
      await page.screenshot({
        path: join(OUT, `x2ui-${name}-${vp.w}.png`),
        fullPage,
      });
      console.log("ok", name, vp.w, errors.length ? errors : "");
    };
    try {
      await page.clock.setFixedTime(NOW);
      // Tutup Hari: mixed (default), all confirmed, mismatch and no match,
      // and no bank file yet. The POS scrolls inside its own container, so a
      // full-page shot is clipped: bring the EDC panel into view and take the
      // viewport; the second shot at the bottom shows the sticky footer.
      for (const [name, query] of [
        ["tutup-hari", ""],
        ["tutup-hari-cocok", "?demo=edc-cocok"],
        ["tutup-hari-tidak-cocok", "?demo=edc-tidak-cocok"],
        ["tutup-hari-menunggu", "?demo=edc-menunggu"],
      ]) {
        await page.goto(`${URL_BASE}/pos/tutup-hari${query}`, {
          waitUntil: "networkidle",
          timeout: 60000,
        });
        await page
          .getByText("Settlement EDC")
          .first()
          .waitFor({ timeout: 15000 });
        await page.getByText("Settlement EDC").first().scrollIntoViewIfNeeded();
        await shot(name, false);
        if (name === "tutup-hari") {
          await page
            .getByRole("button", { name: "Settlement & tutup hari" })
            .scrollIntoViewIfNeeded();
          await shot("tutup-hari-bawah", false);
        }
      }

      await page.goto(
        `${URL_BASE}/kelola/pembayaran/edc-settlement?mock=slow`,
        {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        },
      );
      await page.waitForTimeout(600);
      await shot("unggah-memuat");
      await page.goto(
        `${URL_BASE}/kelola/pembayaran/edc-settlement?mock=error`,
        {
          waitUntil: "networkidle",
          timeout: 60000,
        },
      );
      await page
        .getByText("Daftar outlet tidak bisa dimuat")
        .waitFor({ timeout: 15000 });
      await shot("unggah-gagal-muat");
      await page.goto(
        `${URL_BASE}/kelola/pembayaran/edc-settlement?mock=normal`,
        {
          waitUntil: "networkidle",
          timeout: 60000,
        },
      );
      await page
        .getByRole("button", { name: "Unggah dan cocokkan" })
        .waitFor({ timeout: 15000 });
      await shot("unggah-kosong");

      const input = page.locator('input[type="file"]');
      await input.setInputFiles({
        name: "rusak-bca.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(badCsv),
      });
      await page.getByText("3 baris data").waitFor({ timeout: 10000 });
      await shot("unggah-dipilih");
      await page.getByRole("button", { name: "Unggah dan cocokkan" }).click();
      await page.getByText("Berkas belum diimpor").waitFor({ timeout: 15000 });
      await shot("unggah-galat-baris");

      await input.setInputFiles({
        name: "settlement-bca-26nov.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(goodCsv),
      });
      await page.getByText("5 baris data").waitFor({ timeout: 10000 });
      // MFA step-up: the server asks for the second factor.
      await page.evaluate(() =>
        window.__legendMock.failNext(
          "POST /api/payments/admin/edc/settlement-csv",
          {
            status: 403,
            code: "MFA_REQUIRED",
          },
        ),
      );
      await page.getByRole("button", { name: "Unggah dan cocokkan" }).click();
      await page
        .getByText("Verifikasi MFA untuk mengunggah")
        .waitFor({ timeout: 15000 });
      await shot("unggah-mfa");
      await page.getByRole("button", { name: /Batal/ }).first().click();
      // No connection.
      await page.evaluate(() => window.__legendMock.setScenario("offline"));
      await page.getByRole("button", { name: "Unggah dan cocokkan" }).click();
      await page.getByText(/Tidak ada koneksi/).waitFor({ timeout: 15000 });
      await shot("unggah-offline");
      await page.evaluate(() => window.__legendMock.setScenario("normal"));
      await page.getByRole("button", { name: "Unggah dan cocokkan" }).click();
      await page.getByText("Hasil pencocokan").waitFor({ timeout: 15000 });
      await shot("unggah-hasil");
    } catch (error) {
      failed += 1;
      console.error("FAIL", vp.w, String(error).split("\n")[0], errors);
      await page
        .screenshot({ path: join(OUT, `x2ui-gagal-${vp.w}.png`) })
        .catch(() => {});
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
process.exit(failed ? 1 : 0);
