#!/usr/bin/env node
/* global window, document, getComputedStyle -- used only inside page.evaluate callbacks */
// UI check for the new states of docs/briefs/sub-u5b-gap.md: S35 (back-office
// edge status screen /kelola/status-edge, legend-ph62j) and S31 (manual journal
// form: total panel balanced / unbalanced and the "Ajukan untuk persetujuan"
// button, legend-ktpc0).
//
// For every state below, at 1280x800 and 390x844: open the real page in mock
// mode, drive it to the state, take a screenshot to
// design/screens/ui-u5b/<card>-<state>-<1280|390>.png (full page; viewport only
// for dialog states) and run axe (wcag2a, wcag2aa, wcag21aa, wcag22aa). Every
// state also fails on horizontal overflow (scrollWidth > clientWidth). A
// summary of all violations goes to design/screens/ui-u5b/axe.json (merged with
// earlier runs, so a subset run keeps the other states).
//
//   BASE_URL=http://localhost:3225 node scripts/ui-check-u5b.mjs
//   BASE_URL=... node scripts/ui-check-u5b.mjs s35 s31-balanced   (subset)
//
// A subset argument is a card ("s35") or a card-state ("s35-empty").
//
// BASE_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts, e.g.
// `LEGEND_MOCK_PORT=3225 pnpm --filter @starter/web dev` with the env of that
// config). Never point it at a real deployment. No login in mock mode; the
// cookie `legend-mock-role` picks the role (default "all"). Each state gets a
// fresh browser context, so the in-browser mock store starts clean.
//
// S35 states come from `?demo=` (ws02-edge/nodes-mock.ts): none = receipt-run
// alert, normal = no alert, kosong = no node, gagal = read fails, memuat = read
// never finishes.
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
const OUT_DIR = join(ROOT, "design/screens/ui-u5b");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 800 },
  { label: "390", width: 390, height: 844 },
];
const ROLE_COOKIE = "legend-mock-role";
const COLD = 60_000; // Vite compiles a route on its first request.

const visible = (locator, timeout = COLD) =>
  locator.waitFor({ state: "visible", timeout });
const heading = (page, name) => page.getByRole("heading", { name });

// ---- Edge nodes (S35) ------------------------------------------------------
const EDGE_PATH = "/kelola/status-edge";
const receiptAlert = (page) =>
  page.getByRole("alert").filter({ hasText: "Rotasi nomor struk berulang" });
// The node list card is aria-busy while loading: real content = its heading.
const nodeList = (page) => heading(page, "Node outlet");

// ---- Manual journal (S31) --------------------------------------------------
const JOURNAL_PATH = "/kelola/akuntansi/jurnal-manual/baru";
const submitButton = (page) =>
  page.getByRole("button", { name: "Ajukan untuk persetujuan" });

async function pick(page, name, option) {
  await page.getByRole("combobox", { name }).click();
  await page.getByRole("option", { name: option }).first().click();
}

async function openJournalForm(page) {
  await visible(heading(page, "Jurnal manual baru"));
  await visible(page.getByRole("combobox", { name: "Akun baris 1" }));
}

/** Fill two lines; `credit` differs from 500000 for an unbalanced journal. */
async function fillJournal(page, credit) {
  await page.getByLabel("Keterangan").fill("Uji u5b alokasi sewa");
  await pick(page, "Akun baris 1", /6109/);
  await page.getByLabel("Debit baris 1").fill("500000");
  await pick(page, "Akun baris 2", /1103/);
  await page.getByLabel("Kredit baris 2").fill(credit);
}

const fillBalanced = (page) => fillJournal(page, "500000");
const fillUnbalanced = (page) => fillJournal(page, "400000");
const balancedBadge = (page) =>
  page.getByText("Seimbang", { exact: true }).first();

// `path` may carry ?demo= / ?mock=. `dialog`: the state is a dialog, shoot the
// viewport only. `role`: legend-mock-role cookie. `loading`: capture before the
// data arrives. `prepare` drives the page to the state and ends with something
// visible that proves it is on screen.
const STATES = [
  // S35 -- /kelola/status-edge
  {
    // Default mock: connected node plus the repeated receipt-run alert.
    card: "s35",
    name: "alert",
    path: EDGE_PATH,
    prepare: async (page) => {
      await visible(nodeList(page));
      await visible(receiptAlert(page));
    },
  },
  {
    card: "s35",
    name: "normal",
    path: `${EDGE_PATH}?demo=normal`,
    prepare: async (page) => {
      await visible(nodeList(page));
      await visible(page.getByText("Terhubung", { exact: true }).first());
    },
  },
  {
    card: "s35",
    name: "loading",
    path: `${EDGE_PATH}?demo=memuat`,
    loading: true,
    prepare: (page) => visible(page.locator('[aria-busy="true"]').first()),
  },
  {
    card: "s35",
    name: "empty",
    path: `${EDGE_PATH}?demo=kosong`,
    prepare: (page) => visible(page.getByText("Belum ada node edge")),
  },
  {
    card: "s35",
    name: "error",
    path: `${EDGE_PATH}?demo=gagal`,
    prepare: (page) => visible(page.getByText("Status edge belum bisa dimuat")),
  },
  {
    // Manual refresh that finds no alert: the confirmation message.
    card: "s35",
    name: "refreshed",
    path: `${EDGE_PATH}?demo=normal`,
    prepare: async (page) => {
      await visible(nodeList(page));
      await page.getByRole("button", { name: "Perbarui status" }).click();
      await visible(
        page.getByText(
          "Status berhasil diperbarui. Tidak ada peringatan rotasi nomor struk pada node ini.",
        ),
      );
    },
  },

  // S31 -- total panel and "Ajukan untuk persetujuan"
  {
    // Nothing entered: the panel shows its hint, submit button is on screen.
    card: "s31",
    name: "empty",
    path: JOURNAL_PATH,
    prepare: async (page) => {
      await openJournalForm(page);
      await visible(page.getByText("Total debit").first());
      await visible(submitButton(page));
    },
  },
  {
    card: "s31",
    name: "balanced",
    path: JOURNAL_PATH,
    prepare: async (page) => {
      await openJournalForm(page);
      await fillBalanced(page);
      await visible(balancedBadge(page));
      await visible(submitButton(page));
    },
  },
  {
    // Unbalanced: "Selisih" amount, "Belum seimbang" and the debit-higher alert.
    card: "s31",
    name: "unbalanced",
    path: JOURNAL_PATH,
    prepare: async (page) => {
      await openJournalForm(page);
      await fillUnbalanced(page);
      await visible(page.getByText("Jurnal belum seimbang"));
      await visible(page.getByText("Belum seimbang", { exact: true }));
    },
  },
  {
    // Submit on an unbalanced journal: blocked, nothing is sent.
    card: "s31",
    name: "submit-blocked",
    path: JOURNAL_PATH,
    prepare: async (page) => {
      await openJournalForm(page);
      await fillUnbalanced(page);
      await submitButton(page).click();
      await visible(page.getByText("Jurnal belum seimbang"));
      await page.waitForURL(/jurnal-manual\/baru/, { timeout: 5_000 });
    },
  },
  {
    // Pending state of the button while the mock answers slowly.
    card: "s31",
    name: "submit-loading",
    path: JOURNAL_PATH,
    prepare: async (page) => {
      await openJournalForm(page);
      await fillBalanced(page);
      await visible(balancedBadge(page));
      await page.evaluate(() => window.__legendMock.setScenario("slow"));
      await submitButton(page).click();
      await page.waitForTimeout(600);
      await page
        .locator("button[aria-busy='true'], button[disabled]")
        .first()
        .waitFor({ state: "attached", timeout: COLD });
    },
  },
  {
    // Balanced journal submitted: lands on the detail page of the journal.
    card: "s31",
    name: "submit-success",
    path: JOURNAL_PATH,
    prepare: async (page) => {
      await openJournalForm(page);
      await fillBalanced(page);
      await visible(balancedBadge(page));
      await submitButton(page).click();
      await page.waitForURL(/jurnal-manual\/[0-9a-f-]{36}/, {
        timeout: COLD,
      });
      await page.waitForLoadState("networkidle").catch(() => {});
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
      ? `\nAll ${states.length * VIEWPORTS.length} checks passed. Output: design/screens/ui-u5b/`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
