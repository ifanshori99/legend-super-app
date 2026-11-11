#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate callbacks */
// UI check for the AI/MCP screens. The pages come from
// scripts/ui-check-ai-mcp.urls.json: [{ "name": "...", "path": "/..." }].
//
// For every page: at 1440 and 390 px run axe (wcag2a, wcag2aa, wcag21aa,
// wcag22aa) and take a full-page screenshot; at 320 px check that the page
// does not scroll horizontally. Screenshots go to
// output/ui-check-ai-mcp/<name>-<width>.png. A summary table is printed at the
// end. Exit code 1 when axe reports a serious/critical violation, a page has
// horizontal scroll at 320 px, or a page fails to load.
//
//   UI_BASE=http://localhost:3107 node scripts/ui-check-ai-mcp.mjs
//   UI_BASE=... node scripts/ui-check-ai-mcp.mjs <name> [<name>...]   (subset)
//
// axe: uses `@axe-core/playwright` when installed, else injects the `axe-core`
// bundle from node_modules/.pnpm.
import { createRequire } from "node:module";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "output/ui-check-ai-mcp");
const URLS_FILE = join(ROOT, "scripts/ui-check-ai-mcp.urls.json");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const AXE_WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const OVERFLOW_WIDTH = { width: 320, height: 640 };
const COLD = 60_000; // Vite compiles a route on its first request.

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

/** Wait for the app to hydrate; fall back to network idle if no marker is set. */
async function settle(page) {
  await page
    .waitForFunction(
      () => document.documentElement.dataset.hydrated === "true",
      undefined,
      { timeout: COLD },
    )
    .catch(() => page.waitForLoadState("networkidle").catch(() => {}));
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

async function readPages() {
  let pages;
  try {
    pages = JSON.parse(await readFile(URLS_FILE, "utf8"));
  } catch (error) {
    console.error(
      `Cannot read ${URLS_FILE}: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  }
  if (
    !Array.isArray(pages) ||
    pages.some(
      (p) => typeof p?.name !== "string" || typeof p?.path !== "string",
    )
  ) {
    console.error(`${URLS_FILE} must be an array of { name, path }.`);
    process.exit(2);
  }
  return pages;
}

async function main() {
  const baseUrl = (process.env.UI_BASE ?? "http://localhost:3107").replace(
    /\/+$/,
    "",
  );
  const filters = new Set(process.argv.slice(2));
  const pages = (await readPages()).filter(
    (p) => filters.size === 0 || filters.has(p.name),
  );
  if (pages.length === 0) {
    console.log(
      filters.size === 0
        ? "No pages listed in scripts/ui-check-ai-mcp.urls.json; nothing to check."
        : `No page matches: ${[...filters].join(", ")}`,
    );
    process.exit(filters.size === 0 ? 0 : 2);
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
          width: run.width,
          serious: "-",
          total: "-",
          overflow: "-",
          result: "PASS",
        };
        try {
          await page.goto(`${baseUrl}${entry.path}`, {
            waitUntil: "domcontentloaded",
          });
          await settle(page);
          const problems = [];
          if (run.axe) {
            const violations = await axe.run(page);
            const blocking = violations.filter((v) =>
              BLOCKING_IMPACTS.has(v.impact ?? ""),
            );
            row.serious = blocking.length;
            row.total = violations.length;
            for (const v of blocking) {
              problems.push(
                `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node: ${v.nodes
                  .slice(0, 3)
                  .map((n) => n.target.join(" "))
                  .join(" | ")})`,
              );
            }
          } else {
            const overflow = await overflowOf(page);
            row.overflow = overflow
              ? `${overflow.scrollWidth}>${overflow.clientWidth}`
              : "no";
            if (overflow)
              problems.push(
                `horizontal scroll at ${run.width}px (${overflow.scrollWidth} > ${overflow.clientWidth})`,
              );
          }
          await page.screenshot({
            path: join(OUT_DIR, `${id}.png`),
            fullPage: true,
          });
          if (problems.length > 0) {
            row.result = "FAIL";
            failures.push(id);
            for (const problem of problems) console.log(`${id}: ${problem}`);
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          row.result = "ERROR";
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

  console.log(`\naxe: ${axe.source}, tags: ${AXE_TAGS.join(", ")}`);
  console.table(rows);
  console.log(
    failures.length === 0
      ? `All ${rows.length} checks passed. Output: output/ui-check-ai-mcp/`
      : `${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
