#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate callbacks */
// UI check for the "Perangkat alarm" panel on /kelola/keamanan (bead legend-gchkf).
//
// At 390x844 and 1280x800: open the page in mock mode, wait for the panel, run
// axe (wcag2a, wcag2aa, wcag21aa, wcag22aa), measure horizontal overflow, and
// save docs/screenshots/820-perangkat-<390|1280>.png. At 390 it also opens the
// revoke dialog and saves docs/screenshots/820-perangkat-dialog-390.png.
//
//   UI_CHECK_URL=http://localhost:3225 heavy node scripts/ui-check-push-devices.mjs
//
// UI_CHECK_URL must be a web server started with VITE_API_MOCK=true (for
// example `pnpm test:e2e:mock` starts one, see playwright.mock.config.ts).
// Never point it at a real deployment: mock mode serves fixtures.
//
// Session: no login in mock mode; no cookie = role "all", as in ui-check.mjs.
// Exit code 1 on any serious/critical axe violation or horizontal overflow.
//
// axe: uses `@axe-core/playwright` when installed, else injects the `axe-core`
// bundle found in node_modules/.pnpm (same fallback as scripts/ui-check.mjs).
import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/screenshots");
const PAGE_PATH = "/kelola/keamanan";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "390", width: 390, height: 844 },
  { label: "1280", width: 1280, height: 800 },
];
const WAIT_TIMEOUT = 10_000; // Hard cap for every wait.
const PANEL_TITLE = "Perangkat alarm";
const REVOKE_BUTTON = /^Cabut/;

async function waitForHydration(page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: WAIT_TIMEOUT },
  );
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#main-content") ?? document.body;
      return Array.from(
        root.querySelectorAll("input, button, textarea, select, a[href]"),
      ).every((el) =>
        Object.keys(el).some((key) => key.startsWith("__reactProps$")),
      );
    },
    undefined,
    { timeout: WAIT_TIMEOUT },
  );
}

async function openPanel(page) {
  await page.goto(`${page.__baseUrl}${PAGE_PATH}`, {
    waitUntil: "domcontentloaded",
  });
  const title = page.getByRole("heading", { name: PANEL_TITLE });
  await title.waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
  await page
    .getByRole("button", { name: REVOKE_BUTTON })
    .first()
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
  await waitForHydration(page);
  // The page scrolls inside the shell, so a plain screenshot is one viewport:
  // bring the whole panel (title to last row) into view.
  await title.scrollIntoViewIfNeeded();
  await page
    .getByRole("button", { name: REVOKE_BUTTON })
    .last()
    .evaluate((el) => el.scrollIntoView({ block: "end" }));
}

/** Pixels the document is wider than the viewport (0 = no horizontal scroll). */
function overflowX(page) {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

async function loadAxe() {
  const require = createRequire(import.meta.url);
  try {
    const { AxeBuilder } = await import("@axe-core/playwright");
    return {
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
      "Neither @axe-core/playwright nor axe-core is installed. Not adding dependencies on my own: ask the owner to add @axe-core/playwright as a devDependency.",
    );
  return {
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

/** Runs axe + overflow, prints the result, returns true when clean. */
async function report(id, page, axe) {
  const violations = await axe.run(page);
  const blocking = violations.filter((v) =>
    BLOCKING_IMPACTS.has(v.impact ?? ""),
  );
  const overflow = await overflowX(page);
  const clean = blocking.length === 0 && overflow <= 0;
  console.log(
    `${clean ? "PASS" : "FAIL"} ${id}: axe ${blocking.length} serious/critical` +
      `, ${violations.length - blocking.length} minor/moderate; overflow-x ${overflow}px`,
  );
  for (const v of violations) {
    console.log(`  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node)`);
    for (const node of v.nodes.slice(0, 3))
      console.log(`    ${node.target.join(" ")}`);
  }
  return clean;
}

async function main() {
  const baseUrl = process.env.UI_CHECK_URL?.replace(/\/+$/, "");
  if (!baseUrl) {
    console.error(
      "Set UI_CHECK_URL to a web server running with VITE_API_MOCK=true, e.g. UI_CHECK_URL=http://localhost:3225",
    );
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        // Dialogs must not be caught mid-fade by axe or the screenshot.
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.__baseUrl = baseUrl;
      page.setDefaultTimeout(WAIT_TIMEOUT);
      page.setDefaultNavigationTimeout(WAIT_TIMEOUT);
      let step = viewport.label;
      try {
        await page.addInitScript(() =>
          localStorage.setItem("legend-theme", "light"),
        );
        await openPanel(page);
        if (
          !(await report(`list-${viewport.label}`, page, axe)) &&
          !failures.includes(`list-${viewport.label}`)
        )
          failures.push(`list-${viewport.label}`);
        await page.screenshot({
          path: join(OUT_DIR, `820-perangkat-${viewport.label}.png`),
          fullPage: true,
        });

        if (viewport.label === "390") {
          step = "dialog-390";
          // The second row is the phone whose session ended (the warning case).
          await page
            .getByRole("button", { name: REVOKE_BUTTON })
            .last()
            .click();
          await page
            .getByRole("dialog")
            .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
          if (!(await report("dialog-390", page, axe)))
            failures.push("dialog-390");
          await page.screenshot({
            path: join(OUT_DIR, "820-perangkat-dialog-390.png"),
          });
        }
      } catch (error) {
        console.log(
          `FAIL ${step}: ${error instanceof Error ? error.message : error}`,
        );
        await page
          .screenshot({
            path: join(OUT_DIR, `820-perangkat-${step}.error.png`),
            fullPage: true,
          })
          .catch(() => {});
        failures.push(step);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(
    failures.length === 0
      ? "\nAll checks passed."
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
