#!/usr/bin/env node
/* global document, getComputedStyle -- used only inside page.evaluate callbacks */
// Screenshots for card 1082 (ui ponsel kecil): starts the mock dev server and
// the browser inside one heavy job, so nothing queues behind itself.
//   heavy --browser node scripts/shot-1082.mjs sebelum|sesudah
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/review/img");
const phase = process.argv[2] ?? "sesudah";
const PORT = 3310;
const URL_BASE = `http://localhost:${PORT}`;
const SHOTS = [
  { name: "pos-shift", path: "/pos/shift", w: 360, h: 780, bottom: true },
  { name: "pos-tiket", path: "/pos/tiket", w: 360, h: 780, bottom: true },
  {
    name: "kelola-judul",
    path: "/kelola/absensi/tinjauan-cuti",
    w: 390,
    h: 844,
  },
  { name: "display", path: "/pos/customer-display", w: 390, h: 844 },
  { name: "kelola-roster", path: "/kelola/roster", w: 1280, h: 800 },
  { name: "display", path: "/pos/customer-display", w: 1280, h: 800 },
  { name: "pos-shift", path: "/pos/shift", w: 1280, h: 800, bottom: true },
];

await mkdir(OUT, { recursive: true });
const server = spawn("pnpm", ["--filter", "@starter/web", "dev"], {
  cwd: ROOT,
  detached: false,
  stdio: "ignore",
  env: {
    ...process.env,
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
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  try {
    ready = (await fetch(`${URL_BASE}/`)).status < 500;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!ready) {
  stop();
  console.error("dev server not ready");
  process.exit(1);
}

const browser = await chromium.launch();
try {
  for (const s of SHOTS) {
    const ctx = await browser.newContext({
      viewport: { width: s.w, height: s.h },
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${URL_BASE}${s.path}`, {
        waitUntil: "networkidle",
        timeout: 60000,
      });
      await page.waitForTimeout(1500);
      if (s.bottom)
        await page.evaluate(() => {
          for (const el of document.querySelectorAll("*"))
            if (
              el.scrollHeight > el.clientHeight + 4 &&
              /auto|scroll/.test(getComputedStyle(el).overflowY)
            )
              el.scrollTop = el.scrollHeight;
        });
      await page.waitForTimeout(300);
      const file = join(OUT, `1082-${phase}-${s.name}-${s.w}.png`);
      await page.screenshot({ path: file });
      console.log("ok", file, await page.title());
    } catch (e) {
      console.log("FAIL", s.path, s.w, String(e).split("\n")[0]);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
process.exit(0);
