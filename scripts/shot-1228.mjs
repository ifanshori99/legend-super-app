#!/usr/bin/env node
// Screenshots for card 1228 (PTKP dialog and cancel-approved reason dialog):
// starts the mock dev server and the browser inside one heavy job.
//   heavy --browser node scripts/shot-1228.mjs
// Output: docs/review/img/1228-<ptkp|batal-persetujuan>-<390|1280>.png
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/review/img");
const PORT = 3328;
const URL_BASE = `http://localhost:${PORT}`;
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000001003";
const NOW = new Date("2026-11-05T10:00:00.000+07:00");
const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 1280, h: 900 },
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
    for (const name of ["ptkp", "batal-persetujuan"]) {
      const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
      });
      await ctx.addCookies([
        { name: "legend-mock-role", value: "all", url: URL_BASE },
      ]);
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.clock.setFixedTime(NOW);
        if (name === "ptkp") {
          await page.goto(
            `${URL_BASE}/kelola/karyawan/${EMPLOYEE_ID}?mock=normal`,
            { waitUntil: "networkidle", timeout: 60000 },
          );
          await page
            .getByRole("button", { name: "Koreksi status PTKP" })
            .click({ timeout: 15000 });
          await page.getByRole("dialog").waitFor();
        } else {
          await page.goto(
            `${URL_BASE}/kelola/akuntansi/bagi-hasil/distribusi?mock=normal`,
            { waitUntil: "networkidle", timeout: 60000 },
          );
          await page.getByRole("combobox").first().click();
          await page
            .getByRole("option", { name: /Cafe Legend Bandung/ })
            .click();
          await page
            .getByRole("button", { name: "Distribusi baru" })
            .first()
            .click();
          const wizard = page.getByRole("dialog");
          await wizard.getByRole("combobox").click();
          await page.getByRole("option", { name: "Okt 2026" }).click();
          await wizard
            .getByRole("button", { name: "Hitung dan simulasikan" })
            .click();
          await wizard
            .getByRole("button", { name: "Kirim untuk persetujuan" })
            .click();
          await wizard
            .getByRole("button", { name: "Setujui distribusi" })
            .click();
          await wizard
            .getByText("Distribusi terkunci")
            .waitFor({ timeout: 15000 });
          await wizard
            .getByRole("button", { name: "Batalkan persetujuan" })
            .click();
          const reason = page.getByRole("dialog").last();
          await reason.getByRole("textbox").fill("terlalu");
          await reason
            .getByRole("button", { name: "Batalkan persetujuan" })
            .click();
        }
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(OUT, `1228-${name}-${vp.w}.png`) });
        console.log("ok", name, vp.w, errors.length ? errors : "");
      } catch (error) {
        failed++;
        await page
          .screenshot({ path: join(OUT, `1228-${name}-${vp.w}-FAIL.png`) })
          .catch(() => {});
        console.error("FAIL", name, vp.w, String(error).split("\n")[0]);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  stop();
}
process.exit(failed ? 1 : 0);
