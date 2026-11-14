#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate callbacks */
// UI check for the AI settings screen (/kelola/pengaturan/ai) on the mock dev
// server. Every state is opened through the ?state=<s> query (the admin
// variant adds &role=admin).
//
// For every state: at 1280 and 390 px run axe (wcag2a, wcag2aa, wcag21aa,
// wcag22aa) and take a screenshot of the whole content (the viewport grows to the scroll height of `main#main-content`); at 320 px check that the page
// does not scroll horizontally. Screenshots go to
// docs/screenshots/ai-settings-v2/<state>-<width>.png and a JSON summary to
// docs/screenshots/ai-settings-v2/summary.json. Exit code 1 when axe reports a
// serious/critical violation, a page has horizontal scroll at 320 px, or a
// page fails to load.
//
//   UI_BASE=http://localhost:3417 node scripts/ui-check-ai-settings.mjs
//   node scripts/ui-check-ai-settings.mjs <name> [<name>...]   (subset)
//
// axe: uses `@axe-core/playwright` when installed, else injects the `axe-core`
// bundle from node_modules/.pnpm.
import { createRequire } from "node:module";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/screenshots/ai-settings-v2");
const SUMMARY_FILE = join(OUT_DIR, "summary.json");
const PAGE_PATH = "/kelola/pengaturan/ai";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const AXE_WIDTHS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];
const OVERFLOW_WIDTH = { width: 320, height: 640 };
const COLD = 60_000; // Vite compiles a route on its first request.
const SETTLE_MAX = 10_000; // skeletons gone + network idle, per page.

// "loading": true marks a deliberate loading state: skip the skeleton wait.
const PAGES = [
  { name: "empty", query: "state=empty" },
  { name: "device", query: "state=device" },
  { name: "connected", query: "state=connected" },
  { name: "failed", query: "state=failed" },
  { name: "expired", query: "state=expired" },
  { name: "detected", query: "state=detected" },
  { name: "disabled", query: "state=disabled" },
  { name: "loading", query: "state=loading", loading: true },
  { name: "offline", query: "state=offline" },
  { name: "session", query: "state=session" },
  { name: "connected-admin", query: "state=connected&role=admin" },
];

async function loadAxe() {
  const require = createRequire(import.meta.url);
  try {
    const { AxeBuilder } = await import("@axe-core/playwright");
    return {
      source: "@axe-core/playwright",
      run: async (page) =>
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
    };
  } catch {
    // fall through to the bare axe-core bundle
  }
  let axePath = null;
  try {
    axePath = require.resolve("axe-core/axe.min.js");
  } catch {
    const store = join(ROOT, "node_modules/.pnpm");
    const hit = (await readdir(store).catch(() => [])).find((entry) =>
      entry.startsWith("axe-core@"),
    );
    if (hit) axePath = join(store, hit, "node_modules/axe-core/axe.min.js");
  }
  if (axePath === null)
    throw new Error(
      "Neither @axe-core/playwright nor axe-core is installed. Ask the owner to add @axe-core/playwright as a devDependency.",
    );
  return {
    source: "axe-core bundle",
    run: async (page) => {
      await page.addScriptTag({ path: axePath });
      return page.evaluate(
        async (tags) =>
          (
            await window.axe.run(document, {
              runOnly: { type: "tag", values: tags },
            })
          ).violations,
        AXE_TAGS,
      );
    },
  };
}

/**
 * Wait for the app to hydrate, then (unless the entry is a deliberate loading
 * state) until no skeleton remains and the network is idle, max SETTLE_MAX.
 */
async function settle(page, entry) {
  await page
    .waitForFunction(
      () => document.documentElement.dataset.hydrated === "true",
      undefined,
      { timeout: COLD },
    )
    .catch(() => {});
  if (entry.loading !== true) {
    const deadline = Date.now() + SETTLE_MAX;
    await page
      .waitForFunction(
        () => document.querySelector('[data-slot="skeleton"]') === null,
        undefined,
        { timeout: SETTLE_MAX },
      )
      .catch(() => {});
    await page
      .waitForLoadState("networkidle", {
        timeout: Math.max(deadline - Date.now(), 1),
      })
      .catch(() => {});
  }
  await page.waitForTimeout(300); // toast/dialog motion
}

/** Horizontal overflow: the page is wider than the viewport. */
const overflowOf = (page) =>
  page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth > el.clientWidth
      ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
      : null;
  });

/**
 * The content scrolls inside `main#main-content`, so a full-page screenshot
 * cuts it off. Grow the viewport height to the scroll height of the content
 * (width stays fixed at 1280/390), then let the layout settle.
 */
async function fitViewportToContent(page, run) {
  const height = await page.evaluate(() => {
    const main = document.querySelector("main#main-content");
    const scroller =
      main && main.scrollHeight > main.clientHeight ? main : null;
    const extra = scroller ? window.innerHeight - scroller.clientHeight : 0;
    return Math.max(
      document.documentElement.scrollHeight,
      scroller ? scroller.scrollHeight + extra : 0,
    );
  });
  if (height > run.height) {
    await page.setViewportSize({ width: run.width, height });
    await page.waitForTimeout(200);
  }
}

async function main() {
  const baseUrl = (process.env.UI_BASE ?? "http://localhost:3417").replace(
    /\/+$/,
    "",
  );
  const filters = new Set(process.argv.slice(2));
  const pages = PAGES.filter((p) => filters.size === 0 || filters.has(p.name));
  if (pages.length === 0) {
    console.log(`No page matches: ${[...filters].join(", ")}`);
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const rows = [];
  const failures = [];
  try {
    for (const entry of pages) {
      const runs = [
        ...AXE_WIDTHS.map((v) => ({ ...v, axe: true })),
        { ...OVERFLOW_WIDTH, axe: false },
      ];
      for (const run of runs) {
        const id = `${entry.name}-${run.width}`;
        const context = await browser.newContext({
          viewport: { width: run.width, height: run.height },
        });
        const page = await context.newPage();
        const row = {
          page: entry.name,
          url: `${PAGE_PATH}?${entry.query}`,
          width: run.width,
          serious: null,
          total: null,
          overflow: null,
          screenshot: null,
          problems: [],
          result: "PASS",
        };
        try {
          await page.goto(`${baseUrl}${PAGE_PATH}?${entry.query}`, {
            waitUntil: "domcontentloaded",
          });
          await settle(page, entry);
          if (run.axe) {
            const violations = await axe.run(page);
            const blocking = violations.filter((v) =>
              BLOCKING_IMPACTS.has(v.impact ?? ""),
            );
            row.serious = blocking.length;
            row.total = violations.length;
            for (const v of blocking) {
              row.problems.push(
                `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node: ${v.nodes
                  .slice(0, 3)
                  .map((n) => n.target.join(" "))
                  .join(" | ")})`,
              );
            }
            await fitViewportToContent(page, run);
            await page.screenshot({ path: join(OUT_DIR, `${id}.png`) });
            row.screenshot = `docs/screenshots/ai-settings-v2/${id}.png`;
          } else {
            const overflow = await overflowOf(page);
            row.overflow = overflow
              ? `${overflow.scrollWidth}>${overflow.clientWidth}`
              : "no";
            if (overflow)
              row.problems.push(
                `horizontal scroll at ${run.width}px (${overflow.scrollWidth} > ${overflow.clientWidth})`,
              );
          }
          if (row.problems.length > 0) {
            row.result = "FAIL";
            failures.push(id);
            for (const problem of row.problems)
              console.log(`${id}: ${problem}`);
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          row.result = "ERROR";
          row.problems.push(message.split("\n")[0]);
          failures.push(id);
          console.log(`${id}: ${message.split("\n")[0]}`);
        } finally {
          await context.close();
        }
        rows.push(row);
      }
    }
  } finally {
    await browser.close();
  }

  const summary = {
    base: baseUrl,
    axe: { source: axe.source, tags: AXE_TAGS },
    total: rows.length,
    failed: failures,
    rows,
  };
  await writeFile(SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`\naxe: ${axe.source}, tags: ${AXE_TAGS.join(", ")}`);
  const hidden = new Set(["problems", "screenshot", "url"]);
  console.table(
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([key]) => !hidden.has(key)),
      ),
    ),
  );
  console.log(
    failures.length === 0
      ? `All ${rows.length} checks passed. Output: docs/screenshots/ai-settings-v2/`
      : `${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
