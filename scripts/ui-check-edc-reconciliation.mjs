#!/usr/bin/env node
/* global window, document, getComputedStyle -- used only inside page.evaluate callbacks */
// UI check for the EDC reconciliation screen (bead legend-khi8n; brief
// docs/briefs/sub-865-edc-recon-ui.md, mockup design/mockups/payments/edc-reconciliation).
//
// Screen: /kelola/pembayaran/edc-rekonsiliasi (mock mode, sample queue).
// States: list (normal), loading (?mock=slow), empty, error, detail (unknown),
// detail-approved, detail-declined, wire-locked (EDC-1061, terminal call open),
// too-early (EDC-1063), validation (note missing), resolve-confirm (dialog),
// save-error (forced CONFLICT), amount-mismatch (forced CONFLICT with the API's
// amount sentence), mfa (forced MFA_REQUIRED), success (success dialog) and done
// (dialog closed, row left the queue).
// Copy, labels and rows follow the final catalogs (edc-recon-queue.ts,
// edc-recon-resolve.ts) and the mock queue (features/edc-reconciliation/mock.ts);
// the assumptions are the same as in e2e/edc-reconciliation.mock.spec.ts.
//
// For every state, at 1280x800 and 390x844: open the real page in mock mode,
// drive it to the state, take a screenshot to
// docs/screenshots/edc-reconciliation/<screen>-<state>-<1280|390>.png, run axe
// (wcag2a, wcag2aa, wcag21aa, wcag22aa) and count serious/critical violations,
// and check horizontal overflow. The 390 run also checks 320x700. A summary
// table is printed and the result goes to ui-check.json (merged with earlier
// runs, so a subset run keeps the other states).
//
//   BASE_URL=http://localhost:3225 node scripts/ui-check-edc-reconciliation.mjs
//   BASE_URL=... node scripts/ui-check-edc-reconciliation.mjs detail resolve-confirm   (subset: screen or screen-state)
//
// BASE_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts). Never point it at a real deployment. The
// cookie `legend-mock-role` picks the role (default "all", which holds
// payment.reconcile). Each state gets a fresh browser context. Run through
// `heavy --browser node scripts/ui-check-edc-reconciliation.mjs`.
// axe: `@axe-core/playwright` when installed, else the `axe-core` bundle.
// Exit code 1 when a state fails to render, overflows, or axe reports a
// serious/critical violation.
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/screenshots/edc-reconciliation");
const REPORT_FILE = "ui-check.json";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 800 },
  { label: "390", width: 390, height: 844 },
];
const NARROW = { label: "320", width: 320, height: 700 };
const ROLE_COOKIE = "legend-mock-role";
const COLD = 60_000; // Vite compiles a route on its first request.

const ROUTE = "/kelola/pembayaran/edc-rekonsiliasi";

const visible = (locator, timeout = COLD) =>
  locator.waitFor({ state: "visible", timeout });
const text = (page, value) =>
  visible(page.getByText(value).filter({ visible: true }).first());
const mocked = (scenario) => `${ROUTE}?mock=${scenario}`;
const rowOf = (page, id) =>
  page
    .locator("tr, li")
    .filter({ hasText: id })
    .filter({ visible: true })
    .first();
const dialogOf = (page) =>
  page.getByRole("dialog", { name: "Konfirmasi rekonsiliasi" });
const review = (page) =>
  page.getByRole("button", { name: "Tinjau penyelesaian" });
const note = (page) => page.getByLabel(/Catatan pemeriksaan/);
const confirmBox = (page) =>
  dialogOf(page).getByRole("checkbox", { name: /Saya telah memeriksa bukti/ });

async function failNext(page, failure) {
  await page.evaluate(
    (value) => window.__legendMock.failNext("*", value),
    failure,
  );
}

const listReady = (page) => visible(rowOf(page, "EDC-1048"));

async function inspect(page, id) {
  const button = page.getByRole("button", { name: `Periksa transaksi ${id}` });
  await visible(button);
  await button.click();
  await visible(page.getByRole("heading", { name: id, level: 3 }));
  await visible(page.getByRole("heading", { name: "Ringkasan & bukti" }));
}

async function pickSource(page, label) {
  await page.getByRole("combobox", { name: /Sumber bukti/ }).click();
  await page.getByRole("option", { name: label }).click();
}

async function fillApproved(page) {
  await page.getByRole("radio", { name: /Approved/ }).check();
  await pickSource(page, "Struk terminal");
  await page.getByLabel(/Nominal pada bukti/).fill("425000");
  await note(page).fill("Struk terminal cocok: trace 004821, kode 082416.");
}

async function openConfirm(page) {
  await inspect(page, "EDC-1048");
  await fillApproved(page);
  await review(page).click();
  await visible(dialogOf(page));
  await confirmBox(page).check();
}

const submitApproved = (page) =>
  dialogOf(page).getByRole("button", { name: "Selesaikan approved" });

const STATES = [
  {
    screen: "list",
    name: "normal",
    path: mocked("normal"),
    prepare: listReady,
  },
  {
    screen: "list",
    name: "loading",
    path: mocked("slow"),
    loading: true,
    prepare: async (page) => {
      await page
        .locator('[aria-busy="true"], [role="status"]')
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
    },
  },
  {
    screen: "list",
    name: "empty",
    path: mocked("empty"),
    prepare: (page) => text(page, "Tidak ada transaksi yang ditandai"),
  },
  {
    screen: "list",
    name: "error",
    path: mocked("error"),
    prepare: (page) =>
      visible(page.getByRole("button", { name: /Coba lagi/i }).first()),
  },
  {
    screen: "detail",
    name: "unknown",
    path: mocked("normal"),
    prepare: (page) => inspect(page, "EDC-1048"),
  },
  {
    screen: "detail",
    name: "approved",
    path: mocked("normal"),
    prepare: (page) => inspect(page, "EDC-1052"),
  },
  {
    screen: "detail",
    name: "declined",
    path: mocked("normal"),
    prepare: (page) => inspect(page, "EDC-1057"),
  },
  {
    screen: "detail",
    name: "wire-locked",
    path: mocked("normal"),
    prepare: async (page) => {
      await inspect(page, "EDC-1061");
      await visible(
        page
          .getByRole("status")
          .filter({ hasText: "Terminal masih memproses transaksi ini" }),
      );
      await visible(
        page.getByRole("button", { name: "Penyelesaian terkunci" }),
      );
    },
  },
  {
    screen: "detail",
    name: "too-early",
    path: mocked("normal"),
    prepare: async (page) => {
      await inspect(page, "EDC-1063");
      await visible(
        page
          .getByRole("status")
          .filter({ hasText: /Bisa diperiksa pukul \d{2}\.\d{2} WIB/ }),
      );
      await visible(
        page.getByRole("button", { name: "Penyelesaian terkunci" }),
      );
    },
  },
  {
    screen: "detail",
    name: "validation",
    path: mocked("normal"),
    prepare: async (page) => {
      await inspect(page, "EDC-1048");
      await page.getByRole("radio", { name: /Declined/ }).check();
      await review(page).click();
      await note(page)
        .and(page.locator('[aria-invalid="true"]'))
        .waitFor({ state: "visible", timeout: COLD });
      await text(page, "Catatan pemeriksaan wajib diisi.");
    },
  },
  {
    screen: "resolve",
    name: "confirm",
    path: mocked("normal"),
    dialog: true,
    prepare: openConfirm,
  },
  {
    screen: "resolve",
    name: "save-error",
    path: mocked("normal"),
    dialog: true,
    prepare: async (page) => {
      await openConfirm(page);
      await failNext(page, {
        status: 409,
        code: "CONFLICT",
        message: "Terminal masih memproses transaksi ini.",
      });
      await submitApproved(page).click();
      await visible(
        dialogOf(page)
          .getByRole("alert")
          .filter({ hasText: "Transaksi tidak dapat diselesaikan sekarang" }),
      );
      await visible(
        dialogOf(page).getByRole("button", { name: "Muat ulang daftar" }),
      );
    },
  },
  {
    screen: "resolve",
    name: "amount-mismatch",
    path: mocked("normal"),
    dialog: true,
    prepare: async (page) => {
      await openConfirm(page);
      // The API answers this refusal as a plain CONFLICT with this sentence.
      await failNext(page, {
        status: 409,
        code: "CONFLICT",
        message: "Nominal di terminal EDC tidak sama dengan tagihan.",
      });
      await submitApproved(page).click();
      await visible(
        dialogOf(page)
          .getByRole("alert")
          .filter({ hasText: "Nominal tidak sama dengan permintaan" }),
      );
    },
  },
  {
    screen: "resolve",
    name: "mfa",
    path: mocked("normal"),
    dialog: true,
    prepare: async (page) => {
      await openConfirm(page);
      await failNext(page, {
        status: 403,
        code: "MFA_REQUIRED",
        message: "Verifikasi dua langkah diperlukan.",
      });
      await submitApproved(page).click();
      await visible(dialogOf(page).getByText("Verifikasi identitas"));
      await visible(dialogOf(page).getByText(/aplikasi autentikator Anda/));
    },
  },
  {
    screen: "resolve",
    name: "success",
    path: mocked("normal"),
    dialog: true,
    prepare: async (page) => {
      await openConfirm(page);
      await submitApproved(page).click();
      await visible(
        dialogOf(page)
          .getByRole("status")
          .filter({ hasText: "Rekonsiliasi diselesaikan · EDC-1048" }),
      );
    },
  },
  {
    screen: "resolve",
    name: "done",
    path: mocked("normal"),
    prepare: async (page) => {
      await openConfirm(page);
      await submitApproved(page).click();
      await dialogOf(page).getByRole("button", { name: "Selesai" }).click();
      // The sale left the queue and the page title took focus.
      await page
        .locator("tr, li")
        .filter({ hasText: "EDC-1048" })
        .filter({ visible: true })
        .first()
        .waitFor({ state: "detached", timeout: COLD });
      await visible(
        page.getByRole("heading", { name: "Rekonsiliasi EDC", level: 2 }),
      );
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
 * then take a `fullPage` shot. Dialog and open-list states shoot the viewport.
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

/** One state at one width. The 390 run also measures overflow at 320. */
async function checkWidth(browser, axe, baseUrl, state, viewport) {
  const id = `${stateId(state)}-${viewport.label}`;
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
    const shot = () =>
      captureState(page, join(OUT_DIR, `${id}.png`), state.dialog === true);
    let violations;
    if (state.openList) {
      // Shoot the open list, then close it: an open Radix popover marks the
      // rest of the page aria-hidden, which axe reports as aria-hidden-focus.
      await shot();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      violations = await axe.run(page);
    } else {
      violations = await axe.run(page);
      await shot();
    }
    const overflow = await overflowOf(page); // after the layout was expanded
    await rm(join(OUT_DIR, `${id}.error.png`), { force: true });
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
      .screenshot({ path: join(OUT_DIR, `${id}.error.png`), fullPage: true })
      .catch(() => {});
    return { error: message.split("\n")[0] };
  } finally {
    await context.close();
  }
}

const widthProblems = (result) => {
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
    "axe 1280",
    "axe 390",
    "ov 1280",
    "ov 390",
    "ov 320",
    "result",
  ];
  const lines = rows.map(([id, entry]) => [
    id,
    cell(entry.widths["1280"], "axe"),
    cell(entry.widths["390"], "axe"),
    cell(entry.widths["1280"], "overflow"),
    cell(entry.widths["390"], "overflow"),
    cell(entry.widths["390"], "320"),
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
      const widths = {};
      const problems = [];
      for (const viewport of VIEWPORTS) {
        const result = await checkWidth(browser, axe, baseUrl, state, viewport);
        widths[viewport.label] = result;
        for (const problem of widthProblems(result))
          problems.push(`${viewport.label}: ${problem}`);
      }
      const status = problems.length === 0 ? "pass" : "fail";
      report.states[id] = {
        status,
        ...(problems.length ? { problems } : {}),
        widths,
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
      ? `\nAll ${ran.length} states passed. Output: docs/screenshots/edc-reconciliation/`
      : `\n${failures.length} of ${ran.length} failed: ${failures.map(([id]) => id).join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
