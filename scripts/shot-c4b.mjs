#!/usr/bin/env node
/* global window */
// Screenshots for C4b (legend-osqou.8: impor settlement Duitku, daftar
// settlement di panel rekonsiliasi): starts the mock dev server and the
// browser inside one heavy job.
//   heavy --browser node scripts/shot-c4b.mjs
// Output: docs/review/img/c4b-<keadaan>-<390|1280>.png
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/review/img");
const PORT = 3374;
const URL_BASE = `http://localhost:${PORT}`;
const NOW = new Date("2026-11-12T10:00:00.000+07:00");
const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 1280, h: 1100 },
];
const PAGE = `${URL_BASE}/kelola/pembayaran/settlement-duitku`;
const SUBMIT = "Impor dan cocokkan";
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

const goodCsv =
  "reference,amount_idr,fee_idr\nDK-1101-0001,55000,385\nDK-1101-0002,30000,210\nDK-1101-0003,125000,875\nDK-1101-0004,42000,294\n";
const badCsv =
  "reference,amount_idr,fee_idr\nDK-1101-0001,55000,385\nDK-1101-0002,55.000,0\nDK-1101-0003,1000,1500\nDK-1101-0004\n";

let failed = 0;
const browser = await chromium.launch();
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
    const shot = async (name) => {
      await page.addStyleTag({
        content: '[data-slot="support-session-bar"]{display:none !important}',
      });
      await page.waitForTimeout(400);
      await page.screenshot({
        path: join(OUT, `c4b-${name}-${vp.w}.png`),
        fullPage: true,
      });
      console.log("ok", name, vp.w, errors.length ? errors : "");
    };
    const fillForm = async () => {
      await page.getByLabel("Nomor laporan settlement").fill("STL-20261111");
      await page.getByLabel("Periode mulai").fill("2026-11-11");
      await page.getByLabel("Periode selesai").fill("2026-11-11");
    };
    try {
      await page.clock.setFixedTime(NOW);
      // Empty: no settlement imported yet for the outlet.
      await page.goto(`${PAGE}?mock=empty`, {
        waitUntil: "networkidle",
        timeout: 60000,
      });
      await page.getByRole("button", { name: SUBMIT }).waitFor({ timeout: 15000 });
      await page
        .getByText("Belum ada settlement diimpor")
        .waitFor({ timeout: 15000 });
      await shot("kosong");

      await page.goto(`${PAGE}?mock=normal`, {
        waitUntil: "networkidle",
        timeout: 60000,
      });
      await page.getByRole("button", { name: SUBMIT }).waitFor({ timeout: 15000 });
      await fillForm();
      const input = page.locator('input[type="file"]');
      // Row errors from the server: the whole file is refused.
      await input.setInputFiles({
        name: "settlement-rusak.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(badCsv),
      });
      await page.getByText("4 baris data").waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: SUBMIT }).click();
      await page.getByText("Berkas belum diimpor").waitFor({ timeout: 15000 });
      await shot("galat");

      // Second factor: the server asks for it, the step-up opens.
      await input.setInputFiles({
        name: "settlement-duitku-11nov.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(goodCsv),
      });
      await page.getByText("4 baris data").waitFor({ timeout: 10000 });
      await page.evaluate(() =>
        window.__legendMock.failNext(
          "POST /api/payments/admin/reconciliation/settlements/csv",
          { status: 403, code: "MFA_REQUIRED" },
        ),
      );
      await page.getByRole("button", { name: SUBMIT }).click();
      await page
        .getByText("Verifikasi MFA untuk mengimpor")
        .waitFor({ timeout: 15000 });
      await shot("mfa");
      await page.getByRole("button", { name: /Batal/ }).first().click();
      await page.getByRole("button", { name: SUBMIT }).click();
      await page.getByText("Hasil pencocokan").waitFor({ timeout: 15000 });
      await shot("hasil");

      // Reconciliation panel: outlet picker and the settlement list.
      await page.goto(`${URL_BASE}/kelola/pembayaran?tab=reconciliation`, {
        waitUntil: "networkidle",
        timeout: 60000,
      });
      await page.getByText("Settlement terakhir").waitFor({ timeout: 15000 });
      await shot("rekonsiliasi");
    } catch (error) {
      failed += 1;
      console.error("FAIL", vp.w, String(error).split("\n")[0], errors);
      await page
        .screenshot({ path: join(OUT, `c4b-gagal-${vp.w}.png`) })
        .catch(() => {});
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
process.exit(failed ? 1 : 0);
