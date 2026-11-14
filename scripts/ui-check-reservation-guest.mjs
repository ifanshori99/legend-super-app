#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate callbacks */
// UI check for the guest "kelola reservasi" page (bead legend-g12il).
//
// For each of the 16 mockup states (design/mockups/reservation-guest), at
// 1280x900 and 390x844: open `/reservasi/kelola?demo=<scenario>#<token>` in mock
// mode, drive the page to the state, run axe (wcag2a, wcag2aa, wcag21aa,
// wcag22aa) and save a full-page screenshot to
// docs/screenshots/reservation-guest/<state>-<1280|390>.png. Every state is also
// opened at 320px (no screenshot) to check there is no horizontal scroll.
//
//   UI_CHECK_URL=http://localhost:3225 heavy node scripts/ui-check-reservation-guest.mjs
//   UI_CHECK_URL=... node scripts/ui-check-reservation-guest.mjs detail late   (subset)
//
// UI_CHECK_URL must be a web server started with VITE_API_MOCK=true (see
// playwright.mock.config.ts). Never point it at a real deployment.
//
// Static states come from `?demo=` (features/ws08-reservation-guest/mock.ts).
// reschedule, validation, submitting, cancel, cancel-late and cancelled-late are
// reached by clicking, like a guest would. loading uses `?mock=slow` (3 s mock
// latency). Each state gets a fresh browser context, so the in-browser mock
// store starts clean. The page is public: no role cookie is needed.
//
// axe: `@axe-core/playwright` when installed, else the `axe-core` bundle in
// node_modules/.pnpm, else the script stops with a message (do not add a
// dependency without asking).
//
// Output: one line per state/viewport, then a JSON summary (axe serious or
// critical violations and horizontal overflow). Exit 1 on any failure.
import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/screenshots/reservation-guest");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 900, screenshot: true },
  { label: "390", width: 390, height: 844, screenshot: true },
  { label: "320", width: 320, height: 844, screenshot: false },
];
const COLD_TIMEOUT = 45_000; // Vite compiles a route on its first request.
// A valid-shaped link token: 43 base64url characters (fixture, not a secret).
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";
const OUTLET_ZONE = "Asia/Jakarta";
const DAY_MS = 86_400_000;
// Mockup fixture for the reschedule screenshot.
const RESCHEDULE_DATE = "2026-11-19";
const RESCHEDULE_TIME = "19:30";
const RESCHEDULE_NOTE = "Ada perubahan rencana, kami ingin datang besok malam.";

// States. `demo` picks the mock scenario; `slow` adds `?mock=slow`. `prepare`
// drives the state and must end on something visible that proves it.
const STATES = [
  {
    name: "detail",
    demo: "detail",
    prepare: (p) => heading(p, "Kelola reservasi Anda"),
  },
  {
    name: "reschedule",
    demo: "detail",
    prepare: async (p) => {
      await openReschedule(p);
      await fillSchedule(p, RESCHEDULE_DATE, RESCHEDULE_TIME);
      await p.locator('textarea[name="request-note"]').fill(RESCHEDULE_NOTE);
      await heading(p, "Kapan ingin datang?");
      await settle(p);
    },
  },
  {
    name: "validation",
    demo: "detail",
    prepare: async (p) => {
      await openReschedule(p);
      // A date in the past with a time: the form must refuse it on submit.
      await fillSchedule(p, daysFromToday(-2));
      await clickButton(p, "Kirim permintaan");
      await heading(p, "Periksa tanggal baru");
      await settle(p);
    },
  },
  {
    name: "submitting",
    demo: "detail",
    prepare: async (p) => {
      await openReschedule(p);
      await fillSchedule(p, RESCHEDULE_DATE, RESCHEDULE_TIME);
      // Keep the request in flight so the screen stays on "sending".
      await p.evaluate(() => window.__legendMock.setLatencyMs(60_000));
      await clickButton(p, "Kirim permintaan");
      await heading(p, "Mengirim jadwal baru");
    },
  },
  {
    name: "pending",
    demo: "pending",
    prepare: (p) => heading(p, "Permintaan sudah terkirim"),
  },
  {
    name: "approved",
    demo: "approved",
    prepare: (p) => heading(p, "Jadwal baru sudah dikonfirmasi"),
  },
  {
    name: "rejected",
    demo: "rejected",
    prepare: (p) => heading(p, "Jadwal baru tidak disetujui"),
  },
  {
    name: "late",
    demo: "late",
    prepare: (p) => heading(p, "Jadwal sudah tidak bisa diubah"),
  },
  {
    name: "cancel",
    demo: "detail",
    prepare: async (p) => {
      await clickButton(p, /^Batalkan reservasi$/);
      await heading(p, "Batalkan reservasi?");
      await text(p, "DP dapat dikembalikan penuh");
    },
  },
  {
    name: "cancel-late",
    demo: "late",
    prepare: async (p) => {
      await clickButton(p, "Tinjau pembatalan");
      await heading(p, "Batalkan reservasi?");
      await text(p, "Periksa potongan sebelum melanjutkan");
    },
  },
  {
    name: "cancelled",
    demo: "cancelled",
    prepare: (p) => heading(p, "Reservasi Anda dibatalkan"),
  },
  {
    name: "cancelled-late",
    demo: "cancelled-late",
    prepare: async (p) => {
      await heading(p, "Jadwal sudah tidak bisa diubah");
      await clickButton(p, "Tinjau pembatalan");
      await clickButton(p, /^Batalkan dengan potongan/);
      await heading(p, "Reservasi Anda dibatalkan");
      await text(p, "DP tidak dikembalikan", { optional: true });
    },
  },
  {
    name: "invalid",
    demo: "invalid",
    prepare: (p) => heading(p, "Reservasi belum bisa dibuka"),
  },
  {
    name: "loading",
    demo: "detail",
    slow: true,
    // Skeleton only: the heading is plain text and the body is aria-busy.
    prepare: async (p) => {
      await p
        .locator('[aria-busy="true"]')
        .first()
        .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
      await text(p, "Memuat reservasi Anda");
    },
  },
  {
    name: "error",
    demo: "error",
    prepare: (p) => heading(p, "Status belum bisa dimuat"),
  },
  {
    name: "rate-limit",
    demo: "rate-limit",
    prepare: (p) => heading(p, "Terlalu banyak percobaan"),
  },
];

// ---- helpers -----------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function matcher(value) {
  return typeof value === "string" ? new RegExp(escapeRegExp(value)) : value;
}

/** YYYY-MM-DD, `days` from today, in the outlet's zone. */
function daysFromToday(days) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: OUTLET_ZONE }).format(
    new Date(Date.now() + days * DAY_MS),
  );
}

async function heading(page, name) {
  await page
    .getByRole("heading", { name: matcher(name) })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
async function text(page, value, { optional = false } = {}) {
  try {
    await page
      .getByText(matcher(value))
      .first()
      .waitFor({ state: "visible", timeout: optional ? 3_000 : COLD_TIMEOUT });
  } catch (error) {
    if (!optional) throw error;
  }
}
async function clickButton(page, name) {
  const button = page.getByRole("button", { name: matcher(name) }).first();
  await button.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await button.click();
}

/** From the detail screen to the reschedule form. */
async function openReschedule(page) {
  await clickButton(page, "Ajukan jadwal baru");
  await heading(page, "Kapan ingin datang?");
}

/**
 * Fills the date, then a time: a slot radio when the public availability
 * offers some (the one matching `time`, else the first), otherwise the plain
 * time input.
 */
async function fillSchedule(page, date, time = "19:00") {
  await page.locator('input[name="requested-date"]').fill(date);
  const field = page.locator('input[name="requested-time"]').first();
  await field.waitFor({ state: "attached", timeout: COLD_TIMEOUT });
  const type = await field.getAttribute("type");
  if (type === "radio") {
    const chip = page.locator(`input[name="requested-time"][value="${time}"]`);
    await ((await chip.count()) > 0 ? chip : field).first().check({
      force: true,
    });
  } else await field.fill(time);
}

/** Drops focus and hover so no button is captured in its hover/focus style. */
async function settle(page) {
  await page.evaluate(() => {
    document.activeElement?.blur?.();
  });
  await page.mouse.move(0, 0);
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

async function waitForHydration(page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: COLD_TIMEOUT },
  );
}

/** Horizontal overflow of the page: widest content versus the viewport. */
async function measureOverflow(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      overflows: root.scrollWidth > root.clientWidth + 1,
    };
  });
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
  const summary = [];
  try {
    for (const state of states) {
      for (const viewport of VIEWPORTS) {
        const id = `${state.name}-${viewport.label}`;
        const entry = { state: state.name, viewport: viewport.label };
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        const page = await context.newPage();
        try {
          const query = `demo=${state.demo}${state.slow ? "&mock=slow" : ""}`;
          await page.goto(`${baseUrl}/reservasi/kelola?${query}#${TOKEN}`, {
            waitUntil: "domcontentloaded",
          });
          // The loading screenshot is taken before the slow mock answers.
          if (!state.slow) await waitForHydration(page);
          await state.prepare(page);
          const violations = await axe.run(page);
          const blocking = violations.filter((v) =>
            BLOCKING_IMPACTS.has(v.impact ?? ""),
          );
          const overflow = await measureOverflow(page);
          await settle(page);
          if (viewport.screenshot)
            await page.screenshot({
              path: join(OUT_DIR, `${id}.png`),
              fullPage: true,
            });
          entry.axeBlocking = blocking.map((v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.length,
            targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
          }));
          entry.axeOther = violations.length - blocking.length;
          entry.overflow = overflow;
          entry.ok = blocking.length === 0 && !overflow.overflows;
        } catch (error) {
          entry.ok = false;
          entry.error = error instanceof Error ? error.message : String(error);
          if (viewport.screenshot)
            await page
              .screenshot({
                path: join(OUT_DIR, `${id}.error.png`),
                fullPage: true,
              })
              .catch(() => {});
        } finally {
          await context.close();
        }
        console.log(`${entry.ok ? "PASS" : "FAIL"} ${id}`);
        summary.push(entry);
      }
    }
  } finally {
    await browser.close();
  }
  const failed = summary.filter((e) => !e.ok);
  console.log(
    JSON.stringify(
      {
        checks: summary.length,
        failed: failed.length,
        axeSeriousOrCritical: summary.reduce(
          (n, e) => n + (e.axeBlocking?.length ?? 0),
          0,
        ),
        overflow: summary
          .filter((e) => e.overflow?.overflows)
          .map((e) => `${e.state}-${e.viewport}`),
        results: summary,
      },
      null,
      2,
    ),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
