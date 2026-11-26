#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate callbacks */
// UI check for the POS open orders list and the order detail (brief 1268 W5,
// bead legend-9yw78.9). Modeled on scripts/ui-check-pos-u1.mjs.
//
// For every state below, at 390x844 and 1280x800: open the page in mock mode,
// wait for its text, run axe (wcag2a, wcag2aa, wcag21aa, wcag22aa), fail on
// serious/critical violations, check there is no horizontal scroll, and save a
// full-page screenshot to design/screenshots/1268-w5/<state>-<390|1280>.png.
//
//   UI_CHECK_URL=http://localhost:3268 heavy node scripts/ui-check-1268-w5.mjs
//
// UI_CHECK_URL must be a web server started with VITE_API_MOCK=true.
import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "design/screenshots/1268-w5");
const BASE = process.env.UI_CHECK_URL ?? "http://localhost:3268";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const VIEWPORTS = [
  { label: "390", width: 390, height: 844 },
  { label: "1280", width: 1280, height: 800 },
];
const DEMO_ORDER_ULID = process.env.DEMO_ORDER_ULID ?? "";

const STATES = [
  { name: "isi", path: "/pos/pesanan", text: /Belum selesai/ },
  { name: "ditahan", path: "/pos/pesanan?tab=ditahan", text: /Lanjutkan/ },
  {
    name: "kosong",
    path: "/pos/pesanan?mock=empty",
    text: /Tidak ada pesanan belum selesai/,
  },
  {
    name: "galat",
    path: "/pos/pesanan?mock=error",
    text: /belum bisa dimuat/,
  },
  { name: "detail", path: "detail", text: /Ringkasan tagihan/ },
];

async function axeSource() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("axe-core/axe.min.js");
  } catch {
    const pnpm = join(ROOT, "node_modules/.pnpm");
    const dir = (await readdir(pnpm)).find((d) => d.startsWith("axe-core@"));
    return join(pnpm, dir, "node_modules/axe-core/axe.min.js");
  }
}

const axePath = await axeSource();
await mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
let failed = 0;
for (const viewport of VIEWPORTS)
  for (const state of STATES) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      timezoneId: "Asia/Jakarta",
      locale: "id-ID",
    });
    const page = await context.newPage();
    try {
      let path = state.path;
      if (path === "detail") {
        await page.goto(`${BASE}/pos/pesanan`, { timeout: 60_000 });
        const href = await page
          .getByRole("link", { name: /Buka pesanan/ })
          .first()
          .getAttribute("href", { timeout: 45_000 });
        path = href ?? `/pos/pesanan/${DEMO_ORDER_ULID}`;
      }
      await page.goto(`${BASE}${path}`, { timeout: 60_000 });
      await page.getByText(state.text).first().waitFor({ timeout: 45_000 });
      await page.waitForTimeout(400);
      await page.addScriptTag({ path: axePath });
      const result = await page.evaluate(
        (tags) =>
          window.axe.run(document, { runOnly: { type: "tag", values: tags } }),
        AXE_TAGS,
      );
      const blocking = result.violations.filter((v) =>
        ["serious", "critical"].includes(v.impact),
      );
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      );
      await page.screenshot({
        path: join(OUT_DIR, `${state.name}-${viewport.label}.png`),
        fullPage: true,
      });
      const ok = blocking.length === 0 && !overflow;
      if (!ok) failed += 1;
      console.log(
        `${ok ? "ok  " : "FAIL"} ${state.name}-${viewport.label}` +
          (blocking.length
            ? ` axe: ${blocking.map((v) => `${v.id}(${v.nodes.length})`).join(", ")}`
            : "") +
          (overflow ? " horizontal scroll" : ""),
      );
      for (const v of blocking)
        for (const node of v.nodes.slice(0, 3))
          console.log(`     ${v.id}: ${node.target.join(" ")}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${state.name}-${viewport.label}: ${error.message}`);
    } finally {
      await context.close();
    }
  }
await browser.close();
process.exit(failed ? 1 : 0);
