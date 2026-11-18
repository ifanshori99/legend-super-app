#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate / addInitScript callbacks */
// UI check for POS payment extras (brief docs/briefs/sub-936-pos-payment.md,
// bead legend-5w6): voucher panel, points panel, EDC declined, facility ticket
// sale (/pos/tiket) and the customer-display QRIS provider label (Duitku).
// Modeled on scripts/ui-check-pos-u2.mjs.
//
// For every screen/state below, in light and dark, at 360x800 and 1280x800:
// open the page in mock mode, drive it to the state, run axe (wcag2a, wcag2aa,
// wcag21aa, wcag22aa), fail on serious/critical violations or horizontal
// scroll, and save a full-page screenshot to
// design/screenshots/pos-936/<screen>-<state>-<light|dark>-<360|1280>.png.
//
//   UI_CHECK_URL=http://localhost:3225 heavy node scripts/ui-check-936.mjs
//   UI_CHECK_URL=... node scripts/ui-check-936.mjs voucher
//   UI_CHECK_URL=... node scripts/ui-check-936.mjs edc-ditolak --theme=dark
//
// A subset argument is a screen ("voucher"), a screen-state ("voucher-valid")
// or a part ("A".."D"). Flags: --theme=light|dark.
//
// UI_CHECK_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts). Never point it at a real deployment.
//
// Text matchers follow the pos-kasir-voucher/points/edc/payment catalogs in
// packages/shared/src/i18n/messages. The demo constants below are read from the
// mocks (mock-engine.ts, demo-seed.ts, ws04-display/mock.ts); change them there
// first. The ticket matchers (part C) are still loose regexes.
//
// Session: no login in mock mode (role "all"). Each state gets a fresh browser
// context, so the in-browser mock store starts clean. Theme is the
// `legend-theme` localStorage key. The browser runs in Asia/Jakarta.
import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "design/screenshots/pos-936");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const MOBILE = { label: "360", width: 360, height: 800 };
const DESKTOP = { label: "1280", width: 1280, height: 800 };
const VIEWPORTS = [MOBILE, DESKTOP];
const THEMES = ["light", "dark"];
const THEME_KEY = "legend-theme"; // THEME_STORAGE_KEY in packages/shared/src/theme
const COLD_TIMEOUT = 45_000; // Vite compiles a route on its first request.

// Demo order (features/ws04-pos-kasir/demo-seed.ts): Meja A12, POS-0048.
const ORDER_UUID = "0b0b0048-0000-4000-8000-000000000048";
const BAYAR = `/pos/bayar/${ORDER_UUID}`;

// ---- demo data (read from the mocks) ----------------------------------------
// Voucher codes: DEMO_VOUCHERS, DEMO_VOUCHER_EXPIRED, DEMO_VOUCHER_REDEEMED in
// features/ws04-pos-kasir/mock-engine.ts.
const VOUCHER_OK = "HEMAT20";
const VOUCHER_EXPIRED = "EXPIRED1";
const VOUCHER_USED = "PAKAI001";
// The demo bill (POS-0048) carries member Rina Kusuma with 12.500 points
// (DEMO_MEMBER, DEMO_POINTS_BALANCE); minimum redeem is 1.000 points.
// Code order LG-0044 ("Bayar di kasir") has no member: the "no member" panel.
const CODE_ORDER_UUID = "0b0b0044-0000-4000-8000-000000000044";
const BAYAR_NO_MEMBER = `/pos/bayar/${CODE_ORDER_UUID}`;
// `?demo=` seed in demo-seed.ts: a declined EDC attempt on terminal edc-02
// (EDC_DECLINING_TERMINAL_ID), reason "Saldo tidak cukup", code 51.
const DEMO_EDC_DECLINED = "edc-ditolak";
// localStorage["legend-display-mock"] value in features/ws04-display/mock.ts
// whose QRIS wire has provider "duitku".
const DISPLAY_DUITKU = "awaiting_duitku";
const DISPLAY = "/pos/customer-display";
const TICKET = "/pos/tiket";

// ---- screens -----------------------------------------------------------------
// Fields: `part` (A..D of the brief), `screen` + `state` name the png, `path` is
// opened first, `prepare` drives the state and must end with something that
// proves it. `viewports` / `themes` narrow the matrix; `noHydration` skips the
// hydration wait (loading states never settle); `localStorage` is written
// before load.
const SCREENS = [];

function add(screen) {
  SCREENS.push({ viewports: VIEWPORTS, themes: THEMES, ...screen });
}

// ---- B voucher ---------------------------------------------------------------
const V = { part: "B", screen: "voucher" };

async function openVoucher(p) {
  // Adjust button (posKasirPayment.adjust.voucher); the page heading becomes
  // posKasirPayment.heading.voucher and the panel title posKasirVoucher.title.
  await clickControl(p, /Pakai voucher/i);
  await expectHeading(p, /Voucher/i);
}
/** Types a code into the voucher input and presses "Cek". */
async function checkVoucher(p, code) {
  await openVoucher(p);
  await fillField(p, /Kode voucher/i, code);
  await clickControl(p, /^\s*Cek\s*$/i);
}

add({
  ...V,
  state: "awal",
  path: BAYAR,
  prepare: async (p) => {
    await openVoucher(p);
    await p
      .getByLabel(/Kode voucher/i)
      .filter({ visible: true })
      .first()
      .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  },
});
add({
  ...V,
  state: "valid",
  path: BAYAR,
  prepare: async (p) => {
    await checkVoucher(p, VOUCHER_OK);
    // Discount shown is the server preview (a Rupiah amount), never UI math.
    await expectText(p, /Voucher berlaku/i);
    await expectText(p, /Potongan\s+Rp\s?[\d.]+/);
    await expectButton(p, /^\s*Pakai voucher\s*$/i);
  },
});
add({
  ...V,
  state: "kedaluwarsa",
  path: BAYAR,
  prepare: async (p) => {
    await checkVoucher(p, VOUCHER_EXPIRED);
    await expectText(p, /Voucher tidak bisa dipakai/i);
    await expectText(p, /Voucher sudah kedaluwarsa\./i);
  },
});
add({
  ...V,
  state: "terpakai",
  path: BAYAR,
  prepare: async (p) => {
    await checkVoucher(p, VOUCHER_USED);
    await expectText(p, /Voucher tidak bisa dipakai/i);
    await expectText(p, /Voucher ini sudah dipakai\./i);
  },
});
add({
  ...V,
  state: "terapkan",
  path: BAYAR,
  // After "Pakai voucher" the bill column shows the voucher line (I5b).
  prepare: async (p) => {
    await checkVoucher(p, VOUCHER_OK);
    await expectButton(p, /^\s*Pakai voucher\s*$/i);
    // The adjust button "Pakai voucher" (side column) has the same name as the
    // panel's apply button; the apply button comes last in the DOM.
    await p
      .getByRole("button", { name: /^\s*Pakai voucher\s*$/i })
      .last()
      .click();
    // posKasirPayment.bill.voucher: "Voucher {code}".
    await expectText(p, new RegExp(`Voucher ${VOUCHER_OK}`));
  },
});
add({
  ...V,
  state: "memuat",
  path: `${BAYAR}?mock=slow`,
  noHydration: true,
  prepare: (p) => expectBusy(p),
});

// ---- A points ----------------------------------------------------------------
const PT = { part: "A", screen: "poin" };

async function openPoints(p) {
  // Adjust button (posKasirPayment.adjust.points); the page heading becomes
  // posKasirPayment.heading.points and the panel title posKasirPoints.title.
  await clickControl(p, /Tukar poin/i);
  await expectHeading(p, /^Tukar poin/i);
}

add({
  ...PT,
  state: "kosong",
  // Code order LG-0044 has no member: the panel must say so, not stay blank.
  path: BAYAR_NO_MEMBER,
  prepare: async (p) => {
    await openPoints(p);
    await expectText(p, /Pesanan ini belum punya member/i);
  },
});
add({
  ...PT,
  state: "saldo",
  path: BAYAR,
  prepare: async (p) => {
    await openPoints(p);
    await expectText(p, /Rina Kusuma/);
    await expectText(p, /12\.500 poin/);
    await expectButton(p, /^\s*Tukar poin\s*$/i);
  },
});
add({
  ...PT,
  state: "nilai",
  path: BAYAR,
  prepare: async (p) => {
    await openPoints(p);
    await fillField(p, /Jumlah poin/i, "5000");
    await clickControl(p, /^\s*Hitung nilai\s*$/i);
    await expectText(p, /5\.000 poin bernilai/i);
  },
});
add({
  ...PT,
  state: "memuat",
  path: `${BAYAR}?mock=slow`,
  noHydration: true,
  prepare: (p) => expectBusy(p),
});
add({
  ...PT,
  state: "gagal",
  // ?mock=error would fail the payment session too. The points lookup goes
  // through the POS engine (no typed endpoint), so the scenario is switched to
  // "error" only after the page loaded, right before the panel opens.
  path: BAYAR,
  prepare: async (p) => {
    await expectHeading(p, /Pembayaran|Pilih/i);
    await setScenario(p, "error");
    await openPoints(p);
    await expectText(p, /Poin member belum bisa dimuat/i);
    await expectButton(p, /^\s*Coba lagi\s*$/i);
  },
});

// ---- D EDC declined ----------------------------------------------------------
add({
  part: "D",
  screen: "edc-ditolak",
  state: "normal",
  path: `${BAYAR}?demo=${DEMO_EDC_DECLINED}`,
  prepare: async (p) => {
    await expectHeading(p, /Pembayaran ditolak/i);
    // Reason comes from the server (demo: "Saldo tidak cukup", code 51).
    await expectText(p, /Saldo tidak cukup/i);
    await expectButton(p, /Coba lagi di terminal/i);
    await expectButton(p, /Pilih metode lain/i);
  },
});

// ---- D customer display QRIS provider ----------------------------------------
add({
  part: "D",
  screen: "display-qris",
  state: "duitku",
  path: DISPLAY,
  localStorage: { "legend-display-mock": DISPLAY_DUITKU },
  prepare: async (p) => {
    await expectText(p, /Duitku/);
    await expectText(p, /Berlaku \d+:\d{2} lagi/);
    const doit = await p.getByText(/DOIT/).filter({ visible: true }).count();
    if (doit > 0) throw new Error("hard-coded DOIT label still visible");
  },
});

// ---- C facility ticket -------------------------------------------------------
const T = { part: "C", screen: "tiket" };

/** Picks a product and a customer where the form offers them, then sells. */
async function sellTicket(p) {
  await expectHeading(p, /Tiket/i);
  const product = p
    .locator('[role="radio"], [role="option"], [data-product], li button')
    .filter({ visible: true })
    .first();
  await product.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await product.click();
  // The label "Cari nama pelanggan" also names the panel section, so go through
  // the search box role only; results are buttons "Pilih {name}".
  const search = p.getByRole("searchbox").filter({ visible: true }).first();
  await search.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await search.fill("an");
  const hit = p
    .getByRole("button", { name: /^Pilih (?!jam )/ })
    .filter({ visible: true })
    .first();
  await hit.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await hit.click();
  await clickControl(p, /^\s*Jual\b|Terbitkan/i);
}

add({
  ...T,
  state: "pilih",
  path: TICKET,
  prepare: async (p) => {
    await expectHeading(p, /Tiket/i);
    await expectButton(p, /Jual|Terbitkan/i);
  },
});
add({
  ...T,
  state: "terbit",
  path: TICKET,
  prepare: async (p) => {
    await sellTicket(p);
    await expectText(p, /terbit|berhasil/i);
    await expectButton(p, /Cetak tiket/i);
  },
});
add({
  ...T,
  state: "cetak",
  path: TICKET,
  prepare: async (p) => {
    await sellTicket(p);
    await clickControl(p, /Cetak tiket/i);
    await expectText(p, /dicetak|mencetak|antrean cetak/i);
  },
});
add({
  ...T,
  state: "memuat",
  path: `${TICKET}?mock=slow`,
  noHydration: true,
  prepare: (p) => expectBusy(p),
});
add({
  ...T,
  state: "kosong",
  path: `${TICKET}?mock=empty`,
  prepare: (p) => expectText(p, /Belum ada|Tidak ada/i),
});
add({
  ...T,
  state: "gagal",
  path: `${TICKET}?mock=error`,
  prepare: (p) => expectButton(p, /Coba lagi/i),
});

// ---- helpers -----------------------------------------------------------------

function textMatcher(text) {
  return typeof text === "string" ? new RegExp(escapeRegExp(text)) : text;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// All waits target visible elements only: POS screens render both a desktop and
// a mobile variant of some blocks, and one of them is display:none.
async function expectText(page, text, timeout = COLD_TIMEOUT) {
  await page
    .getByText(textMatcher(text))
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout });
}
async function expectHeading(page, text) {
  await page
    .getByRole("heading", { name: textMatcher(text) })
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
async function expectButton(page, name) {
  await page
    .getByRole("button", { name })
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
/**
 * Waits for finite animations (dialog fade/zoom) to end: axe must not sample
 * the contrast of a half-transparent dialog. Looping skeleton pulses are left.
 */
async function settle(page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
  });
  await page.waitForTimeout(100);
}
async function expectBusy(page) {
  await page
    .locator('[aria-busy="true"]')
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
/** Clicks a button/radio/tab/link by its visible text. */
async function clickControl(page, name) {
  const control = page
    .locator('button, [role="radio"], [role="tab"], [role="switch"], a')
    .filter({ hasText: name })
    .filter({ visible: true })
    .first();
  await control.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await control.click();
}
/** Fills the input whose label matches. */
async function fillField(page, label, value) {
  const field = page.getByLabel(label).filter({ visible: true }).first();
  await field.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await field.fill(value);
}
/** window.__legendMock is installed when the mock runtime boots. */
async function setScenario(page, scenario) {
  await page.waitForFunction(() => Boolean(window.__legendMock), undefined, {
    timeout: COLD_TIMEOUT,
  });
  await page.evaluate(
    (value) => window.__legendMock.setScenario(value),
    scenario,
  );
}

/**
 * Before any script of the page runs: theme and per-screen localStorage, and
 * endpoints that fail from their first call. The failures are queued the moment
 * the mock runtime assigns `window.__legendMock` (a setter), so they are in
 * place before the first request; six per endpoint outlast the query retries.
 */
async function prepareContext(page, theme, screen) {
  await page.addInitScript(
    ({ themeKey, themeValue, entries, failIds }) => {
      try {
        localStorage.setItem(themeKey, themeValue);
        for (const [key, value] of Object.entries(entries))
          localStorage.setItem(key, value);
      } catch {
        // storage blocked: the page still loads in its default theme
      }
      if (failIds.length === 0) return;
      let control;
      Object.defineProperty(window, "__legendMock", {
        configurable: true,
        get: () => control,
        set: (value) => {
          control = value;
          for (const id of failIds)
            for (let i = 0; i < 6; i += 1)
              value.failNext(id, {
                status: 503,
                code: "SERVICE_UNAVAILABLE",
              });
        },
      });
    },
    {
      themeKey: THEME_KEY,
      themeValue: theme,
      entries: screen.localStorage ?? {},
      failIds: screen.failOnBoot ?? [],
    },
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

async function waitForHydration(page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: COLD_TIMEOUT },
  );
}

function matchesSubset(screen, only) {
  const exact = `${screen.screen}-${screen.state}`;
  if (only.size === 0) return true;
  return only.has(screen.screen) || only.has(exact) || only.has(screen.part);
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
  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const only = new Set(args.filter((arg) => !arg.startsWith("--")));
  const themeFlag = flags
    .find((flag) => flag.startsWith("--theme="))
    ?.slice("--theme=".length);
  if (themeFlag !== undefined && !THEMES.includes(themeFlag)) {
    console.error(`--theme must be one of: ${THEMES.join(", ")}`);
    process.exit(2);
  }
  const themes = themeFlag ? [themeFlag] : THEMES;

  const screens = SCREENS.filter((s) => matchesSubset(s, only));
  if (screens.length === 0) {
    console.error(`No screen matches: ${[...only].join(", ")}`);
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(OUT_DIR, { recursive: true });
  let browser = await chromium.launch();
  const failures = [];
  let total = 0;
  try {
    for (const screen of screens) {
      for (const theme of themes.filter((t) => screen.themes.includes(t))) {
        for (const viewport of screen.viewports) {
          total += 1;
          const id = `${screen.screen}-${screen.state}-${theme}-${viewport.label}`;
          // A crashed/closed browser must fail one state, not the whole run.
          if (!browser.isConnected()) browser = await chromium.launch();
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            locale: "id-ID",
            timezoneId: "Asia/Jakarta",
            colorScheme: theme,
          });
          const page = await context.newPage();
          try {
            await prepareContext(page, theme, screen);
            if (screen.seed) await screen.seed(page, baseUrl);
            await page.goto(`${baseUrl}${screen.path}`, {
              waitUntil: "domcontentloaded",
            });
            // Loading states are skeleton screenshots: hydration is not awaited.
            if (!screen.noHydration) await waitForHydration(page);
            await screen.prepare(page);
            await settle(page);
            const violations = await axe.run(page);
            const blocking = violations.filter((v) =>
              BLOCKING_IMPACTS.has(v.impact ?? ""),
            );
            // Horizontal scroll check (the brief wants none at narrow widths).
            const overflow = await page.evaluate(
              () =>
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth + 1,
            );
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({
              path: join(OUT_DIR, `${id}.png`),
              fullPage: true,
            });
            if (blocking.length === 0 && !overflow) {
              console.log(
                `PASS ${id}${violations.length ? ` (${violations.length} minor/moderate)` : ""}`,
              );
            } else {
              console.log(`FAIL ${id}`);
              if (overflow) console.log("  horizontal scroll (page too wide)");
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
                path: join(OUT_DIR, `${id}.error.png`),
                fullPage: true,
              })
              .catch(() => {});
            failures.push(id);
          } finally {
            await context.close().catch(() => {});
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(
    failures.length === 0
      ? `\nAll ${total} checks passed.`
      : `\n${failures.length} of ${total} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
