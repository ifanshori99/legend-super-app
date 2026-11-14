#!/usr/bin/env node
/* global window, document, getComputedStyle -- used only inside page.evaluate callbacks */
// UI check for the KDS configuration and scanner screens (sub-brief
// docs/briefs/sub-kds-config-scanner.md): sonf (station settings,
// /kelola/dapur/stasiun) and uqfu (scanner aside on the KDS board, /kds).
//
// For every state below, at 1280x800 and 390x844: open the real page in mock
// mode, drive it to the state, take a screenshot to
// docs/screenshots/kds-config-scanner/<card>-<state>-<1280|390>.png (full page;
// viewport only for dialog states) and run axe (wcag2a, wcag2aa, wcag21aa,
// wcag22aa). Every state also fails on horizontal overflow
// (scrollWidth > clientWidth). A summary of all violations goes to
// docs/screenshots/kds-config-scanner/axe.json (merged with earlier runs, so a
// subset run keeps the other states).
//
//   BASE_URL=http://localhost:3225 node scripts/ui-check-kds-config-scanner.mjs
//   BASE_URL=... node scripts/ui-check-kds-config-scanner.mjs sonf uqfu-disconnected
//
// A subset argument is a card ("sonf") or a card-state ("uqfu-success").
//
// BASE_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts). Never point it at a real deployment. No
// login in mock mode; the cookie `legend-mock-role` picks the role (default
// "all"). Each state gets a fresh browser context, so the in-browser mock store
// and the remembered scenario (?mock=) start clean.
//
// States are driven with the scenarios and faults of apps/web/src/lib/mock:
// ?mock=slow|empty|error, window.__legendMock.setScenario(...) and
// window.__legendMock.failNext(<endpoint id>, ...). Selectors and copy follow
// the built screens (station-config-page.tsx, scanner-panel.tsx, i18n messages).
//
// uqfu "disconnected": the scanner status mock (ws04-kds/mock.ts) answers
// "disconnected" when the URL carries ?scanner=disconnected, else "connected".
// A fault is aimed at one endpoint id, not "*": the KDS board polls every 2 s
// and would eat a wildcard fault.
//
// axe: uses `@axe-core/playwright` when installed, else injects the `axe-core`
// bundle from node_modules/.pnpm. Exit code 1 when a state fails to render or
// axe reports a serious/critical violation.
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/screenshots/kds-config-scanner");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 800 },
  { label: "390", width: 390, height: 844 },
];
const ROLE_COOKIE = "legend-mock-role";
const COLD = 60_000; // Vite compiles a route on its first request.
const SAVE_FAILED_MESSAGE = "Gagal menyimpan (simulasi).";
const STATIONS_UPDATE_ID = "PUT /api/outlets/:outletId/kitchen/stations";
const TICKET_BUMP_ID =
  "POST /api/outlets/:outletId/kitchen/tickets/:ticketId/bump";

const visible = (locator, timeout = COLD) =>
  locator.waitFor({ state: "visible", timeout });
const text = (page, value, options) =>
  page.getByText(value, { exact: true, ...options }).first();

// ---- sonf: station settings (/kelola/dapur/stasiun) ------------------------
const CONFIG_PATH = "/kelola/dapur/stasiun";
const configReady = async (page) => {
  await visible(page.getByRole("heading", { name: "Pengaturan stasiun" }));
  await visible(page.getByRole("switch", { name: /^Status stasiun / }).first());
};
const moveFirstDown = async (page) => {
  await configReady(page);
  await page
    .getByRole("button", { name: /^Turunkan / })
    .first()
    .click();
  await visible(text(page, "Perubahan belum disimpan"));
};
const saveSettings = (page, name = "Simpan pengaturan") =>
  page.getByRole("button", { name }).click();

// ---- uqfu: scanner on the KDS board (/kds) ---------------------------------
const KDS_PATH = "/kds";
const scannerInput = (page) =>
  page.getByLabel("Input pemindai", { exact: true });
const kdsReady = async (page) => {
  await visible(page.getByRole("heading", { name: "Aksi dengan pemindai" }));
  await visible(
    page.getByRole("button", { name: /^(Mulai|Selesai)$/ }).first(),
  );
  await visible(text(page, "Siap memindai"));
};

/** The ticket card (`article[data-slot="kds-ticket"]`) that holds `button`. */
const ticketCard = (page, button) =>
  page
    .locator('article[data-slot="kds-ticket"]')
    .filter({ has: page.getByRole("button", { name: button, exact: true }) })
    .first();

/** Code the ticket header shows: the mono tail of the order id (6 chars). */
async function ticketCode(page, button) {
  const card = ticketCard(page, button);
  await visible(card);
  const code = await card.locator(".font-mono").first().textContent();
  if (!code?.trim())
    throw new Error(`No ticket code found on the ${button} ticket`);
  return code.trim().toUpperCase();
}

async function scan(page, value) {
  const input = scannerInput(page);
  await input.fill(value);
  await input.press("Enter");
}

const failNextCall = (page, endpointId, message) =>
  page.evaluate(
    ([id, failure]) => window.__legendMock.failNext(id, failure),
    [endpointId, { status: 500, code: "INTERNAL_ERROR", message }],
  );

// `path` may carry ?mock=. `dialog`: shoot the viewport only. `role`:
// legend-mock-role cookie. `loading`: capture before the data arrives (use
// ?mock=slow, 3 s latency). `prepare` drives the page to the state and ends
// with something visible that proves it is on screen.
const STATES = [
  // sonf -- station settings
  { card: "sonf", name: "normal", path: CONFIG_PATH, prepare: configReady },
  {
    card: "sonf",
    name: "loading",
    path: `${CONFIG_PATH}?mock=slow`,
    loading: true,
    prepare: (page) => visible(text(page, "Memuat pengaturan stasiun…")),
  },
  {
    card: "sonf",
    name: "empty",
    path: `${CONFIG_PATH}?mock=empty`,
    prepare: (page) => visible(text(page, "Belum ada stasiun")),
  },
  {
    card: "sonf",
    name: "error",
    path: `${CONFIG_PATH}?mock=error`,
    prepare: async (page) => {
      await visible(page.getByRole("alert").first());
      await visible(text(page, "Pengaturan tidak dapat dimuat"));
    },
  },
  {
    // Moved a station: save enabled, "Perubahan belum disimpan".
    card: "sonf",
    name: "dirty",
    path: CONFIG_PATH,
    prepare: moveFirstDown,
  },
  {
    // The next call fails: editor and draft stay, alert above the list.
    card: "sonf",
    name: "save-failed",
    path: CONFIG_PATH,
    prepare: async (page) => {
      await moveFirstDown(page);
      await failNextCall(page, STATIONS_UPDATE_ID, SAVE_FAILED_MESSAGE);
      await saveSettings(page);
      await visible(text(page, "Pengaturan belum tersimpan"));
      await visible(page.getByRole("button", { name: "Coba simpan lagi" }));
    },
  },
  {
    card: "sonf",
    name: "success",
    path: CONFIG_PATH,
    prepare: async (page) => {
      await moveFirstDown(page);
      await saveSettings(page);
      await visible(text(page, "Pengaturan tersimpan"));
      await visible(page.getByRole("button", { name: "Lihat pengaturan" }));
    },
  },

  // uqfu -- scanner on the KDS board
  { card: "uqfu", name: "normal", path: KDS_PATH, prepare: kdsReady },
  {
    card: "uqfu",
    name: "loading",
    path: `${KDS_PATH}?mock=slow`,
    loading: true,
    prepare: (page) =>
      page
        .getByText("Memuat papan dapur…")
        .first()
        .waitFor({ state: "attached", timeout: COLD }),
  },
  {
    // Empty scenario: no stations, so no board and no scanner to use.
    card: "uqfu",
    name: "empty",
    path: `${KDS_PATH}?mock=empty`,
    prepare: (page) => visible(text(page, "Belum ada tiket")),
  },
  {
    card: "uqfu",
    name: "error",
    path: `${KDS_PATH}?mock=error`,
    prepare: (page) => visible(text(page, "Papan dapur tidak dapat dimuat")),
  },
  {
    // Board loaded, then the next board read comes back without tickets: the
    // scanner shows "Belum ada tiket untuk dipindai" (polling refreshes it).
    card: "uqfu",
    name: "no-tickets",
    path: KDS_PATH,
    prepare: async (page) => {
      await kdsReady(page);
      await page.evaluate(() => window.__legendMock.setScenario("empty"));
      await visible(text(page, "Belum ada tiket untuk dipindai"));
    },
  },
  {
    card: "uqfu",
    name: "disconnected",
    path: `${KDS_PATH}?scanner=disconnected`,
    prepare: async (page) => {
      // The ready text never shows here: the status answer replaces it.
      await visible(
        page.getByRole("heading", { name: "Aksi dengan pemindai" }),
      );
      await visible(text(page, "Pemindai terputus"));
      await visible(text(page, "Input manual tersedia"));
      await visible(
        page.getByRole("button", { name: /^(Mulai|Selesai)$/ }).first(),
      );
    },
  },
  {
    // Connected: the "Terhubung" pill is shown.
    card: "uqfu",
    name: "connected",
    path: KDS_PATH,
    prepare: async (page) => {
      await kdsReady(page);
      await visible(text(page, "Terhubung"));
      await visible(text(page, "Pemindai aktif"));
    },
  },
  {
    // Slow answer: input disabled, "Memproses aksi…".
    card: "uqfu",
    name: "busy",
    path: KDS_PATH,
    prepare: async (page) => {
      await kdsReady(page);
      const code = await ticketCode(page, "Selesai");
      await page.evaluate(() => window.__legendMock.setScenario("slow"));
      await scan(page, `SELESAI ${code}`);
      await visible(text(page, "Memproses aksi…"));
    },
  },
  {
    card: "uqfu",
    name: "success",
    path: KDS_PATH,
    prepare: async (page) => {
      await kdsReady(page);
      const code = await ticketCode(page, "Selesai");
      await scan(page, `SELESAI ${code}`);
      await visible(text(page, "Tiket selesai"));
    },
  },
  {
    // Unknown action and ticket: "Pindaian tidak dikenali", nothing changes.
    card: "uqfu",
    name: "scan-error",
    path: KDS_PATH,
    prepare: async (page) => {
      await kdsReady(page);
      await scan(page, "HAPUS X-000");
      await visible(text(page, "Pindaian tidak dikenali"));
    },
  },
  {
    // The scanned action fails on save: error with the API message.
    card: "uqfu",
    name: "save-failed",
    path: KDS_PATH,
    prepare: async (page) => {
      await kdsReady(page);
      const code = await ticketCode(page, "Selesai");
      await failNextCall(page, TICKET_BUMP_ID, SAVE_FAILED_MESSAGE);
      await scan(page, `SELESAI ${code}`);
      await visible(page.getByText(SAVE_FAILED_MESSAGE).first());
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

/**
 * The back-office shell scrolls inside its own container (`main`, with
 * fixed-height ancestors), so a `fullPage` shot cuts the content. Before the
 * shot, let every scroll container and its ancestors grow to their content,
 * then take a `fullPage` shot. Dialog states shoot the viewport instead.
 */
const EXPAND_CSS = `
  [data-bo-expand] {
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
  }
`;

const expandLayout = (page) =>
  page.evaluate((css) => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      const scrolls =
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight;
      if (scrolls) {
        for (let node = el; node; node = node.parentElement)
          node.setAttribute("data-bo-expand", "");
      }
    }
    const tag = document.createElement("style");
    tag.textContent = css;
    document.head.append(tag);
  }, EXPAND_CSS);

async function captureState(page, path, fixedViewport) {
  if (!fixedViewport) await expandLayout(page);
  await page.screenshot({ path, fullPage: !fixedViewport });
}

const summarize = (violations) =>
  violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
  }));

const matchesFilter = (state, filters) =>
  filters.size === 0 ||
  filters.has(state.card) ||
  filters.has(`${state.card}-${state.name}`);

async function readPreviousResults() {
  try {
    return JSON.parse(await readFile(join(OUT_DIR, "axe.json"), "utf8"))
      .results;
  } catch {
    return {};
  }
}

async function main() {
  const baseUrl = process.env.BASE_URL?.replace(/\/+$/, "");
  if (!baseUrl) {
    console.error(
      "Set BASE_URL to a web server running with VITE_API_MOCK=true, e.g. BASE_URL=http://localhost:3225",
    );
    process.exit(2);
  }
  const filters = new Set(process.argv.slice(2));
  const states = STATES.filter((s) => matchesFilter(s, filters));
  if (states.length === 0) {
    console.error(`No state matches: ${[...filters].join(", ")}`);
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const report = {
    baseUrl,
    axe: axe.source,
    tags: AXE_TAGS,
    results: await readPreviousResults(),
  };
  const failures = [];
  try {
    for (const state of states) {
      for (const viewport of VIEWPORTS) {
        const id = `${state.card}-${state.name}-${viewport.label}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        if (state.role)
          await context.addCookies([
            { name: ROLE_COOKIE, value: state.role, url: baseUrl },
          ]);
        const page = await context.newPage();
        try {
          await page.goto(`${baseUrl}${state.path}`, {
            waitUntil: "domcontentloaded",
          });
          await waitForHydration(page);
          await state.prepare(page);
          if (!state.loading) await page.waitForTimeout(300); // toast/dialog motion
          const problems = [];
          const overflow = await overflowOf(page);
          if (overflow)
            problems.push(
              `horizontal overflow (${overflow.scrollWidth} > ${overflow.clientWidth})`,
            );
          const violations = await axe.run(page);
          await captureState(
            page,
            join(OUT_DIR, `${id}.png`),
            state.dialog === true,
          );
          await rm(join(OUT_DIR, `${id}.error.png`), { force: true });
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
      ? `\nAll ${states.length * VIEWPORTS.length} checks passed. Output: docs/screenshots/kds-config-scanner/`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
