#!/usr/bin/env node
// Screenshots for legend-f1mmf (Tagih selisih: ready, EDC waiting, unknown,
// supervisor settle, paid): starts the mock dev server and the browser inside
// one heavy job.
//   heavy --browser node scripts/shot-f1mmf.mjs
// Output: docs/review/img/f1mmf-<state>-<390|1280>.png
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
  stdio: ["ignore", "pipe", "pipe"],
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
const serverLog = [];
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (chunk) => {
    serverLog.push(String(chunk));
    if (serverLog.length > 40) serverLog.shift();
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

const CHARGE = "3f0c1a2b-4d5e-4f60-8a71-92b3c4d5e6f7";
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
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 300));
    });
    const shot = async (name, full = true) => {
      await page.waitForTimeout(400);
      await page.screenshot({
        path: join(OUT, `f1mmf-${name}-${vp.w}.png`),
        fullPage: full,
      });
      console.log("ok", name, vp.w, errors.length ? errors : "");
    };
    try {
      await page.goto(
        `${URL_BASE}/pos/tagih-selisih/${CHARGE}?demo=selisih-edc-putus`,
        { waitUntil: "networkidle", timeout: 60000 },
      );
      await page.getByText("Metode pembayaran").waitFor({ timeout: 30000 });
      await shot("siap-bayar");
      await page.getByText("EDC kartu", { exact: true }).click();
      await page.getByText("BCA · EDC 01").waitFor();
      await page.getByRole("button", { name: /Kirim .* ke mesin EDC/ }).click();
      await page
        .getByText("Menunggu pelanggan di mesin EDC")
        .waitFor({ timeout: 15000 });
      await shot("menunggu-edc");
      await page.getByText("Hasil EDC belum pasti").waitFor({ timeout: 30000 });
      await shot("unknown");
      await page
        .getByRole("button", { name: "Minta supervisor menyelesaikan" })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("combobox").nth(1).click();
      await page
        .getByRole("option", { name: "Kartu terdebet, ada slip" })
        .click();
      await dialog.getByLabel(/RRN di slip/).fill("612345678901");
      await dialog.getByLabel(/Kode approval di slip/).fill("A1B2C3");
      await dialog.getByLabel(/Nominal di slip/).fill("10000");
      await dialog
        .getByRole("textbox", { name: /Alasan/ })
        .fill("Mesin menampilkan disetujui, slip tercetak");
      await shot("resolve-supervisor", false);
      await dialog.getByRole("heading").first().click();
      await page.keyboard.type("123456");
      await page
        .getByText("Penagihan tercatat")
        .or(page.getByText("Percobaan sudah tercatat"))
        .waitFor({ timeout: 15000 });
      await shot("lunas");
    } catch (error) {
      failed++;
      await page
        .screenshot({
          path: join(OUT, `f1mmf-FAIL-${vp.w}.png`),
          fullPage: true,
        })
        .catch(() => {});
      console.error("FAIL", vp.w, String(error).split("\n")[0], errors);
      console.error(serverLog.join("").slice(-3000));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
process.exit(failed ? 1 : 0);
