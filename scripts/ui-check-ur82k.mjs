#!/usr/bin/env node
// UI check for "Lupa PIN lewat WhatsApp masuk" (bead legend-ur82k).
//
// For every state below, at 390x844 and 1280x800: open the forgot-PIN page in
// mock mode with the wanted ?waScenario=, drive it to the state, take a
// full-page screenshot to docs/qa/ur82k/<state>-<390|1280|320>.png and run axe
// (wcag2a, wcag2aa, wcag21aa, wcag22aa). A short summary of all violations goes to
// docs/qa/ur82k/axe.json. Every state also fails on horizontal overflow
// (scrollWidth > clientWidth); the waiting state fails when the "Buka WhatsApp"
// button and the QR overlap. 320x700 only checks overflow and takes a screenshot.
//
//   BASE_URL=http://localhost:3225 node scripts/ui-check-ur82k.mjs
//   BASE_URL=... node scripts/ui-check-ur82k.mjs menunggu sukses   (subset)
//
// BASE_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts, e.g.
// `LEGEND_MOCK_PORT=3225 pnpm --filter @starter/web dev` with the env of that
// config). Never point it at a real deployment. Sign-in: no login in mock mode;
// the cookie `legend-mock-role=employee` is the session (see
// e2e/payslip-pin-wa-reset.mock.spec.ts). Each state gets a fresh browser
// context, so the in-browser mock store starts clean.
//
// axe: uses `@axe-core/playwright` when installed, else injects the `axe-core`
// bundle from node_modules/.pnpm. Exit code 1 when a state fails to render or
// axe reports a serious/critical violation.
import { createRequire } from "node:module";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/qa/ur82k");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "390", width: 390, height: 844 },
  { label: "1280", width: 1280, height: 800 },
  { label: "320", width: 320, height: 700, overflowOnly: true },
];
const ROLE_COOKIE = "legend-mock-role";
const FORGOT_PATH = "/karyawan/slip-gaji/lupa-pin";
const NEW_PIN = "135792"; // passes the weak-PIN rule
const OTHER_PIN = "246801";
const COLD = 45_000; // Vite compiles a route on its first request.
const POLL = 20_000; // two 2 s polls plus slack.

/** A button or a link named like `name`. */
const action = (page, name) =>
  page
    .getByRole("button", { name })
    .or(page.getByRole("link", { name }))
    .first();
const visible = (locator, timeout = COLD) =>
  locator.waitFor({ state: "visible", timeout });
const heading = (page, name) => page.getByRole("heading", { name });

const startWhatsApp = (page) => action(page, /^Lewat WhatsApp/).click();
const waiting = (page) => visible(heading(page, "Kirim lewat WhatsApp"));
const verifiedDialog = (page) =>
  page.getByRole("dialog", { name: "Nomor berhasil diverifikasi" });

async function toNewPin(page) {
  await startWhatsApp(page);
  const dialog = verifiedDialog(page);
  await visible(dialog, POLL);
  await dialog.getByRole("button", { name: "Buat PIN baru" }).click();
  await visible(heading(page, "Buat PIN slip gaji"));
}

async function fillNewPin(page, repeat) {
  await page.getByLabel("PIN baru", { exact: true }).fill(NEW_PIN);
  await page.getByLabel("Ulangi PIN baru", { exact: true }).fill(repeat);
}

// `scenario`: ?waScenario= value. `extra`: more query. `prepare` drives the
// state and ends with something visible that proves it is on screen.
const STATES = [
  {
    name: "choose",
    scenario: "verify",
    prepare: async () => {},
  },
  {
    name: "menunggu",
    scenario: "pending",
    prepare: async (page) => {
      await startWhatsApp(page);
      await waiting(page);
      await visible(page.getByText(/Menunggu pesan Anda/));
    },
  },
  {
    name: "kode-disalin",
    scenario: "pending",
    prepare: async (page) => {
      await startWhatsApp(page);
      await waiting(page);
      await action(page, "Salin pesan").click();
      await visible(
        page
          .getByText(/Pesan disalin\. Tempel dan kirim lewat WhatsApp\./)
          .first(),
      );
    },
  },
  {
    name: "terverifikasi",
    scenario: "verify",
    prepare: async (page) => {
      await startWhatsApp(page);
      await visible(verifiedDialog(page), POLL);
    },
  },
  {
    name: "pin-baru",
    scenario: "verify",
    prepare: toNewPin,
  },
  {
    name: "sukses",
    scenario: "verify",
    prepare: async (page) => {
      await toNewPin(page);
      await fillNewPin(page, NEW_PIN);
      await page.getByRole("button", { name: "Simpan PIN" }).click();
      await visible(page.getByText("PIN berhasil disimpan"));
    },
  },
  {
    name: "kedaluwarsa",
    scenario: "expire",
    prepare: async (page) => {
      await startWhatsApp(page);
      await visible(heading(page, "Kode sudah kedaluwarsa"));
    },
  },
  {
    name: "pin-tidak-sama",
    scenario: "verify",
    prepare: async (page) => {
      await toNewPin(page);
      await fillNewPin(page, OTHER_PIN);
      await page.getByRole("button", { name: "Simpan PIN" }).click();
      await visible(page.getByText("Ulangan PIN tidak sama dengan PIN baru."));
    },
  },
  {
    name: "mismatch",
    scenario: "pending",
    prepare: async (page) => {
      await startWhatsApp(page);
      await waiting(page);
      await action(page, /Sudah kirim tapi belum terverifikasi/).click();
      await visible(page.getByText(/Belum ada pesan yang cocok/).first());
    },
  },
  {
    name: "rate-limited",
    scenario: "rate-limited",
    prepare: async (page) => {
      await startWhatsApp(page);
      await visible(heading(page, "Terlalu banyak percobaan"));
    },
  },
  {
    name: "too-new",
    scenario: "too-new",
    prepare: async (page) => {
      await startWhatsApp(page);
      await visible(page.getByText(/3 hari/).first());
    },
  },
  {
    name: "no-wa-hr",
    scenario: "no-wa",
    prepare: async (page) => {
      await startWhatsApp(page);
      await visible(heading(page, "Nomor WhatsApp belum terdaftar"));
      await visible(page.getByText(/Hubungi HR atau atasan di outlet/).first());
    },
  },
  {
    name: "unavailable-plain",
    scenario: "unavailable-plain",
    prepare: async (page) => {
      await startWhatsApp(page);
      await visible(page.getByText(/Hubungi HR atau supervisor di outlet/).first());
      await visible(page.getByText(/3 hari/).first());
    },
  },
  {
    name: "503",
    scenario: "unavailable",
    prepare: async (page) => {
      await startWhatsApp(page);
      await visible(page.getByText(/belum tersedia/i).first());
    },
  },
  {
    name: "bantuan-hr",
    scenario: "verify",
    prepare: async (page) => {
      await action(page, "Lihat cara minta bantuan").click();
      await visible(heading(page, "Minta bantuan HR atau supervisor"));
    },
  },
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

async function waitForHydration(page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: COLD },
  );
}

/** Horizontal overflow: the page is wider than the viewport. */
const overflowOf = (page) =>
  page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth > el.clientWidth
      ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
      : null;
  });

/** Bounding-box overlap of "Buka WhatsApp" and the QR (only when both show). */
async function waButtonOverlapsQr(page) {
  const button = action(page, /Buka WhatsApp/);
  const qr = page.getByRole("img", { name: /Kode QR/ }).first();
  if (!(await qr.isVisible()) || !(await button.isVisible())) return false;
  const [a, b] = await Promise.all([button.boundingBox(), qr.boundingBox()]);
  if (!a || !b) return false;
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

const summarize = (violations) =>
  violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
  }));

async function main() {
  const baseUrl = process.env.BASE_URL?.replace(/\/+$/, "");
  if (!baseUrl) {
    console.error(
      "Set BASE_URL to a web server running with VITE_API_MOCK=true, e.g. BASE_URL=http://localhost:3225",
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
  const report = {
    baseUrl,
    axe: axe.source,
    tags: AXE_TAGS,
    results: {},
  };
  const failures = [];
  try {
    for (const state of states) {
      for (const viewport of VIEWPORTS) {
        const id = `${state.name}-${viewport.label}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        await context
          .grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: baseUrl,
          })
          .catch(() => {});
        await context.addCookies([
          { name: ROLE_COOKIE, value: "employee", url: baseUrl },
        ]);
        const page = await context.newPage();
        try {
          await page.goto(
            `${baseUrl}${FORGOT_PATH}?waScenario=${state.scenario}`,
            {
              waitUntil: "domcontentloaded",
            },
          );
          await waitForHydration(page);
          await visible(heading(page, "Lupa PIN?"));
          await state.prepare(page);
          const problems = [];
          const overflow = await overflowOf(page);
          if (overflow)
            problems.push(
              `horizontal overflow (${overflow.scrollWidth} > ${overflow.clientWidth})`,
            );
          if (
            state.name === "menunggu" &&
            !viewport.overflowOnly &&
            (await waButtonOverlapsQr(page))
          )
            problems.push('"Buka WhatsApp" overlaps the QR');
          const violations = viewport.overflowOnly
            ? []
            : await axe.run(page);
          await page.screenshot({
            path: join(OUT_DIR, `${id}.png`),
            fullPage: true,
          });
          const blocking = violations.filter((v) =>
            BLOCKING_IMPACTS.has(v.impact ?? ""),
          );
          const ok = blocking.length === 0 && problems.length === 0;
          report.results[id] = {
            status: ok ? "pass" : "fail",
            violations: summarize(violations),
            ...(problems.length ? { problems } : {}),
          };
          console.log(
            `${ok ? "PASS" : "FAIL"} ${id}` +
              (violations.length ? ` (${violations.length} violation)` : ""),
          );
          for (const v of blocking)
            console.log(
              `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node)`,
            );
          for (const problem of problems) console.log(`  [layout] ${problem}`);
          if (!ok) failures.push(id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.log(`FAIL ${id}: ${message.split("\n")[0]}`);
          await page
            .screenshot({
              path: join(OUT_DIR, `${id}.error.png`),
              fullPage: true,
            })
            .catch(() => {});
          report.results[id] = {
            status: "error",
            error: message.split("\n")[0],
          };
          failures.push(id);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await writeFile(
      join(OUT_DIR, "axe.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  console.log(
    failures.length === 0
      ? `\nAll ${states.length * VIEWPORTS.length} checks passed. Output: docs/qa/ur82k/`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
