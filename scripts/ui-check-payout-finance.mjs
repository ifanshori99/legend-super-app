#!/usr/bin/env node
/* global window, document, getComputedStyle -- used only inside page.evaluate callbacks */
// UI check for the payroll payout screen (legend-wnkep.6, legend-wnkep.7) and
// the finance exceptions list (legend-4oclu); brief docs/briefs/sub-payout-finance-ui.md.
//
// Screens and tabs:
//   runs        /kelola/payroll/pencairan?tab=runs        (Siap bayar)
//   approval    /kelola/payroll/pencairan?tab=approval    (Persetujuan)
//   status      /kelola/payroll/pencairan?tab=status      (Status karyawan)
//   settings    /kelola/payroll/pencairan?tab=settings    (Pengaturan PT)
//   exceptions  /kelola/akuntansi/pengecualian
//
// States follow what the two mocks support (features/ws10-payroll-payout/mock.ts,
// features/ws07-finance-exceptions/mock.ts): normal (the PT has Duitku off, so
// "duitku-off" is the normal fixture; the settings screen also opens the method
// list with Duitku disabled), empty, error, offline, loading (?mock=slow, 3 s),
// plus the action states the e2e specs drive: server refusals (self approval,
// inactive source account), MFA step-up, record-result dialogs, unknown outcome,
// range and date validation, outlet and kind filters.
//
// Not reachable in mock mode: the cash hand-over dialog (only cash-channel
// batches offer it; the mock has none), a SAVED inactive source account (the mock refuses
// to save one, so the red "Rekening sumber tidak aktif" banner never renders;
// the refusal alert is captured instead) and a payout config that does not exist
// yet (the mock always returns one), and the truncated (500+) exceptions list.
//
// For every state, at 1280x800 and 390x844: open the real page in mock mode,
// drive it to the state, take a screenshot to
// docs/screenshots/payout-finance/<screen>-<state>-<1280|390>.png (full page;
// viewport only for dialog and open-list states), run axe (wcag2a, wcag2aa,
// wcag21aa, wcag22aa) and count serious/critical violations, and check
// horizontal overflow (scrollWidth > clientWidth). The 390 run then resizes to
// 320x700 and checks overflow once more. A summary table is printed and the full
// result goes to docs/screenshots/payout-finance/ui-check.json (merged with
// earlier runs, so a subset run keeps the other states).
//
//   BASE_URL=http://localhost:3225 node scripts/ui-check-payout-finance.mjs
//   BASE_URL=... node scripts/ui-check-payout-finance.mjs runs approval-stepup   (subset)
//
// A subset argument is a screen ("runs") or a screen-state ("runs-empty").
//
// BASE_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts, e.g. `LEGEND_MOCK_PORT=3225 pnpm --filter
// @starter/web dev` with the env of that config). Never point it at a real
// deployment. No login in mock mode; the cookie `legend-mock-role` picks the
// role (default "all"). Each state gets a fresh browser context, so the
// in-browser mock store and the remembered scenario (?mock=) start clean.
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
const OUT_DIR = join(ROOT, "docs/screenshots/payout-finance");
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

const PAYOUT = "/kelola/payroll/pencairan";
const EXCEPTIONS = "/kelola/akuntansi/pengecualian";

const visible = (locator, timeout = COLD) =>
  locator.waitFor({ state: "visible", timeout });
const dialogOf = (page) => page.getByRole("dialog");
// A screen renders a table and a card list; only one is visible per width, so
// the first match in the DOM can be the hidden twin. Take the first visible one.
const text = (page, value) =>
  visible(page.getByText(value).filter({ visible: true }).first());
const retryButton = (page) =>
  page.getByRole("button", { name: /Coba lagi/i }).first();

/** `path` plus `?mock=` (or `&mock=` when the path already has a query). */
const mocked = (path, scenario) =>
  scenario ? `${path}${path.includes("?") ? "&" : "?"}mock=${scenario}` : path;

async function failNext(page, failure) {
  await page.evaluate(
    (value) => window.__legendMock.failNext("*", value),
    failure,
  );
}

/** Loading state: the 3 s mock latency keeps a busy/status region on screen. */
async function loadingShown(page) {
  await page
    .locator('[aria-busy="true"], [role="status"]')
    .first()
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => {});
}

// ---- Pencairan (payout) -----------------------------------------------------
const runsReady = (page) => text(page, "PAY-2026-11-01");

/** Selects a period in the list; the next step lives in the side panel. */
async function selectRun(page, code) {
  await runsReady(page);
  const row = page.getByRole("listitem").filter({ hasText: code });
  const pick = row.getByRole("button", { name: /^Pilih/ });
  await pick.click();
  await visible(row.getByRole("button", { name: /^Terpilih/ }));
}

const approvalReady = (page) =>
  visible(page.getByRole("button", { name: /Verifikasi & setujui/i }));

const statusReady = (page) => text(page, "Alya Putri");

const settingsReady = (page) =>
  visible(page.getByRole("combobox", { name: "Metode pembayaran" }));

async function checkReview(page) {
  await approvalReady(page);
  await page.getByRole("checkbox").first().check();
  const approve = page.getByRole("button", { name: /Verifikasi & setujui/i });
  if (!(await approve.isEnabled()))
    throw new Error(
      "Approve stays disabled after the review checkbox (the session is the batch creator?)",
    );
  return approve;
}

async function refuseApproval(page, failure, shown) {
  const approve = await checkReview(page);
  await failNext(page, failure);
  await approve.click();
  await visible(page.getByRole("alert").filter({ hasText: shown }).first());
}

/** Shell states shared by the four pencairan tabs. */
function payoutStates(screen, tab, ready, { role, extra = [] } = {}) {
  const path = `${PAYOUT}?tab=${tab}`;
  const base = { screen, role };
  return [
    {
      ...base,
      name: "normal",
      path: mocked(path, "normal"),
      prepare: ready,
    },
    {
      ...base,
      name: "loading",
      path: mocked(path, "slow"),
      loading: true,
      prepare: loadingShown,
    },
    {
      ...base,
      name: "error",
      path: mocked(path, "error"),
      prepare: (page) => visible(retryButton(page)),
    },
    {
      ...base,
      name: "offline",
      path: mocked(path, "offline"),
      prepare: (page) => visible(retryButton(page)),
    },
    ...extra.map((state) => ({
      ...base,
      path: mocked(path, "normal"),
      ...state,
    })),
  ];
}

// ---- Pengecualian finance (exceptions) --------------------------------------
const exceptionsReady = (page) =>
  visible(
    page
      .getByText(/Seluruh PT/)
      .filter({ visible: true })
      .first(),
  );

const STATES = [
  // ---- runs (Siap bayar)
  ...payoutStates("runs", "runs", runsReady, {
    extra: [
      {
        name: "empty",
        path: mocked(`${PAYOUT}?tab=runs`, "empty"),
        prepare: (page) =>
          text(page, /Belum ada (run|periode gaji) siap bayar/),
      },
      {
        // Run PAY-2026-11-02 has no batch yet: "Siapkan" creates one.
        name: "prepared",
        prepare: async (page) => {
          await selectRun(page, "PAY-2026-11-02");
          await page.getByRole("button", { name: "Siapkan" }).first().click();
          await text(page, "Pencairan disiapkan. Ajukan untuk persetujuan.");
        },
      },
      {
        // The server refuses (Duitku not available): the error shows, no batch.
        name: "prepare-refused",
        prepare: async (page) => {
          await selectRun(page, "PAY-2026-11-02");
          await failNext(page, {
            status: 409,
            code: "PAYOUT_CHANNEL_NOT_AVAILABLE",
            message:
              "Duitku belum aktif untuk PT ini. Gunakan transfer manual.",
          });
          await page.getByRole("button", { name: "Siapkan" }).first().click();
          await visible(
            page
              .getByRole("alert")
              .filter({ hasText: /Duitku belum aktif/ })
              .first(),
          );
        },
      },
    ],
  }),

  // ---- approval (Persetujuan). finance holds payroll.disburse.approve.
  ...payoutStates("approval", "approval", approvalReady, {
    role: "finance",
    extra: [
      {
        name: "empty",
        path: mocked(`${PAYOUT}?tab=approval`, "empty"),
        prepare: (page) => text(page, "Belum ada pengajuan untuk diperiksa"),
      },
      {
        name: "checked",
        prepare: checkReview,
      },
      {
        name: "refused-self-approval",
        prepare: (page) =>
          refuseApproval(
            page,
            {
              status: 403,
              code: "PAYOUT_SELF_APPROVAL",
              message:
                "Pembuat pengajuan tidak boleh menyetujui pencairannya sendiri.",
            },
            /Pembuat pengajuan tidak boleh menyetujui/,
          ),
      },
      {
        // The saved source account turned inactive: the server refuses.
        name: "refused-inactive-source",
        prepare: (page) =>
          refuseApproval(
            page,
            {
              status: 422,
              code: "PAYOUT_SOURCE_ACCOUNT_INVALID",
              message:
                "Rekening sumber tidak aktif. Pilih rekening aktif milik PT ini.",
            },
            /Rekening sumber tidak aktif/,
          ),
      },
      {
        // The server asks for a step-up: the identity check panel shows.
        name: "stepup",
        prepare: async (page) => {
          const approve = await checkReview(page);
          await failNext(page, {
            status: 403,
            code: "MFA_REQUIRED",
            message: "Verifikasi dua langkah diperlukan.",
          });
          await approve.click();
          await text(page, "Verifikasi identitas");
        },
      },
      {
        name: "approved",
        prepare: async (page) => {
          const approve = await checkReview(page);
          await approve.click();
          // The approved batch leaves the queue: the toast confirms it and the
          // tab shows the empty queue.
          await text(
            page,
            "Pencairan disetujui. Lanjutkan di tab Status karyawan.",
          );
        },
      },
    ],
  }),

  // ---- status (Status karyawan). The seeded batch holds one item each:
  // waiting, paid by the provider, paid by hand, failed and unknown outcome.
  ...payoutStates("status", "status", statusReady, {
    role: "finance",
    extra: [
      {
        name: "empty",
        path: mocked(`${PAYOUT}?tab=status`, "empty"),
        prepare: (page) => text(page, "Belum ada pencairan untuk ditampilkan"),
      },
      {
        // Unknown outcome: "Jangan kirim ulang", no pay-again control.
        name: "unknown",
        prepare: async (page) => {
          await statusReady(page);
          await text(page, /Hasil transfer belum pasti/);
        },
      },
      {
        name: "record-dialog",
        dialog: true,
        prepare: async (page) => {
          await statusReady(page);
          await page
            .getByRole("button", { name: /Catat hasil manual/ })
            .first()
            .click();
          await visible(dialogOf(page).getByText("Catat hasil transfer"));
        },
      },
      {
        name: "record-invalid",
        dialog: true,
        prepare: async (page) => {
          await statusReady(page);
          await page
            .getByRole("button", { name: /Catat hasil manual/ })
            .first()
            .click();
          await visible(dialogOf(page).getByText("Catat hasil transfer"));
          await dialogOf(page)
            .getByRole("button", { name: "Simpan hasil" })
            .click();
          await visible(
            dialogOf(page)
              .getByText(/wajib diisi/)
              .first(),
          );
        },
      },
      {
        name: "detail-dialog",
        dialog: true,
        prepare: async (page) => {
          await statusReady(page);
          await page
            .getByRole("button", {
              name: /Lihat bukti|Tinjau kegagalan|Lihat rincian/,
            })
            .first()
            .click();
          await visible(dialogOf(page).getByText("Rincian pembayaran"));
        },
      },
    ],
  }),

  // ---- settings (Pengaturan PT). The fixture PT has Duitku off.
  ...payoutStates("settings", "settings", settingsReady, {
    extra: [
      {
        // Duitku is listed but disabled, manual transfer is selectable.
        name: "duitku-off",
        dialog: true,
        openList: true,
        prepare: async (page) => {
          await settingsReady(page);
          await page
            .getByRole("combobox", { name: "Metode pembayaran" })
            .click();
          await visible(page.getByRole("option", { name: /Duitku/ }));
        },
      },
      {
        name: "invalid",
        prepare: async (page) => {
          await settingsReady(page);
          await page
            .getByRole("textbox", { name: "Batas per transfer (Rp)" })
            .fill("0");
          await page.getByRole("button", { name: "Simpan pengaturan" }).click();
          await text(page, /Isi angka rupiah lebih dari 0 dan paling banyak/);
        },
      },
      {
        // The server refuses an inactive source account; nothing is saved.
        name: "refused-inactive-source",
        prepare: async (page) => {
          await settingsReady(page);
          await page
            .getByRole("textbox", { name: "Biaya per transfer (Rp)" })
            .fill("6000");
          await failNext(page, {
            status: 422,
            code: "PAYOUT_SOURCE_ACCOUNT_INVALID",
            message: "Rekening sumber ditolak server.",
          });
          await page.getByRole("button", { name: "Simpan pengaturan" }).click();
          await visible(
            page
              .getByRole("alert")
              .filter({ hasText: /Rekening sumber/ })
              .first(),
          );
        },
      },
      {
        name: "saved",
        prepare: async (page) => {
          await settingsReady(page);
          await page
            .getByRole("textbox", { name: "Biaya per transfer (Rp)" })
            .fill("6000");
          await page.getByRole("button", { name: "Simpan pengaturan" }).click();
          await text(page, /Pengaturan pencairan tersimpan/);
        },
      },
    ],
  }),

  // ---- exceptions (Pengecualian finance)
  {
    screen: "exceptions",
    name: "normal",
    path: mocked(EXCEPTIONS, "normal"),
    prepare: exceptionsReady,
  },
  {
    screen: "exceptions",
    name: "loading",
    path: mocked(EXCEPTIONS, "slow"),
    loading: true,
    prepare: loadingShown,
  },
  {
    screen: "exceptions",
    name: "empty",
    path: mocked(EXCEPTIONS, "empty"),
    prepare: (page) => text(page, /Tidak ada pengecualian/i),
  },
  {
    screen: "exceptions",
    name: "error",
    path: mocked(EXCEPTIONS, "error"),
    prepare: (page) => visible(retryButton(page)),
  },
  {
    screen: "exceptions",
    name: "offline",
    path: mocked(EXCEPTIONS, "offline"),
    prepare: (page) => visible(retryButton(page)),
  },
  {
    // One kind: the summary card filter (URL ?kind=).
    screen: "exceptions",
    name: "kind-filtered",
    path: mocked(`${EXCEPTIONS}?kind=edge_receipt_skipped`, "normal"),
    prepare: (page) => text(page, /11-061/),
  },
  {
    // An outlet filter leaves the whole-PT payout fee out and says so.
    screen: "exceptions",
    name: "outlet-filtered",
    path: mocked(EXCEPTIONS, "normal"),
    prepare: async (page) => {
      await exceptionsReady(page);
      await page.getByRole("combobox", { name: "Outlet" }).click();
      await page.getByRole("option").nth(1).click();
      await page.getByRole("button", { name: /Terapkan filter/i }).click();
      await text(page, /Tidak dihitung untuk filter outlet/i);
    },
  },
  {
    // A window with no events: empty list that names the active filter.
    screen: "exceptions",
    name: "filtered-empty",
    path: mocked(`${EXCEPTIONS}?from=2020-01-01&to=2020-01-10`, "normal"),
    prepare: (page) => text(page, /Tidak ada pengecualian pada filter ini/i),
  },
  {
    // More than 92 days: the error shows and Terapkan filter is disabled.
    screen: "exceptions",
    name: "range-invalid",
    path: mocked(`${EXCEPTIONS}?from=2025-01-01&to=2025-06-30`, "normal"),
    prepare: (page) => text(page, /Rentang tanggal paling lama 92 hari/),
  },
  {
    screen: "exceptions",
    name: "dates-missing",
    path: mocked(EXCEPTIONS, "normal"),
    prepare: async (page) => {
      await exceptionsReady(page);
      await page.getByLabel("Dari tanggal").fill("");
      await text(page, /Isi tanggal awal dan akhir/);
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
      ? `\nAll ${ran.length} states passed. Output: docs/screenshots/payout-finance/`
      : `\n${failures.length} of ${ran.length} failed: ${failures.map(([id]) => id).join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
