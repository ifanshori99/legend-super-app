#!/usr/bin/env node
// Screenshots for C3b + X1-UI (cashier VA / e-wallet code, manual EDC without
// a supervisor PIN): starts the mock dev server and the browser in one heavy job.
//   heavy --browser node scripts/shot-c3b.mjs
// Output: docs/review/img/c3b-<va|ewallet|edc-manual>-<light|dark>-<390|1280>.png
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/review/img");
const PORT = 3372;
const URL_BASE = `http://localhost:${PORT}`;
const ORDER = "0b0b0048-0000-4000-8000-000000000048";
// C3B_THEMES=light C3B_SCENES=edc-manual: reshoot only those.
const THEMES = (process.env.C3B_THEMES ?? "light,dark").split(",");
const ONLY = process.env.C3B_SCENES?.split(",");
const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 1280, h: 1000 },
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

/** Pick a method on the grid and continue to its panel. */
async function choose(page, name) {
  await page.goto(`${URL_BASE}/pos/bayar/${ORDER}`, {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  const re = new RegExp(`^${name}`);
  await page
    .getByRole("button", { name: re })
    .or(page.getByRole("radio", { name: re }))
    .first()
    .click({ timeout: 15000 });
  await page
    .getByRole("button", { name: new RegExp(`Lanjutkan dengan ${name}`) })
    .click();
}

const SCENES = {
  va: async (page) => {
    await choose(page, "Virtual Account");
    await page.locator("fieldset label").first().click();
    await page.getByRole("button", { name: "Buat nomor VA" }).click();
    await page.getByText("Nomor Virtual Account").waitFor({ timeout: 15000 });
  },
  ewallet: async (page) => {
    await choose(page, "E-wallet");
    await page.locator("fieldset label").first().click();
    await page.getByRole("button", { name: "Kirim permintaan" }).click();
    await page.getByRole("link", { name: /Buka halaman bayar/ }).waitFor({
      timeout: 15000,
    });
  },
  "edc-manual": async (page) => {
    await choose(page, "EDC");
    await page
      .getByRole("button", { name: /standalone/i })
      .first()
      .click({ timeout: 15000 });
    await page.getByLabel(/Nominal di slip EDC/).fill("148000");
    await page.getByLabel(/Nomor referensi bank/).fill("736214805192");
  },
};

try {
  for (const vp of VIEWPORTS)
    for (const theme of THEMES)
      for (const [name, run] of Object.entries(SCENES)) {
        if (ONLY && !ONLY.includes(name)) continue;
        const ctx = await browser.newContext({
          viewport: { width: vp.w, height: vp.h },
          colorScheme: theme,
        });
        await ctx.addCookies([
          { name: "legend-mock-role", value: "all", url: URL_BASE },
        ]);
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const file = `c3b-${name}-${theme}-${vp.w}.png`;
        try {
          await run(page);
          await page.addStyleTag({
            content:
              '[data-slot="support-session-bar"]{display:none !important}',
          });
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(OUT, file) });
          console.log("ok", file, errors.length ? errors : "");
        } catch (error) {
          failed++;
          await page
            .screenshot({ path: join(OUT, `c3b-FAIL-${file}`) })
            .catch(() => {});
          console.error("FAIL", file, String(error).split("\n")[0]);
        }
        await ctx.close();
      }
} finally {
  await browser.close();
  stop();
}
process.exit(failed ? 1 : 0);
