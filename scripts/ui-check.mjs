#!/usr/bin/env node
// UI check for the payslip PIN screens (bead legend-ilzrj, Wave 3).
//
// For every screen/state below, at 390x844 and 1280x800: open the page in mock
// mode, drive it to the state, run axe (wcag2a, wcag2aa, wcag21aa, wcag22aa),
// fail on serious/critical violations, and save a screenshot to
// design/screenshots/payslip-pin/<screen>-<390|1280>.png.
//
//   UI_CHECK_URL=http://localhost:3225 heavy node scripts/ui-check.mjs
//   UI_CHECK_URL=... node scripts/ui-check.mjs buka-slip pin-salah   (subset)
//
// UI_CHECK_URL must be a web server started with VITE_API_MOCK=true (for
// example `pnpm --filter @starter/web dev` with the env of
// playwright.mock.config.ts). Never point it at a real deployment: mock mode
// serves fixtures and the script enters wrong PINs on purpose.
//
// Session: there is no login in mock mode. The cookie `legend-mock-role`
// (apps/web/src/lib/areas/access.ts) picks the role; the signed-in employee is
// always CL-1003 and the demo PIN is 123456. Employee screens use the
// `employee` role, HR screens send no cookie (= "all", includes `payroll.run`).
// Each screen gets a fresh browser context, so the in-browser mock store (PIN
// attempts, lock, HR reset) starts clean every time.
//
// axe: uses `@axe-core/playwright` when installed. It is not a dependency of
// this repo yet, so the script falls back to injecting the `axe-core` bundle
// found in node_modules/.pnpm. If neither exists it stops with a message
// (add `@axe-core/playwright` as a devDependency only after saying so).
import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "design/screenshots/payslip-pin");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "390", width: 390, height: 844 },
  { label: "1280", width: 1280, height: 800 },
];
const ROLE_COOKIE = "legend-mock-role";
const DEMO_PIN = "123456";
const WRONG_PIN = "654321";
const NEW_PIN = "482915";
const COLD_TIMEOUT = 45_000; // Vite compiles a route on its first request.

// Screens list. `role`: "employee" sends the cookie, "hr" sends none.
// `path` may use {slipId} / {employeeId}, discovered at start (override with
// UI_CHECK_SLIP_ID / UI_CHECK_EMPLOYEE_ID). `prepare` drives the state and must
// finish with something visible that proves the state is on screen.
const SCREENS = [
  // Employee: slip list (daftar slip).
  {
    name: "riwayat",
    role: "employee",
    path: "/karyawan/slip-gaji",
    prepare: (p) => expectLink(p, /Lihat slip/),
  },
  {
    name: "riwayat-kosong",
    role: "employee",
    path: "/karyawan/slip-gaji?mock=empty",
    prepare: (p) => expectText(p, "Belum ada slip gaji"),
  },
  {
    name: "riwayat-error",
    role: "employee",
    path: "/karyawan/slip-gaji?mock=error",
    prepare: (p) => expectText(p, "Slip gaji tidak dapat dimuat"),
  },
  {
    name: "riwayat-memuat",
    role: "employee",
    path: "/karyawan/slip-gaji?mock=slow",
    prepare: (p) => expectText(p, /Sedang memuat daftar slip/),
  },
  // Employee: gate (buka-slip, pin-salah, terkunci, slip terbuka).
  {
    name: "buka-slip",
    role: "employee",
    path: "/karyawan/slip-gaji/{slipId}",
    prepare: async (p) => {
      await expectText(p, "Masukkan PIN", { heading: true });
      // Amounts must stay hidden before the PIN is accepted.
      const body = await p.locator("body").innerText();
      if (/Rp\s?\d/.test(body))
        throw new Error("a rupiah amount is visible before the PIN");
    },
  },
  {
    name: "pin-salah",
    role: "employee",
    path: "/karyawan/slip-gaji/{slipId}",
    prepare: async (p) => {
      await expectText(p, "Masukkan PIN", { heading: true });
      await submitPin(p, [WRONG_PIN]);
      await expectText(p, /4 percobaan tersisa/);
    },
  },
  {
    name: "terkunci",
    role: "employee",
    path: "/karyawan/slip-gaji/{slipId}?mock=pin-locked",
    prepare: (p) => expectText(p, "PIN terkunci sementara"),
  },
  {
    name: "slip-terbuka",
    role: "employee",
    path: "/karyawan/slip-gaji/{slipId}",
    prepare: async (p) => {
      await expectText(p, "Masukkan PIN", { heading: true });
      await submitPin(p, [DEMO_PIN]);
      await expectText(p, /Gaji bersih/i);
    },
  },
  // Employee: forgot PIN (lupa-pin, belum tersedia, kode dibatasi, kode WA).
  {
    name: "lupa-pin",
    role: "employee",
    path: "/karyawan/slip-gaji/lupa-pin",
    prepare: async (p) => {
      await expectText(p, "Lupa PIN?", { heading: true });
      await expectText(p, /Hubungi HR atau atasan di outlet/);
    },
  },
  {
    // Default OTP mode: request answers 503 -> clear "belum tersedia" state.
    name: "lupa-pin-belum-tersedia",
    role: "employee",
    path: "/karyawan/slip-gaji/lupa-pin",
    prepare: async (p) => {
      await clickButton(p, /kode WhatsApp/i);
      await expectText(p, /belum tersedia/i);
    },
  },
  {
    name: "kode-dibatasi",
    role: "employee",
    path: "/karyawan/slip-gaji/lupa-pin?mock=otp-rate-limited",
    prepare: async (p) => {
      await clickButton(p, /kode WhatsApp/i);
      await expectText(p, "Terlalu banyak permintaan kode");
    },
  },
  {
    name: "kode-whatsapp",
    role: "employee",
    path: "/karyawan/slip-gaji/lupa-pin?mock=otp-ok",
    prepare: async (p) => {
      await clickButton(p, /kode WhatsApp/i);
      await expectText(p, /Kode sudah dikirim/);
    },
  },
  // Employee: change PIN.
  {
    name: "ubah-pin",
    role: "employee",
    path: "/karyawan/slip-gaji/ubah-pin",
    prepare: (p) => expectText(p, "Ubah PIN", { heading: true }),
  },
  {
    name: "ubah-pin-salah",
    role: "employee",
    path: "/karyawan/slip-gaji/ubah-pin",
    prepare: async (p) => {
      await expectText(p, "Ubah PIN", { heading: true });
      // current (wrong), new, repeat. Distinct, non-sequential new PIN.
      await submitPin(p, [WRONG_PIN, "482916", "482916"]);
      await expectText(p, /4 percobaan tersisa/);
    },
  },
  // HR: reset PIN on the employee profile.
  {
    name: "hr-profil",
    role: "hr",
    path: "/kelola/karyawan/{employeeId}",
    prepare: (p) => expectButton(p, "Reset PIN slip gaji"),
  },
  {
    name: "hr-reset-dialog",
    role: "hr",
    path: "/kelola/karyawan/{employeeId}",
    prepare: async (p) => {
      await clickButton(p, "Reset PIN slip gaji");
      await expectText(p, "Reset PIN karyawan?");
    },
  },
  {
    name: "hr-reset-alasan-salah",
    role: "hr",
    path: "/kelola/karyawan/{employeeId}",
    prepare: async (p) => {
      await clickButton(p, "Reset PIN slip gaji");
      await expectText(p, "Reset PIN karyawan?");
      await p.getByRole("dialog").getByRole("textbox").fill("ab");
      await clickButton(p, "Ya, reset PIN");
      await expectText(p, "Alasan reset harus 3–500 karakter.");
    },
  },
  // Employee first PIN: `?mock=pin-not-set` opens the slip as PinSetup, and
  // the PUT makes the PIN active in-page.
  {
    name: "buat-pin",
    role: "employee",
    path: "/karyawan/slip-gaji/{slipId}?mock=pin-not-set",
    prepare: (p) => expectText(p, "Buat PIN slip gaji", { heading: true }),
  },
  {
    name: "pin-tersimpan",
    role: "employee",
    path: "/karyawan/slip-gaji/{slipId}?mock=pin-not-set",
    prepare: async (p) => {
      await expectText(p, "Buat PIN slip gaji", { heading: true });
      await submitPin(p, [NEW_PIN, NEW_PIN]);
      await expectText(p, "PIN berhasil disimpan");
    },
  },
];

// ---- helpers -----------------------------------------------------------------

function textMatcher(text) {
  return typeof text === "string" ? new RegExp(escapeRegExp(text)) : text;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectText(page, text, { heading = false } = {}) {
  const target = heading
    ? page.getByRole("heading", { name: textMatcher(text) })
    : page.getByText(textMatcher(text));
  await target.first().waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
async function expectLink(page, name) {
  await page
    .getByRole("link", { name })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
async function expectButton(page, name) {
  await page
    .getByRole("button", { name })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
async function clickButton(page, name) {
  const button = page.getByRole("button", { name }).first();
  await button.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await button.click();
}

/**
 * Fills the visible PIN fields in order (one real <input inputmode=numeric> per
 * PIN field, see pin-code-input.tsx) and submits the form with Enter.
 */
async function submitPin(page, pins) {
  const inputs = page.locator('input[inputmode="numeric"]:visible');
  await inputs.first().waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  for (let index = 0; index < pins.length; index += 1) {
    const input = inputs.nth(index);
    await input.fill("");
    await input.fill(pins[index]);
  }
  await inputs.nth(pins.length - 1).press("Enter");
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

/** Finds a slip id and the demo employee's id by walking the mock UI once. */
async function discoverIds(browser, baseUrl) {
  const ids = {
    slipId: process.env.UI_CHECK_SLIP_ID ?? null,
    employeeId: process.env.UI_CHECK_EMPLOYEE_ID ?? null,
  };
  if (ids.slipId !== null && ids.employeeId !== null) return ids;
  const context = await browser.newContext();
  await context.addCookies([
    { name: ROLE_COOKIE, value: "employee", url: baseUrl },
  ]);
  const page = await context.newPage();
  try {
    if (ids.slipId === null) {
      await page.goto(`${baseUrl}/karyawan/slip-gaji`);
      const link = page.getByRole("link", { name: /Lihat slip/ }).first();
      await link.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
      const href = (await link.getAttribute("href")) ?? "";
      ids.slipId = href.split("/").filter(Boolean).pop() ?? null;
    }
    if (ids.employeeId === null) {
      await context.clearCookies();
      await page.goto(`${baseUrl}/kelola/karyawan`);
      const row = page
        .locator('a[href*="/kelola/karyawan/"]', { hasText: "CL-1003" })
        .first();
      await row.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
      const href = (await row.getAttribute("href")) ?? "";
      ids.employeeId = href.split("/").filter(Boolean).pop() ?? null;
    }
  } finally {
    await context.close();
  }
  if (ids.slipId === null || ids.employeeId === null)
    throw new Error("Could not discover a slip id / employee id (CL-1003).");
  return ids;
}

async function waitForHydration(page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: COLD_TIMEOUT },
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
  const screens = SCREENS.filter((s) => only.size === 0 || only.has(s.name));
  if (screens.length === 0) {
    console.error(`No screen matches: ${[...only].join(", ")}`);
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  try {
    const ids = await discoverIds(browser, baseUrl);
    for (const screen of screens) {
      for (const viewport of VIEWPORTS) {
        const id = `${screen.name}-${viewport.label}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        if (screen.role === "employee")
          await context.addCookies([
            { name: ROLE_COOKIE, value: "employee", url: baseUrl },
          ]);
        const page = await context.newPage();
        try {
          const path = screen.path
            .replace("{slipId}", ids.slipId)
            .replace("{employeeId}", ids.employeeId);
          await page.goto(`${baseUrl}${path}`, {
            waitUntil: "domcontentloaded",
          });
          // The slow scenario is a loading screenshot: hydration is not awaited.
          if (!path.includes("mock=slow")) await waitForHydration(page);
          await screen.prepare(page);
          const violations = await axe.run(page);
          const blocking = violations.filter((v) =>
            BLOCKING_IMPACTS.has(v.impact ?? ""),
          );
          await page.screenshot({
            path: join(OUT_DIR, `${id}.png`),
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
      ? `\nAll ${screens.length * VIEWPORTS.length} checks passed.`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
