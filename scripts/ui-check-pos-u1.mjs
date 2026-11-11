#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate callbacks */
// UI check for the POS main cashier and captain order screens (sub-539-u1,
// beads legend-59v and legend-76t). Modeled on scripts/ui-check.mjs.
//
// For every screen/state below, at 390x844 and 1280x800: open the page in mock
// mode, drive it to the state, run axe (wcag2a, wcag2aa, wcag21aa, wcag22aa),
// fail on serious/critical violations, and save a full-page screenshot to
// design/screenshots/pos-u1/<screen>-<state>-<390|1280>.png.
//
//   UI_CHECK_URL=http://localhost:3225 heavy node scripts/ui-check-pos-u1.mjs
//   UI_CHECK_URL=... node scripts/ui-check-pos-u1.mjs kasir captain-tinjau-offline
//
// A subset argument is a screen ("kasir"), a screen-state ("kasir-offline") or
// a whole route family ("captain" = every captain screen).
//
// UI_CHECK_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts). Never point it at a real deployment.
//
// Session: no login in mock mode. No `legend-mock-role` cookie = role "all",
// which holds `pos.sale.create` (kasir guard) and `order.create` (captain
// guard). Each state gets a fresh browser context, so the in-browser mock
// store and the sessionStorage drafts start clean.
//
// Demo seeds (docs/briefs/sub-539-u1.md): `?demo=kosong|offline|gagal|memuat`.
// The seed is read from the page URL, so a state that needs a cart first fills
// it on another URL (`seed`) and then does a full navigation to the seeded URL;
// sessionStorage (the draft cart) survives that in the same tab.
//
// Copy comes from the approved mockups in design/mockups/pos/ (cashier-main.html,
// captain.html). The screens are built in parallel with this script, so a few
// expectations (empty / error wording) are deliberately loose regexes; tighten
// them once the message catalogs are merged.
//
// The browser runs in Asia/Jakarta so "14.08" (offline catalog time) matches the
// mockup regardless of the machine zone.
//
// axe: uses `@axe-core/playwright` when installed, else injects the `axe-core`
// bundle from node_modules/.pnpm. Exit code 1 when a state fails to render or
// axe reports a serious/critical violation.
import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "design/screenshots/pos-u1");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const MOBILE = { label: "390", width: 390, height: 844 };
const DESKTOP = { label: "1280", width: 1280, height: 800 };
const VIEWPORTS = [MOBILE, DESKTOP];
const COLD_TIMEOUT = 45_000; // Vite compiles a route on its first request.
const TABLE = "A01";

// ---- screens -----------------------------------------------------------------
// `screen` + `state` name the png. `path` is opened after `seed` (optional, runs
// on its own URL first). `prepare` drives the state and must end with something
// visible that proves it. `viewports` limits the widths; `noHydration` skips the
// hydration wait (the "memuat" state never settles).
const SCREENS = [];

function add(screen) {
  SCREENS.push({ viewports: VIEWPORTS, ...screen });
}

// Kasir: /pos/kasir.
const KASIR = "/pos/kasir";
const FILLED_CART = /Rp\s?50\.000/;
add({
  screen: "kasir",
  state: "main",
  path: KASIR,
  prepare: async (p) => {
    await expectHeading(p, "Pesanan baru");
    await fillKasirCart(p);
  },
});
add({
  screen: "kasir",
  state: "kosong",
  path: `${KASIR}?demo=kosong`,
  prepare: async (p) => {
    await expectText(p, "Keranjang masih kosong");
    await expectAbsent(p, /Nasi goreng kampung/);
  },
});
add({
  screen: "kasir",
  state: "offline",
  path: `${KASIR}?demo=offline`,
  prepare: async (p) => {
    await expectText(p, /Katalog belum diperbarui sejak 14\.08/);
    await expectText(p, /Nasi goreng kampung/);
  },
});
add({
  screen: "kasir",
  state: "gagal",
  path: `${KASIR}?demo=gagal`,
  prepare: (p) => expectButton(p, /Coba lagi/),
});
add({
  screen: "kasir",
  state: "memuat",
  path: `${KASIR}?demo=memuat`,
  noHydration: true,
  // The catalog loads as a skeleton; its only text is a screen-reader status.
  prepare: (p) => expectBusy(p),
});
add({
  screen: "kasir",
  state: "modifier",
  path: KASIR,
  prepare: async (p) => {
    await clickMenuItem(p, /Nasi goreng kampung/i);
    const dialog = p.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
    await expectText(p, /Tingkat pedas/);
    await expectText(p, "Tidak pedas");
    // The mockup shows the required-group message. If the screen only shows it
    // after an attempt, press "Tambah ke keranjang" (never on a disabled one).
    await showModifierError(p);
  },
});
add({
  screen: "kasir",
  state: "takeaway",
  path: KASIR,
  prepare: async (p) => {
    await expectHeading(p, "Pesanan baru");
    await fillKasirCart(p);
    await clickControl(p, /Takeaway/);
    await expectText(p, /Nomor panggilan/);
    await expectText(p, /A-12/);
  },
});
add({
  screen: "kasir",
  state: "keranjang-mobile",
  viewports: [MOBILE],
  path: KASIR,
  prepare: async (p) => {
    await expectHeading(p, "Pesanan baru");
    await fillKasirCart(p);
    await clickControl(p, /Lihat keranjang/);
    await expectHeading(p, "Keranjang");
    await expectButton(p, /Lanjutkan pesanan/);
  },
});

// Captain: list, calls, table order, add, review. Each gets main + kosong +
// offline + gagal (+ memuat) unless the state has no meaning there.
const CAPTAIN_SCREENS = [
  {
    screen: "captain",
    path: "/pos/captain",
    main: async (p) => {
      await expectHeading(p, "Pilih meja");
      await expectText(p, TABLE);
      await expectText(p, /Sesi QR aktif/);
      await expectText(p, /Minta alat makan/);
    },
    kosong: async (p) => {
      await expectHeading(p, "Pilih meja");
      await expectAbsent(p, new RegExp(`^${TABLE}$`));
    },
  },
  {
    screen: "captain-panggilan",
    path: "/pos/captain/panggilan",
    main: async (p) => {
      await expectHeading(p, "Panggilan waiter");
      await expectText(p, /Minta alat makan/);
      await expectButton(p, /Terima permintaan/);
    },
    kosong: async (p) => {
      await expectHeading(p, "Panggilan waiter");
      await expectAbsent(p, /Minta alat makan/);
    },
  },
  {
    screen: "captain-meja",
    path: `/pos/captain/meja/${TABLE}`,
    main: async (p) => {
      await expectText(p, TABLE);
      await expectText(p, /Sesi QR aktif/);
    },
    kosong: async (p) => {
      await expectText(p, TABLE);
      await expectText(p, /belum ada|kosong|tidak ada/i);
    },
  },
  {
    screen: "captain-tambah",
    path: `/pos/captain/meja/${TABLE}/tambah`,
    main: async (p) => {
      await expectHeading(p, "Tambah pesanan");
      await expectText(p, /Nasi goreng kampung/i);
      await expectText(p, /Es teh manis/i);
    },
    kosong: async (p) => {
      await expectHeading(p, "Tambah pesanan");
      await expectAbsent(p, /Nasi goreng kampung/i);
    },
  },
  {
    // Review needs a cart: filled on the add screen first (`seed`), except in
    // "kosong" where the empty cart is the point.
    screen: "captain-tinjau",
    path: `/pos/captain/meja/${TABLE}/tinjau`,
    seedCart: true,
    main: async (p) => {
      await expectHeading(p, "Tinjau pesanan");
      await expectButton(p, /Kirim pesanan ke dapur/);
      await expectText(p, /Ditahan|Kirim sekarang/);
    },
    kosong: async (p) => {
      await expectHeading(p, "Tinjau pesanan");
      await expectText(p, /belum ada|kosong|tidak ada/i);
    },
  },
];

for (const c of CAPTAIN_SCREENS) {
  const seed = c.seedCart ? seedCaptainCart : undefined;
  add({
    screen: c.screen,
    state: "main",
    path: c.path,
    seed,
    prepare: c.main,
  });
  add({
    screen: c.screen,
    state: "kosong",
    path: `${c.path}?demo=kosong`,
    prepare: c.kosong,
  });
  add({
    screen: c.screen,
    state: "offline",
    path: `${c.path}?demo=offline`,
    seed,
    prepare: (p) => expectText(p, /Internet putus/),
  });
  add({
    screen: c.screen,
    state: "gagal",
    path: `${c.path}?demo=gagal`,
    seed,
    prepare: (p) => expectButton(p, /Coba lagi/),
  });
  add({
    screen: c.screen,
    state: "memuat",
    path: `${c.path}?demo=memuat`,
    noHydration: true,
    prepare: (p) => expectBusy(p),
  });
}

// ---- helpers -----------------------------------------------------------------

function textMatcher(text) {
  return typeof text === "string" ? new RegExp(escapeRegExp(text)) : text;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// All waits target visible elements only: the cashier renders both a desktop
// and a mobile variant of some blocks, and one of them is display:none.
async function expectText(page, text) {
  await page
    .getByText(textMatcher(text))
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
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
async function expectBusy(page) {
  await page
    .locator('[aria-busy="true"]')
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
/** The text must not be on screen (state proof for empty lists). */
async function expectAbsent(page, text) {
  const count = await page
    .getByText(textMatcher(text))
    .filter({ visible: true })
    .count();
  if (count > 0) throw new Error(`unexpected visible text: ${text}`);
}
/** Clicks a button/radio/tab/link by its visible text (channel toggles vary). */
async function clickControl(page, name) {
  const control = page
    .locator('button, [role="radio"], [role="tab"], [role="switch"], a')
    .filter({ hasText: name })
    .filter({ visible: true })
    .first();
  await control.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await control.click();
}

/**
 * Taps a menu item: the card itself when it is a button named after the item,
 * else the "Tambah" button inside the row that shows the item name.
 */
async function clickMenuItem(page, name) {
  const direct = page
    .getByRole("button", { name })
    .filter({ visible: true })
    .first();
  await direct
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT })
    .catch(() => {});
  if ((await direct.count()) > 0) {
    await direct.click();
    return;
  }
  const label = page.getByText(name).filter({ visible: true }).first();
  await label.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  const row = label.locator("xpath=ancestor::*[.//button][1]");
  await row
    .getByRole("button", { name: /Tambah|\+|＋/ })
    .first()
    .click();
}

/** Shows the "required modifier group" message in an open dialog. */
async function showModifierError(page) {
  const message = page.getByText(/Pilih .* sebelum menambahkan/);
  const shown = await message
    .first()
    .waitFor({ state: "visible", timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (shown) return;
  const confirm = page
    .getByRole("dialog")
    .getByRole("button", { name: /Tambah ke keranjang/ });
  await confirm.click();
  await message.first().waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}

/**
 * Adds one item. If the modifier dialog opens (item with a required group), it
 * picks `option`, writes `note` and confirms.
 */
async function addItem(page, name, { option = "Pedas sedang", note = "" } = {}) {
  await clickMenuItem(page, name);
  const dialog = page.getByRole("dialog");
  const opened = await dialog
    .waitFor({ state: "visible", timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return;
  const choice = dialog
    .locator('[role="radio"], input[type="radio"], label, button')
    .filter({ hasText: option })
    .first();
  if ((await choice.count()) > 0) await choice.click();
  else await dialog.getByText(option).first().click();
  if (note) await dialog.getByRole("textbox").fill(note);
  await dialog
    .getByRole("button", { name: /Tambah ke keranjang/ })
    .click();
  await dialog.waitFor({ state: "hidden", timeout: COLD_TIMEOUT });
}

/** Kasir cart as in the mockup: nasi goreng (pedas sedang, note) + es teh. */
async function fillKasirCart(page) {
  await addItem(page, /Nasi goreng kampung/i, {
    option: "Pedas sedang",
    note: "tanpa bawang",
  });
  await addItem(page, /Es teh manis/i);
  // Subtotal Rp50.000 is in the desktop cart or the mobile bar.
  await expectText(page, FILLED_CART);
}

/** Captain draft for table A01 (nasi goreng tidak pedas + es teh). */
async function seedCaptainCart(page, baseUrl) {
  await page.goto(`${baseUrl}/pos/captain/meja/${TABLE}/tambah`, {
    waitUntil: "domcontentloaded",
  });
  await waitForHydration(page);
  await expectHeading(page, "Tambah pesanan");
  await addItem(page, /Nasi goreng kampung/i, { option: "Tidak pedas" });
  await addItem(page, /Es teh manis/i);
  await expectButton(page, /Tinjau pesanan/);
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
  if (only.size === 0) return true;
  return (
    only.has(screen.screen) ||
    only.has(`${screen.screen}-${screen.state}`) ||
    (screen.screen.startsWith("captain") && only.has("captain-all"))
  );
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
  const screens = SCREENS.filter((s) => matchesSubset(s, only));
  if (screens.length === 0) {
    console.error(`No screen matches: ${[...only].join(", ")}`);
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  let total = 0;
  try {
    for (const screen of screens) {
      for (const viewport of screen.viewports) {
        total += 1;
        const id = `${screen.screen}-${screen.state}-${viewport.label}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          locale: "id-ID",
          timezoneId: "Asia/Jakarta",
        });
        const page = await context.newPage();
        try {
          if (screen.seed) await screen.seed(page, baseUrl);
          await page.goto(`${baseUrl}${screen.path}`, {
            waitUntil: "domcontentloaded",
          });
          // The loading state is a skeleton screenshot: hydration is not awaited.
          if (!screen.noHydration) await waitForHydration(page);
          await screen.prepare(page);
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
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(
    failures.length === 0
      ? `\nAll ${total} checks passed.`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
