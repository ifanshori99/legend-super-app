#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate / init-script callbacks */
// UI check for the HR review of attendance on an approved leave day
// (bead legend-3jem1), screen /kelola/absensi/tinjauan-cuti.
//
// For every state below, at 390x844 and 1280x800: open the page in mock mode,
// drive it to the state, run axe (wcag2a, wcag2aa, wcag21aa, wcag22aa), fail on
// serious/critical violations, and save a screenshot to
// docs/design/screenshots/legend-3jem1/axe-<state>-<390|1280>.png.
//
//   UI_CHECK_URL=http://localhost:3225 heavy node scripts/ui-check-leave-clockin.mjs
//   UI_CHECK_URL=... node scripts/ui-check-leave-clockin.mjs queue empty   (subset)
//
// UI_CHECK_URL must be a web server started with VITE_API_MOCK=true (for
// example the one `pnpm test:e2e:mock` starts, see playwright.mock.config.ts).
// Never point it at a real deployment: mock mode serves fixtures.
//
// States 1-10 (design/mockups/hr-leave-clockin-review/README.md, plus the two
// result screens): queue, detail, confirm-keep, confirm-cancel, result-keep,
// result-cancel, no-cancel-right, manual-correction, re-review, empty. Extra
// states: loading, offline, error, confirm-failed.
//
// Mock switches and clock are the ones e2e/legend-3jem1.mock.spec.ts uses:
//   ?mock=empty | error | slow           standard lib/mock/control.ts scenarios
//   ?leaveRights=keep-only + localStorage["legend-mock-leave-rights"]="keep-only"
//     reviewer holds hr.attendance.manage but not hr.leave.approve
//   window.__legendMock.failNext("POST /api/hris/attendance/logs/:logId/review", ...)
//     one-shot failure of the decision request
//   page.clock.setFixedTime(2026-10-26T10:00Z)  browser clock frozen on the fixture day
// Session: no login in mock mode; no cookie = role "all" (HR), as in ui-check.mjs.
// Each state gets a fresh browser context, so the in-browser mock store (decided
// cases) starts clean every time.
//
// axe: uses `@axe-core/playwright` when installed, else injects the `axe-core`
// bundle found in node_modules/.pnpm (same fallback as scripts/ui-check.mjs).
import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/design/screenshots/legend-3jem1");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "390", width: 390, height: 844 },
  { label: "1280", width: 1280, height: 800 },
];
const WAIT_TIMEOUT = 10_000; // Hard cap for every wait; a state that needs more has failed.
const FIXTURE_CLOCK = new Date("2026-10-26T10:00:00.000Z"); // 17:00 WIB
const QUEUE_PATH = "/kelola/absensi/tinjauan-cuti";
const CASE_COUNT = 4;
const DESKTOP = { width: 1280, height: 800 };
const REVIEW_LINK = /^Tinjau(\s|$)/;
const DECISION_PATH = "POST /api/hris/attendance/logs/:logId/review";
const NO_CANCEL_RIGHT =
  "Anda tidak memiliki hak untuk membatalkan cuti. Minta HR yang berwenang meninjau keputusan ini.";

/** What each fixture case says in its queue row (same matchers as the e2e spec). */
const CASE_MATCH = {
  reReview: (text) => text.includes("Perlu ditinjau ulang"),
  manual: (text) =>
    text.includes("Koreksi absen manual") &&
    !text.includes("Perlu ditinjau ulang"),
  single: (text) =>
    text.includes("Belum absen keluar") &&
    !text.includes("Koreksi absen manual") &&
    !text.includes("Perlu ditinjau ulang"),
  annual: (text) =>
    text.includes("Absen saat cuti") &&
    text.includes("Cuti tahunan") &&
    !text.includes("Belum absen keluar") &&
    !text.includes("Koreksi absen manual") &&
    !text.includes("Perlu ditinjau ulang"),
};

// ---- states ------------------------------------------------------------------
// `run(page, viewport)` opens the page itself (detail states need the queue
// first) and must finish with something visible that proves the state is on
// screen.

const STATES = [
  {
    name: "queue",
    run: async (page) => {
      await openQueue(page);
      await expectText(page, "Tinjau absensi yang memerlukan keputusan HR.");
    },
  },
  {
    name: "detail",
    run: async (page, viewport) => {
      await openDetail(page, "annual", viewport);
      await expectText(page, "Hanya cuti pada tanggal ini yang dibatalkan");
    },
  },
  {
    name: "confirm-keep",
    run: async (page, viewport) => {
      await openDetail(page, "single", viewport);
      await keepButton(page).click();
      await expectDialog(page, "Tetap cuti untuk tanggal ini?");
    },
  },
  {
    name: "confirm-cancel",
    run: async (page, viewport) => {
      await openDetail(page, "annual", viewport);
      await cancelButton(page).click();
      await expectDialog(page, "Batalkan cuti hari ini dan hitung hadir?");
    },
  },
  {
    name: "result-keep",
    run: async (page, viewport) => {
      await openDetail(page, "single", viewport);
      await keepButton(page).click();
      await dialogButton(page, "Tetap cuti").click();
      await expectText(page, "Keputusan tersimpan");
    },
  },
  {
    name: "result-cancel",
    run: async (page, viewport) => {
      await openDetail(page, "annual", viewport);
      await cancelButton(page).click();
      await dialogButton(page, "Batalkan cuti hari ini").click();
      await expectText(page, "Cuti hari ini dibatalkan");
    },
  },
  {
    name: "no-cancel-right",
    run: async (page, viewport) => {
      await page.addInitScript(() =>
        localStorage.setItem("legend-mock-leave-rights", "keep-only"),
      );
      await openDetail(page, "annual", viewport, "?leaveRights=keep-only");
      await expectText(page, NO_CANCEL_RIGHT);
      if (!(await cancelButton(page).isDisabled()))
        throw new Error("cancel button is enabled without the right");
    },
  },
  {
    name: "manual-correction",
    run: async (page, viewport) => {
      await openDetail(page, "manual", viewport);
      await expectText(
        page,
        "Pembatalan selalu satu hari penuh, bukan setengah hari.",
      );
    },
  },
  {
    // Queue row that came back after a new approved leave (README state 8).
    name: "re-review",
    run: async (page) => {
      await openQueue(page);
      await expectText(page, "Perlu ditinjau ulang: ada cuti baru disetujui");
    },
  },
  {
    name: "empty",
    run: async (page) => {
      await openQueue(page, "?mock=empty", { expectCases: false });
      await expectText(page, "Tidak ada tinjauan absensi");
    },
  },
  {
    // Mock "slow" answers after 3 seconds: the skeleton is on screen.
    name: "loading",
    run: async (page) => {
      await openQueue(page, "?mock=slow", {
        expectCases: false,
        hydrate: false,
        title: false,
      });
      // DataTableShell loading state: the region is busy and says "Memuat…".
      const region = page.getByRole("region", { name: "Perlu ditinjau" });
      await region.waitFor({ state: "attached", timeout: WAIT_TIMEOUT });
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("[aria-busy='true']")).some(
            (el) => el.textContent?.includes("Memuat…"),
          ),
        undefined,
        { timeout: WAIT_TIMEOUT },
      );
    },
  },
  {
    // The connection drops after the queue loaded (navigator.onLine).
    name: "offline",
    run: async (page) => {
      await openQueue(page);
      await page.context().setOffline(true);
      await expectText(page, "Anda sedang offline");
    },
  },
  {
    name: "error",
    run: async (page) => {
      await openQueue(page, "?mock=error", { expectCases: false });
      await expectText(page, "Tinjauan absensi tidak dapat dimuat");
      await page
        .getByRole("button", { name: "Coba lagi" })
        .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
    },
  },
  {
    // The decision request fails once: error inside the open dialog.
    name: "confirm-failed",
    run: async (page, viewport) => {
      await openDetail(page, "single", viewport);
      await page.evaluate(
        ([match, value]) => {
          window.__legendMock.failNext(match, value);
        },
        [DECISION_PATH, { status: 409, code: "ATTENDANCE_LEAVE_NOT_APPROVED" }],
      );
      await keepButton(page).click();
      await dialogButton(page, "Tetap cuti").click();
      await page
        .getByRole("dialog")
        .getByText(/Tidak ada cuti disetujui pada hari itu\./)
        .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
    },
  },
];

// ---- helpers -----------------------------------------------------------------

function reviewLinks(page) {
  return page.getByRole("link", { name: REVIEW_LINK });
}
function keepButton(page) {
  return page.getByRole("button", { name: "Tetap cuti", exact: true });
}
function cancelButton(page) {
  return page.getByRole("button", {
    name: "Batalkan cuti hari ini, hitung hadir",
    exact: true,
  });
}
function dialogButton(page, name) {
  return page.getByRole("dialog").getByRole("button", { name, exact: true });
}

/** Only matches a user can see (the hidden table/card twin is ignored). */
function seen(locator) {
  return locator.filter({ visible: true });
}

async function expectText(page, text) {
  await seen(page.getByText(text))
    .first()
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
}
async function expectDialog(page, heading) {
  await page
    .getByRole("dialog")
    .getByRole("heading", { name: heading })
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
}

async function waitForHydration(page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: WAIT_TIMEOUT },
  );
  // Every control in the main area carries React props (same as the e2e spec).
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

/** Goes to the queue and waits for its heading (and, by default, the 4 cases). */
async function openQueue(
  page,
  query = "",
  { expectCases = true, hydrate = true, title = true } = {},
) {
  await page.goto(`${page.__baseUrl}${QUEUE_PATH}${query}`, {
    waitUntil: "domcontentloaded",
  });
  // The shell owns the page's h1 (the menu label); the screen title is an h2.
  if (title)
    await page
      .getByRole("heading", { level: 2, name: /Tinjauan/ })
      .first()
      .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
  if (expectCases) {
    await reviewLinks(page).first().waitFor({
      state: "visible",
      timeout: WAIT_TIMEOUT,
    });
    if ((await reviewLinks(page).count()) !== CASE_COUNT)
      throw new Error(`queue does not show ${CASE_COUNT} cases`);
  }
  if (hydrate) await waitForHydration(page);
}

/**
 * Opens the queue on desktop (the case is found by the index its table row has),
 * switches to the target viewport and follows that case's "Tinjau" link.
 */
async function openDetail(page, kind, viewport, query = "") {
  await page.setViewportSize(DESKTOP);
  await openQueue(page, query);
  const rows = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: REVIEW_LINK }) });
  const texts = await rows.allInnerTexts();
  const index = texts.findIndex(CASE_MATCH[kind]);
  if (index < 0) throw new Error(`queue has no "${kind}" case`);
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  await reviewLinks(page).nth(index).click();
  await page
    .getByRole("heading", { name: "Tinjau absensi saat cuti" })
    .waitFor({ state: "visible", timeout: WAIT_TIMEOUT });
  await waitForHydration(page);
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

// ---- main --------------------------------------------------------------------

async function main() {
  const baseUrl = process.env.UI_CHECK_URL?.replace(/\/+$/, "");
  if (!baseUrl) {
    console.error(
      "Set UI_CHECK_URL to a web server running with VITE_API_MOCK=true, e.g. UI_CHECK_URL=http://localhost:3225",
    );
    process.exit(2);
  }
  const only = new Set(process.argv.slice(2));
  const states = STATES.filter((s) => only.size === 0 || only.has(s.name));
  if (states.length === 0) {
    console.error(`No state matches: ${[...only].join(", ")}`);
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  try {
    for (const state of states) {
      for (const viewport of VIEWPORTS) {
        const id = `${state.name}-${viewport.label}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          // Dialogs must not be caught mid-fade by axe or the screenshot.
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        page.__baseUrl = baseUrl;
        try {
          page.setDefaultTimeout(WAIT_TIMEOUT);
          page.setDefaultNavigationTimeout(WAIT_TIMEOUT);
          await page.addInitScript(() =>
            localStorage.setItem("legend-theme", "light"),
          );
          await page.clock.setFixedTime(FIXTURE_CLOCK);
          await state.run(page, viewport);
          const violations = await axe.run(page);
          const blocking = violations.filter((v) =>
            BLOCKING_IMPACTS.has(v.impact ?? ""),
          );
          await page.screenshot({
            path: join(OUT_DIR, `axe-${id}.png`),
            fullPage: true,
          });
          if (blocking.length === 0) {
            console.log(
              `PASS ${id}${violations.length ? ` (${violations.length} minor/moderate)` : ""}`,
            );
          } else {
            console.log(`FAIL ${id}`);
            for (const v of blocking) {
              console.log(
                `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node)`,
              );
              for (const node of v.nodes.slice(0, 3))
                console.log(`    ${node.target.join(" ")}`);
            }
            failures.push(id);
          }
        } catch (error) {
          console.log(
            `FAIL ${id}: ${error instanceof Error ? error.message : error}`,
          );
          await page
            .screenshot({
              path: join(OUT_DIR, `axe-${id}.error.png`),
              fullPage: true,
            })
            .catch(() => {});
          failures.push(id);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(
    failures.length === 0
      ? `\nAll ${states.length * VIEWPORTS.length} checks passed.`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
