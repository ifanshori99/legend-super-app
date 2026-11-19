#!/usr/bin/env node
/* global window, document, getComputedStyle -- used only inside page.evaluate callbacks */
// UI check for the "Hold slip" section of the payout recon screen: release of a
// payout slip hold by two people (brief 1192, legend-6o7pc). Adapted from
// scripts/ui-check-payout-recon.mjs (same capture, axe, overflow and report engine).
//
// Screen: /kelola/payroll/rekonsiliasi, section heading "Hold slip".
//
// States follow the mock scenarios of features/ws10-payroll-payout/mock.ts
// (see e2e/payout-recon-hold.mock.spec.ts):
//   normal      ?mock=normal          one hold of each status
//   empty       ?mock=empty           "Tidak ada hold slip"
//   loading     ?mock=slow            3 s latency, "Memuat hold slip"
//   error       ?mock=error           alert with the "Muat ulang hold" retry button
//   validation  ?mock=normal          propose with an empty reason: "Usulan belum
//                                     dapat dikirim"
//   approve     ?mock=hold-approve    proposed by the other person, approve enabled
//   self        ?mock=hold-self       the signed-in user proposed, approve disabled
//   taken-over  ?mock=hold-taken-over propose, then the 409 alert "Status hold
//                                     sudah berubah"
//
// For every state, at 1280x800 and 390x844, in light and dark: open the real
// page in mock mode, drive it to the state, scroll the hold section into view,
// take a full-page screenshot to
// docs/review/img/ui1192-recon-hold-<state>-<1280|390>-<light|dark>.png, run axe
// (wcag2a, wcag2aa, wcag21aa, wcag22aa) and count serious/critical violations,
// and check horizontal overflow (scrollWidth > clientWidth). The 390 run then
// resizes to 320x700 and checks overflow once more. A summary table is printed
// and the full result goes to docs/review/img/ui1192-check.json (merged with
// earlier runs, so a subset run keeps the other states).
//
// Dark theme: the app reads localStorage "legend-theme" ("light" | "dark" |
// "system", packages/shared/src/theme) before first paint and toggles the
// `dark` class on <html> (apps/web/src/lib/theme.tsx). The script sets that key
// with an init script and asserts the class is there.
//
//   BASE_URL=http://localhost:3225 node scripts/ui-check-payout-recon-hold.mjs
//   BASE_URL=... node scripts/ui-check-payout-recon-hold.mjs recon-hold-self   (subset)
//
// A subset argument is the screen ("recon-hold") or a screen-state
// ("recon-hold-self").
//
// BASE_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts). Never point it at a real deployment. No
// login in mock mode; the cookie `legend-mock-role` picks the role: "finance"
// proposes and is the signed-in person. Each state gets a fresh browser
// context, so the in-browser mock store (sessionStorage) and scenario start
// clean. The step-up emulation is on (sessionStorage payoutMockStepUp=password,
// right password "benar-123").
//
// axe: uses `@axe-core/playwright` when installed, else injects the `axe-core`
// bundle from node_modules/.pnpm. Exit code 1 when a state fails to render,
// overflows, or axe reports a serious/critical violation.
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/review/img");
const FILE_PREFIX = "ui1192";
const REPORT_FILE = `${FILE_PREFIX}-check.json`;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 800 },
  { label: "390", width: 390, height: 844 },
];
const THEMES = ["light", "dark"];
const NARROW = { label: "320", width: 320, height: 700 };
const ROLE_COOKIE = "legend-mock-role";
const THEME_KEY = "legend-theme";
const COLD = 60_000; // Vite compiles a route on its first request.
const RIGHT_PASSWORD = "benar-123";
const REASON = "Bukti bank terbaca bersih pada pemeriksaan malam berikutnya.";
const PASSWORD_LABEL = "Konfirmasi sandi untuk pelepasan hold";

const RECON = "/kelola/payroll/rekonsiliasi";
const SCREEN = "recon-hold";

const visible = (locator, timeout = COLD) =>
  locator.waitFor({ state: "visible", timeout });
// A screen may render a table and a card list; only one is visible per width.
const text = (page, value) =>
  visible(page.getByText(value).filter({ visible: true }).first());

/** `path` plus `?mock=` (or `&mock=` when the path already has a query). */
const mocked = (path, scenario) =>
  scenario ? `${path}${path.includes("?") ? "&" : "?"}mock=${scenario}` : path;

const holdsHeading = (page) =>
  page.getByRole("heading", { name: "Hold slip", exact: true });
const holdWith = (page, status) =>
  page.locator(`[data-testid="recon-hold"][data-status="${status}"]`);
const proposeButton = (scope) =>
  scope.getByRole("button", { name: "Usulkan pelepasan" });

/** The recon screen rendered and the hold section is in view. */
async function holdsReady(page) {
  await visible(holdsHeading(page));
  await holdsHeading(page).scrollIntoViewIfNeeded();
}

/** Loading state: the 3 s mock latency keeps the "Memuat hold slip" status on screen. */
async function loadingShown(page) {
  await visible(holdsHeading(page));
  await page
    .getByRole("status", { name: "Memuat hold slip" })
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => {});
  await holdsHeading(page).scrollIntoViewIfNeeded();
}

/** The one held slip that offers a proposal (clean evidence). */
const releasable = (page) =>
  holdWith(page, "held")
    .filter({ has: proposeButton(page) })
    .first();

const STATES = [
  {
    name: "normal",
    path: mocked(RECON, "normal"),
    prepare: async (page) => {
      await holdsReady(page);
      await visible(holdWith(page, "held").first());
    },
  },
  {
    name: "empty",
    path: mocked(RECON, "empty"),
    prepare: async (page) => {
      await text(page, "Tidak ada hold slip");
      await holdsReady(page);
    },
  },
  {
    name: "loading",
    path: mocked(RECON, "slow"),
    loading: true,
    prepare: loadingShown,
  },
  {
    name: "error",
    path: mocked(RECON, "error"),
    prepare: async (page) => {
      await visible(page.getByRole("button", { name: "Muat ulang hold" }));
      await holdsReady(page);
    },
  },
  {
    // Propose with no reason: the form error shows, nothing is sent.
    name: "validation",
    path: mocked(RECON, "normal"),
    prepare: async (page) => {
      await holdsReady(page);
      const row = releasable(page);
      await visible(row);
      await proposeButton(row).click(); // opens the form
      await proposeButton(row).click(); // submits it empty
      await text(page, "Usulan belum dapat dikirim");
      await row.scrollIntoViewIfNeeded();
    },
  },
  {
    // Proposed by the other person: the signed-in finance user can approve.
    name: "approve",
    path: mocked(RECON, "hold-approve"),
    prepare: async (page) => {
      await holdsReady(page);
      const approve = holdWith(page, "proposed")
        .first()
        .getByRole("button", { name: "Setujui pelepasan" });
      await visible(approve);
      if (!(await approve.isEnabled()))
        throw new Error("Approve is disabled (hold-approve)");
      await approve.scrollIntoViewIfNeeded();
    },
  },
  {
    // The signed-in user proposed: approve is off and the reason is shown.
    name: "self",
    path: mocked(RECON, "hold-self"),
    prepare: async (page) => {
      await holdsReady(page);
      const row = holdWith(page, "proposed").first();
      const approve = row.getByRole("button", { name: "Setujui pelepasan" });
      await visible(approve);
      if (await approve.isEnabled())
        throw new Error("Approve is enabled for the proposer (hold-self)");
      await visible(row.getByText(/Anda mengusulkan pelepasan ini/));
      await row.scrollIntoViewIfNeeded();
    },
  },
  {
    // The server answers 409: a flag took the hold over; data reloads.
    name: "taken-over",
    path: mocked(RECON, "hold-taken-over"),
    prepare: async (page) => {
      await holdsReady(page);
      const row = releasable(page);
      await visible(row);
      await proposeButton(row).click();
      await row.getByLabel("Alasan pelepasan").fill(REASON);
      await row.getByLabel(PASSWORD_LABEL).fill(RIGHT_PASSWORD);
      await proposeButton(row).click();
      await visible(
        page
          .getByRole("alert")
          .filter({ hasText: "Status hold sudah berubah" }),
      );
      await visible(holdWith(page, "takenOver").first());
    },
  },
].map((state) => ({ screen: SCREEN, role: "finance", ...state }));

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

/**
 * Horizontal overflow: the page or any element is wider than the viewport.
 * The shell clips overflow inside its own container, so the document width
 * alone can read fine; measure after `expandLayout` and also list the elements
 * that stick out (outside any intentional overflow-x scroller), widest first.
 */
const overflowOf = (page) =>
  page.evaluate(() => {
    const width = window.innerWidth;
    const scrollWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    );
    const describe = (el) => {
      const parts = [];
      for (
        let n = el;
        n && n.nodeType === 1 && parts.length < 4;
        n = n.parentElement
      ) {
        let part = n.tagName.toLowerCase();
        if (n.id) part += `#${n.id}`;
        const slot = n.getAttribute("data-slot");
        if (slot) part += `[data-slot=${slot}]`;
        const cls = (n.getAttribute("class") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3);
        if (cls.length) part += `.${cls.join(".")}`;
        parts.push(part);
      }
      return parts.join(" < ");
    };
    const scrollsX = (el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const x = getComputedStyle(n).overflowX;
        if (x === "auto" || x === "scroll") return true;
      }
      return false;
    };
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.right <= width + 1) continue;
      if (getComputedStyle(el).position === "fixed" || scrollsX(el)) continue;
      offenders.push({
        selector: describe(el),
        width: Math.round(box.width),
        right: Math.round(box.right),
        text: (el.textContent ?? "").trim().slice(0, 40),
      });
    }
    offenders.sort((a, b) => b.right - a.right);
    return scrollWidth > width || offenders.length > 0
      ? { scrollWidth, clientWidth: width, offenders: offenders.slice(0, 5) }
      : null;
  });

/**
 * The back-office shell scrolls inside its own container (`main`, with
 * fixed-height ancestors), so a `fullPage` shot cuts the content. Before the
 * shot, let every scroll container and its ancestors grow to their content,
 * then take a `fullPage` shot. Dialog states shoot the viewport.
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

const stateId = (state) => `${state.screen}-${state.name}`;
const runId = (state, viewport, theme) =>
  `${stateId(state)}-${viewport.label}-${theme}`;
const fileOf = (state, viewport, theme, suffix = "") =>
  join(OUT_DIR, `${FILE_PREFIX}-${runId(state, viewport, theme)}${suffix}.png`);

const matchesFilter = (state, filters) =>
  filters.size === 0 ||
  filters.has(state.screen) ||
  filters.has(stateId(state));

async function readPreviousStates() {
  try {
    return JSON.parse(await readFile(join(OUT_DIR, REPORT_FILE), "utf8"))
      .states;
  } catch {
    return {};
  }
}

/** One state at one width and theme. The 390 run also measures overflow at 320. */
async function checkRun(browser, axe, baseUrl, state, viewport, theme) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  // Theme preference and the step-up emulation, set before the app boots.
  await context.addInitScript(
    ([themeKey, themeValue]) => {
      window.localStorage.setItem(themeKey, themeValue);
      window.sessionStorage.setItem("payoutMockStepUp", "password");
    },
    [THEME_KEY, theme],
  );
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
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    if (isDark !== (theme === "dark"))
      throw new Error(
        `Theme ${theme} not applied (html.dark is ${isDark}); check the "${THEME_KEY}" storage key`,
      );
    await state.prepare(page);
    if (!state.loading) await page.waitForTimeout(300); // toast/dialog motion
    const violations = await axe.run(page);
    await captureState(
      page,
      fileOf(state, viewport, theme),
      state.dialog === true,
    );
    const overflow = await overflowOf(page); // after the layout was expanded
    await rm(fileOf(state, viewport, theme, ".error"), { force: true });
    const result = {
      blocking: violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ""))
        .length,
      overflow,
      violations: summarize(violations),
    };
    if (viewport.label === "390") {
      await page.setViewportSize({
        width: NARROW.width,
        height: NARROW.height,
      });
      await page.waitForTimeout(300); // let the layout reflow
      result.overflow320 = await overflowOf(page);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await page
      .screenshot({
        path: fileOf(state, viewport, theme, ".error"),
        fullPage: true,
      })
      .catch(() => {});
    return { error: message.split("\n")[0] };
  } finally {
    await context.close();
  }
}

const runProblems = (result) => {
  if (result.error) return [`error: ${result.error}`];
  const problems = [];
  if (result.blocking > 0)
    problems.push(`${result.blocking} serious/critical axe violation`);
  if (result.overflow)
    problems.push(
      `overflow ${result.overflow.scrollWidth} > ${result.overflow.clientWidth}`,
    );
  if (result.overflow320)
    problems.push(
      `overflow at 320 (${result.overflow320.scrollWidth} > ${result.overflow320.clientWidth})`,
    );
  return problems;
};

const cell = (result, field) => {
  if (!result) return "-";
  if (result.error) return "ERR";
  if (field === "axe") return String(result.blocking);
  if (field === "overflow") return result.overflow ? "YES" : "no";
  return result.overflow320 ? "YES" : "no";
};

function printTable(rows) {
  const header = [
    "state",
    "axe 1280 L/D",
    "axe 390 L/D",
    "ov 1280 L/D",
    "ov 390 L/D",
    "ov 320 L/D",
    "result",
  ];
  const pair = (entry, width, field) =>
    THEMES.map((theme) => cell(entry.runs[`${width}-${theme}`], field)).join(
      "/",
    );
  const lines = rows.map(([id, entry]) => [
    id,
    pair(entry, "1280", "axe"),
    pair(entry, "390", "axe"),
    pair(entry, "1280", "overflow"),
    pair(entry, "390", "overflow"),
    pair(entry, "390", "320"),
    entry.status.toUpperCase(),
  ]);
  const sizes = header.map((title, index) =>
    Math.max(title.length, ...lines.map((line) => line[index].length)),
  );
  const format = (line) =>
    line.map((value, index) => value.padEnd(sizes[index])).join("  ");
  console.log(`\n${format(header)}`);
  console.log(sizes.map((size) => "-".repeat(size)).join("  "));
  for (const line of lines) console.log(format(line));
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
    states: await readPreviousStates(),
  };
  const ran = [];
  try {
    for (const state of states) {
      const id = stateId(state);
      const runs = {};
      const problems = [];
      for (const viewport of VIEWPORTS) {
        for (const theme of THEMES) {
          const result = await checkRun(
            browser,
            axe,
            baseUrl,
            state,
            viewport,
            theme,
          );
          runs[`${viewport.label}-${theme}`] = result;
          for (const problem of runProblems(result))
            problems.push(`${viewport.label} ${theme}: ${problem}`);
        }
      }
      const status = problems.length === 0 ? "pass" : "fail";
      report.states[id] = {
        status,
        ...(problems.length ? { problems } : {}),
        runs,
      };
      ran.push([id, report.states[id]]);
      console.log(`${status === "pass" ? "PASS" : "FAIL"} ${id}`);
      for (const problem of problems) console.log(`  ${problem}`);
    }
  } finally {
    await browser.close();
    await writeFile(
      join(OUT_DIR, REPORT_FILE),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  printTable(ran);
  const failures = ran.filter(([, entry]) => entry.status !== "pass");
  console.log(
    failures.length === 0
      ? `\nAll ${ran.length} states passed. Output: docs/review/img/${FILE_PREFIX}-*`
      : `\n${failures.length} of ${ran.length} failed: ${failures.map(([id]) => id).join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
