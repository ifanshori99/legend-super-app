#!/usr/bin/env node
// Screenshots for card 1259 (Catat refund manual: fill proof, confirm, refusal):
// starts the mock dev server and the browser inside one heavy job.
//   heavy --browser node scripts/shot-1259.mjs
// Output: docs/review/img/refund-manual-<isi|konfirmasi|ditolak>-<390|1280>.png
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/review/img");
const PORT = 3359;
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
      await page.waitForTimeout(400);
      await page.screenshot({
        path: join(OUT, `refund-manual-${name}-${vp.w}.png`),
      });
      console.log("ok", name, vp.w, errors.length ? errors : "");
    };
    try {
      await page.clock.setFixedTime(NOW);
      await page.goto(`${URL_BASE}/kelola/pembayaran?tab=refunds&mock=normal`, {
        waitUntil: "networkidle",
        timeout: 60000,
      });
      // POS-0150: approved, never sent, no provider reference.
      const row = page
        .locator("tr, li, article")
        .filter({ hasText: "POS-0150" })
        .first();
      await row
        .getByRole("button", { name: /Tinjau/ })
        .click({ timeout: 15000 });
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Catat refund manual" }).click();
      await dialog
        .getByLabel(/Tanggal dan jam transfer/)
        .fill("2026-11-11T16:30");
      await dialog.getByRole("combobox").click();
      await page.getByRole("option", { name: "Transfer bank" }).click();
      await dialog.getByLabel(/Referensi transfer/).fill("TRF-20261104-0042");
      const amount = "50000"; // POS-0150 in the mock fixtures
      await dialog.getByLabel(/Jumlah yang dibayar/).fill(amount);
      await dialog
        .getByLabel(/Catatan/)
        .fill("Transfer manual atas persetujuan manajer");
      await shot("isi");
      await dialog.getByRole("button", { name: "Periksa" }).click();
      await dialog
        .getByRole("button", { name: "Ya, catat refund manual" })
        .waitFor();
      await shot("konfirmasi");
      await dialog
        .getByRole("button", { name: "Ya, catat refund manual" })
        .click();
      await dialog.getByRole("alert").waitFor({ timeout: 15000 });
      await shot("ditolak");
    } catch (error) {
      failed++;
      await page
        .screenshot({ path: join(OUT, `refund-manual-FAIL-${vp.w}.png`) })
        .catch(() => {});
      console.error("FAIL", vp.w, String(error).split("\n")[0]);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
process.exit(failed ? 1 : 0);
