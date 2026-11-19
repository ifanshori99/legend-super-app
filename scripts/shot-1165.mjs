#!/usr/bin/env node
/* global document, window -- used only inside page.evaluate callbacks */
// Screenshots for card 1165 (member tukar poin, legend-0ne0z): starts the mock
// dev server and the browser inside one heavy job, so nothing queues behind itself.
//   heavy --browser node scripts/shot-1165.mjs            (all states)
//   heavy --browser node scripts/shot-1165.mjs qr-aktif gagal   (only these)
// Output: docs/review/img/member-tukar-poin-<state>-<390|1280>.png
// Per state it prints console errors and horizontal overflow; exit 1 if any
// state failed to reach its screen. Button/heading names are the Indonesian
// copy of the catalogs (packages/shared/src/i18n/messages/member-tukar-poin-*.ts);
// adjust the regexes below if a catalog string changes.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/review/img");
const PORT = 3316;
const URL_BASE = `http://localhost:${PORT}`;
const PAGE_PATH = "/member/tukar-poin";
const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 1280, h: 900 },
];
// Mock role cookie (apps/web/src/lib/areas/access.ts MOCK_ROLE_COOKIE). Member
// pages only need a signed-in session; "all" is the mock default session.
const ROLE_COOKIE = { name: "legend-mock-role", value: "all" };
// Frozen fake clock start for the QR states, so the countdown reads 02:00.
const CLOCK_START = new Date("2026-11-19T10:00:00+07:00");

const btn = (page, re) => page.getByRole("button", { name: re }).first();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPicker(page) {
  await btn(page, /pilih jumlah poin/i).click({ timeout: 15000 });
  await page.locator("main input:visible").first().waitFor({ timeout: 10000 });
}
async function typePoints(page, value) {
  const input = page.locator("main input:visible").first();
  await input.fill(String(value));
  await input.blur();
  await page.waitForTimeout(300);
}
async function waitHeading(page, re, timeout = 15000) {
  await page.getByRole("heading", { name: re }).first().waitFor({ timeout });
}
async function makeQr(page, points = 500) {
  await openPicker(page);
  await typePoints(page, points);
  await btn(page, new RegExp(`buat qr untuk ${points} poin`, "i")).click({
    timeout: 10000,
  });
}
// Pause the page clock a hair ahead so the countdown stays at 02:00.
async function freezeClock(page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 50));
}

// name: file name part; scenario: ?mock=; clock: install fake clock before goto;
// run: steps after load; afterLoad wait uses waitUntil "networkidle" unless set.
const STATES = [
  {
    name: "tagihan-aktif",
    run: async (page) => {
      await waitHeading(page, /tagihan aktif/i);
    },
  },
  {
    name: "pilih-poin",
    run: async (page) => {
      await openPicker(page);
      await typePoints(page, 500);
      await waitHeading(page, /berapa poin/i);
    },
  },
  {
    name: "pilih-poin-740",
    run: async (page) => {
      await openPicker(page);
      await typePoints(page, 740);
      await waitHeading(page, /berapa poin/i);
    },
  },
  {
    name: "poin-kurang",
    run: async (page) => {
      await openPicker(page);
      await typePoints(page, 1500);
      await page.getByRole("alert").first().waitFor({ timeout: 10000 });
    },
  },
  {
    name: "qr-aktif",
    clock: true,
    run: async (page) => {
      await makeQr(page, 500);
      await waitHeading(page, /tunjukkan qr/i);
      await page.locator("main svg, main canvas").first().waitFor({
        timeout: 10000,
      });
      await freezeClock(page);
      await page.waitForTimeout(300);
    },
  },
  {
    name: "qr-kedaluwarsa",
    clock: true,
    run: async (page) => {
      await makeQr(page, 500);
      await waitHeading(page, /tunjukkan qr/i);
      await page.clock.fastForward(121_000);
      await waitHeading(page, /kedaluwarsa/i);
    },
  },
  {
    name: "gagal",
    scenario: "points-mint-fail",
    run: async (page) => {
      await makeQr(page, 500);
      await waitHeading(page, /qr belum dapat ditampilkan/i, 20000);
    },
  },
  {
    name: "sudah-dipakai",
    scenario: "points-consumed",
    run: async (page) => {
      await makeQr(page, 500);
      await waitHeading(page, /sudah digunakan/i, 20000);
    },
  },
  {
    name: "poin-setelah",
    scenario: "points-redeemed",
    run: async (page) => {
      await waitHeading(page, /poin setelah penukaran|sudah digunakan/i);
    },
  },
  {
    name: "tanpa-tagihan",
    scenario: "empty",
    run: async (page) => {
      await waitHeading(page, /belum ada tagihan/i);
    },
  },
  {
    name: "qr-member",
    scenario: "empty",
    run: async (page) => {
      await waitHeading(page, /belum ada tagihan/i);
      await btn(page, /tampilkan qr member/i).click({ timeout: 10000 });
      await page.getByRole("dialog").first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(500);
    },
  },
  {
    name: "pilih-tagihan",
    scenario: "points-multi-bill",
    run: async (page) => {
      await btn(page, /pilih tagihan ini/i).waitFor({ timeout: 15000 });
    },
  },
  {
    // Shot taken while the slow mock (3 s) has not answered yet.
    name: "loading",
    scenario: "slow",
    waitUntil: "commit",
    run: async (page) => {
      await page.waitForTimeout(700);
    },
  },
  {
    // Loaded first, then the connection drops: the page must hide the QR.
    name: "offline",
    run: async (page, ctx) => {
      await waitHeading(page, /tagihan aktif/i);
      await ctx.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await waitHeading(page, /koneksi terputus/i, 10000);
    },
  },
];

const only = process.argv.slice(2);
const selected = only.length
  ? STATES.filter((s) => only.includes(s.name))
  : STATES;
if (only.length && selected.length !== only.length) {
  console.error(
    "unknown state in args; known:",
    STATES.map((s) => s.name).join(" "),
  );
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
const server = spawn("pnpm", ["--filter", "@starter/web", "dev"], {
  cwd: ROOT,
  detached: false,
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
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

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
  for (const s of selected) {
    for (const vp of VIEWPORTS) {
      // Fresh context per state: mock data and the remembered scenario reset.
      const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
      });
      await ctx.addCookies([{ ...ROLE_COOKIE, url: URL_BASE }]);
      const page = await ctx.newPage();
      const errors = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text().split("\n")[0]);
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      const label = `${s.name}-${vp.w}`;
      try {
        if (s.clock) await page.clock.install({ time: CLOCK_START });
        const query = s.scenario ? `?mock=${s.scenario}` : "";
        await page.goto(`${URL_BASE}${PAGE_PATH}${query}`, {
          waitUntil: s.waitUntil ?? "networkidle",
          timeout: 60000,
        });
        await s.run(page, ctx);
        await page.waitForTimeout(300);
        const overflow = await page.evaluate(() => {
          const el = document.documentElement;
          return el.scrollWidth - el.clientWidth;
        });
        const file = join(OUT, `member-tukar-poin-${label}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(
          overflow > 1 ? "OVERFLOW" : "ok",
          label,
          overflow > 1 ? `+${overflow}px` : "",
          `console-errors=${errors.length}`,
        );
        for (const e of errors) console.log("  console:", e);
      } catch (e) {
        failed++;
        console.log("FAIL", label, String(e).split("\n")[0]);
        for (const er of errors) console.log("  console:", er);
        try {
          await page.screenshot({
            path: join(OUT, `member-tukar-poin-${label}-FAIL.png`),
            fullPage: true,
          });
        } catch {
          // page already gone
        }
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  stop();
}
console.log(failed ? `${failed} shot(s) failed` : "all shots ok");
process.exit(failed ? 1 : 0);
