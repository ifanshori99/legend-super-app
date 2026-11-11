#!/usr/bin/env node
/* global window, document, getComputedStyle -- used only inside page.evaluate callbacks */
// UI check for the back-office configuration cards (sub-brief
// docs/briefs/sub-ui-bo-config.md): woc1 (tax rules, settings drafts), d5pz
// (warning before deactivating the only food_beverage rule), j0kd (settings
// hub), 0frf (menu item station routing), 5ac3 (outlet on journal lines) and
// s7szu (receipt-run alert on the edge status screen).
//
// For every state below, at 1280x800 and 390x844: open the real page in mock
// mode, drive it to the state (the same steps as e2e/legend-<card>.mock.spec.ts),
// take a screenshot to design/screens/ui-bo-config/<card>-<state>-<1280|390>.png
// (full page; viewport only for dialog states) and run axe (wcag2a, wcag2aa,
// wcag21aa, wcag22aa). Every state also fails on horizontal overflow
// (scrollWidth > clientWidth). A summary of all violations goes to
// design/screens/ui-bo-config/axe.json (merged with earlier runs, so a subset
// run keeps the other states).
//
//   BASE_URL=http://localhost:3225 node scripts/ui-check-bo-config.mjs
//   BASE_URL=... node scripts/ui-check-bo-config.mjs woc1 d5pz-warning   (subset)
//
// A subset argument is a card ("woc1") or a card-state ("woc1-add").
//
// BASE_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts, e.g.
// `LEGEND_MOCK_PORT=3225 pnpm --filter @starter/web dev` with the env of that
// config). Never point it at a real deployment. No login in mock mode; the
// cookie `legend-mock-role` picks the role (default "all"). Each state gets a
// fresh browser context, so the in-browser mock store and the remembered
// scenario (?mock=) start clean.
//
// The s7szu mockup is not in design/mockups/backoffice on this branch, so its
// states follow e2e/legend-s7szu.mock.spec.ts.
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
const OUT_DIR = join(ROOT, "design/screens/ui-bo-config");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 800 },
  { label: "390", width: 390, height: 844 },
];
const ROLE_COOKIE = "legend-mock-role";
const COLD = 60_000; // Vite compiles a route on its first request.
const ESPRESSO_ID = "00000000-0000-4000-8000-000000001000"; // fixture item
const ENTITY = "Entitas · tanpa outlet";

const visible = (locator, timeout = COLD) =>
  locator.waitFor({ state: "visible", timeout });
const heading = (page, name) => page.getByRole("heading", { name });
const dialogOf = (page) => page.getByRole("dialog");

// ---- Tax (woc1, d5pz) ------------------------------------------------------
// Below md the rule table is hidden and each rule is a card (<li>), so match
// the visible row of either layout.
const ruleRows = (page) => page.locator("tr:visible, li:visible");
const draftRow = (page) => ruleRows(page).filter({ hasText: "draf revisi" });
const liveRow = (page) =>
  ruleRows(page)
    .filter({ hasText: "PBJT-FNB" })
    .filter({ hasText: "Berlaku sekarang" });

const taxReady = (page) => visible(liveRow(page));

async function openAddRule(page) {
  await page.getByRole("button", { name: "Buat aturan" }).first().click();
  await visible(heading(dialogOf(page), "Buat aturan pajak"));
}

async function openNewVersion(page) {
  await liveRow(page).getByRole("button", { name: "Versi baru" }).click();
  await visible(heading(dialogOf(page), "Versi baru PBJT-FNB"));
}

/** Versi baru -> Aturan aktif off -> Simpan draf: the d5pz confirm dialog. */
async function startDeactivation(page) {
  await openNewVersion(page);
  const form = dialogOf(page);
  await form.getByRole("switch", { name: "Aturan aktif" }).click();
  await form.getByRole("button", { name: "Simpan draf" }).click();
  await visible(heading(dialogOf(page), "Nonaktifkan aturan pajak terakhir?"));
}

/** Opsi perhitungan has no seeded draft: create one when none exists. */
async function ensureSettingsDraft(page) {
  await visible(page.getByText("Opsi yang berlaku"));
  const discard = page.getByRole("button", { name: /Buang draf/ });
  if ((await discard.count()) > 0) return;
  await page.getByRole("button", { name: "Versi baru" }).first().click();
  await dialogOf(page).getByRole("button", { name: "Simpan draf" }).click();
  await visible(discard.first());
}

// The toast is also echoed in a live region: two matches, take the first.
const discardSuccess = (page) =>
  visible(
    page
      .getByText("Draf berhasil dibuang. Versi yang diterbitkan tetap berlaku.")
      .first(),
  );

// ---- Journal (5ac3) --------------------------------------------------------
async function pick(page, name, option) {
  await page.getByRole("combobox", { name }).click();
  await page.getByRole("option", { name: option }).first().click();
}

async function fillBalancedJournal(page) {
  await page.getByLabel("Keterangan").fill("Uji 5ac3 alokasi sewa");
  await pick(page, "Akun baris 1", /6109/);
  await page.getByLabel("Debit baris 1").fill("500000");
  await page.getByRole("combobox", { name: "Outlet baris 1" }).click();
  await page.getByRole("option").nth(1).click(); // first real outlet
  await pick(page, "Akun baris 2", /1103/);
  await page.getByLabel("Kredit baris 2").fill("500000");
}

// ---- Menu item station routing (0frf) --------------------------------------
// The "Routing stasiun" heading renders before the stations load, together with
// "Memuat pengaturan stasiun…": wait until that loading text is gone.
async function stationReady(page) {
  await visible(heading(page, "Routing stasiun"));
  await page
    .getByText("Memuat pengaturan stasiun…")
    .waitFor({ state: "hidden", timeout: COLD });
}

// ---- Edge (s7szu) ----------------------------------------------------------
// The "Perbarui status" button is in the header, so it is on screen while the
// status is still loading (skeleton, aria-busy). Real content = the status card.
const edgeStatusCard = (page) => heading(page, "Status koneksi");
const edgeReady = (page) => visible(edgeStatusCard(page));

async function edgeSettled(page) {
  await page
    .locator('[aria-busy="true"]')
    .first()
    .waitFor({ state: "hidden", timeout: COLD });
}

async function setReceiptRunAlert(page, on) {
  await page.waitForFunction(() => window.__legendEdgeMock !== undefined);
  await page.evaluate(
    (value) => window.__legendEdgeMock?.setReceiptRunAlert(value),
    on,
  );
}
const receiptAlert = (page) =>
  page.getByRole("alert").filter({ hasText: "Rotasi nomor struk berulang" });

async function raiseReceiptRunAlert(page) {
  await setReceiptRunAlert(page, true);
  await page.getByRole("button", { name: "Perbarui status" }).click();
  await visible(receiptAlert(page));
}

// `path` may carry ?mock=. `dialog`: the state is a dialog, shoot the viewport
// only. `role`: legend-mock-role cookie. `loading`: capture before the data
// arrives (use ?mock=slow, 3 s latency). `prepare` drives the page to the
// state and ends with something visible that proves it is on screen.
const STATES = [
  // woc1 -- tax rules (/kelola/pajak)
  {
    card: "woc1",
    name: "normal",
    path: "/kelola/pajak",
    prepare: taxReady,
  },
  {
    card: "woc1",
    name: "loading",
    path: "/kelola/pajak?mock=slow",
    loading: true,
    prepare: async () => {},
  },
  {
    card: "woc1",
    name: "empty",
    path: "/kelola/pajak?mock=empty",
    prepare: (page) => visible(page.getByText("Belum ada aturan pajak")),
  },
  {
    card: "woc1",
    name: "error",
    path: "/kelola/pajak?mock=error",
    prepare: (page) => visible(page.getByText("Data tidak dapat dimuat")),
  },
  {
    card: "woc1",
    name: "add",
    path: "/kelola/pajak",
    dialog: true,
    prepare: async (page) => {
      await taxReady(page);
      await openAddRule(page);
    },
  },
  {
    card: "woc1",
    name: "edit",
    path: "/kelola/pajak",
    dialog: true,
    prepare: async (page) => {
      await taxReady(page);
      const edit = draftRow(page).getByRole("button", { name: /^Ubah/ });
      if ((await edit.count()) > 0) {
        await edit.first().click();
        await visible(heading(dialogOf(page), /Ubah draf aturan pajak/));
      } else {
        await openNewVersion(page);
      }
    },
  },
  {
    card: "woc1",
    name: "invalid",
    path: "/kelola/pajak",
    dialog: true,
    prepare: async (page) => {
      await taxReady(page);
      await openAddRule(page);
      const dialog = dialogOf(page);
      await dialog.getByLabel("Kode aturan").fill("PBJT-KOSONG");
      await dialog.getByLabel("Nama aturan").fill("Tanpa tarif");
      await dialog.getByRole("button", { name: "Simpan draf" }).click();
      await visible(
        dialog.getByText(
          "Tulis angka 0–100, maksimal dua desimal (misalnya 10 atau 5,5).",
        ),
      );
    },
  },
  {
    card: "woc1",
    name: "discard",
    path: "/kelola/pajak",
    dialog: true,
    prepare: async (page) => {
      await taxReady(page);
      await draftRow(page)
        .getByRole("button", { name: /Buang draf/ })
        .click();
      await visible(heading(dialogOf(page), "Buang draf aturan pajak?"));
    },
  },
  {
    card: "woc1",
    name: "success",
    path: "/kelola/pajak",
    prepare: async (page) => {
      await taxReady(page);
      await draftRow(page)
        .getByRole("button", { name: /Buang draf/ })
        .click();
      await dialogOf(page)
        .getByRole("button", { name: "Buang draf", exact: true })
        .click();
      await discardSuccess(page);
    },
  },
  {
    card: "woc1",
    name: "settings",
    path: "/kelola/pajak/opsi",
    prepare: (page) => visible(page.getByText("Opsi yang berlaku")),
  },
  {
    card: "woc1",
    name: "settings-edit",
    path: "/kelola/pajak/opsi",
    dialog: true,
    prepare: async (page) => {
      await ensureSettingsDraft(page);
      await page.getByRole("button", { name: /^Ubah/ }).first().click();
      await visible(heading(dialogOf(page), "Ubah draf opsi perhitungan"));
    },
  },
  {
    card: "woc1",
    name: "settings-discard",
    path: "/kelola/pajak/opsi",
    dialog: true,
    prepare: async (page) => {
      await ensureSettingsDraft(page);
      await page
        .getByRole("button", { name: /Buang draf/ })
        .first()
        .click();
      await visible(heading(dialogOf(page), "Buang draf opsi perhitungan?"));
    },
  },
  {
    card: "woc1",
    name: "settings-success",
    path: "/kelola/pajak/opsi",
    prepare: async (page) => {
      await ensureSettingsDraft(page);
      await page
        .getByRole("button", { name: /Buang draf/ })
        .first()
        .click();
      await dialogOf(page)
        .getByRole("button", { name: "Buang draf", exact: true })
        .click();
      await discardSuccess(page);
    },
  },

  // d5pz -- warning before deactivating the only food_beverage rule
  {
    card: "d5pz",
    name: "warning",
    path: "/kelola/pajak",
    dialog: true,
    prepare: async (page) => {
      await taxReady(page);
      await startDeactivation(page);
      await visible(dialogOf(page).getByText("Transaksi dapat gagal"));
    },
  },
  {
    // Confirm while the mock answers slowly: the dialog shows its pending state.
    card: "d5pz",
    name: "loading",
    path: "/kelola/pajak",
    dialog: true,
    prepare: async (page) => {
      await taxReady(page);
      await startDeactivation(page);
      await page.evaluate(() => window.__legendMock.setScenario("slow"));
      await dialogOf(page)
        .getByRole("button", { name: "Tetap nonaktifkan" })
        .click();
      await page.waitForTimeout(600);
    },
  },
  {
    // Confirm while the next call fails: the dialog shows its error.
    card: "d5pz",
    name: "error",
    path: "/kelola/pajak",
    dialog: true,
    prepare: async (page) => {
      await taxReady(page);
      await startDeactivation(page);
      await page.evaluate(() =>
        window.__legendMock.failNext("*", {
          status: 500,
          code: "INTERNAL_ERROR",
        }),
      );
      await dialogOf(page)
        .getByRole("button", { name: "Tetap nonaktifkan" })
        .click();
      await visible(page.getByRole("alert").first());
    },
  },
  {
    card: "d5pz",
    name: "success",
    path: "/kelola/pajak",
    prepare: async (page) => {
      await taxReady(page);
      await startDeactivation(page);
      await dialogOf(page)
        .getByRole("button", { name: "Tetap nonaktifkan" })
        .click();
      await visible(
        page
          .getByText(
            "Penonaktifan disimpan sebagai draf. Terbitkan agar berlaku.",
            { exact: true },
          )
          .first(),
      );
    },
  },

  // j0kd -- settings hub (/kelola/pengaturan)
  {
    card: "j0kd",
    name: "normal",
    path: "/kelola/pengaturan",
    role: "all",
    prepare: (page) =>
      visible(
        page.locator("#main-content").getByRole("link", {
          name: /Kamus istilah/,
        }),
      ),
  },
  {
    // tenant_admin: no Super Admin, so no "Kamus istilah".
    card: "j0kd",
    name: "limited",
    path: "/kelola/pengaturan",
    role: "tenant_admin",
    prepare: (page) =>
      visible(
        page.locator("#main-content").getByRole("link", { name: /Tema/ }),
      ),
  },
  {
    // finance holds no tenant settings permission (the nearest reachable state
    // to the mockup's empty hub; see e2e/legend-j0kd.mock.spec.ts).
    card: "j0kd",
    name: "empty",
    path: "/kelola/pengaturan",
    role: "finance",
    prepare: (page) =>
      visible(
        page
          .locator("#main-content")
          .getByRole("link", { name: /Keamanan akun/ }),
      ),
  },
  {
    card: "j0kd",
    name: "loading",
    path: "/kelola/pengaturan?mock=slow",
    role: "all",
    loading: true,
    prepare: async () => {},
  },
  {
    card: "j0kd",
    name: "error",
    path: "/kelola/pengaturan?mock=error",
    role: "all",
    prepare: async (page) => {
      await page.waitForLoadState("networkidle").catch(() => {});
    },
  },

  // 0frf -- station routing on the menu item editor
  {
    card: "0frf",
    name: "normal",
    path: `/kelola/menu/${ESPRESSO_ID}?mock=normal`,
    prepare: stationReady,
  },
  {
    card: "0frf",
    name: "loading",
    path: `/kelola/menu/${ESPRESSO_ID}?mock=slow`,
    loading: true,
    prepare: async () => {},
  },
  {
    card: "0frf",
    // Mockup empty state: an outlet without its own stations. (?mock=empty
    // has no items at all, which is the item not-found page.)
    name: "empty",
    path: `/kelola/menu/${ESPRESSO_ID}?mock=normal`,
    prepare: async (page) => {
      await stationReady(page);
      await page.getByRole("combobox", { name: /^Outlet/ }).click();
      // Fixture stations all belong to the default outlet (Bandung).
      await page
        .getByRole("option", { name: "Cafe Legend Bandung 2 (contoh)" })
        .click();
      await visible(
        page.getByText(
          "Belum ada stasiun khusus di outlet ini. Item tetap mengikuti tipe stasiun.",
        ),
      );
    },
  },
  {
    card: "0frf",
    // ?mock=error fails the item itself: the whole editor shows its error
    // state with "Coba lagi" (mockup replaces the content the same way).
    name: "error",
    path: `/kelola/menu/${ESPRESSO_ID}?mock=error`,
    prepare: async (page) => {
      await visible(page.getByRole("button", { name: "Coba lagi" }).first());
    },
  },
  {
    // The outlet-only station replaces the type for that outlet.
    card: "0frf",
    name: "override",
    path: `/kelola/menu/${ESPRESSO_ID}?mock=normal`,
    prepare: async (page) => {
      await stationReady(page);
      await page.getByRole("combobox", { name: /^Stasiun khusus/ }).click();
      await page.getByRole("option").nth(1).click(); // first real station
      await visible(page.getByText(/^Stasiun khusus: /));
    },
  },
  {
    // New item without a station type: "Pilih tipe stasiun untuk item ini."
    card: "0frf",
    name: "invalid",
    path: "/kelola/menu/baru?mock=normal",
    prepare: async (page) => {
      await visible(page.getByRole("combobox", { name: "Tipe stasiun" }));
      await page
        .getByText("Memuat pengaturan stasiun…")
        .waitFor({ state: "hidden", timeout: COLD });
      await page.getByRole("button", { name: "Simpan item" }).click();
      await visible(page.getByText("Pilih tipe stasiun untuk item ini."));
    },
  },
  {
    card: "0frf",
    name: "success",
    path: `/kelola/menu/${ESPRESSO_ID}?mock=normal`,
    prepare: async (page) => {
      await stationReady(page);
      // "Simpan item" stays disabled until the form differs from the item.
      const name = page.getByLabel("Nama item");
      await name.fill(`${await name.inputValue()} 2`);
      await page.getByRole("button", { name: "Simpan item" }).click();
      await visible(page.getByText("Perubahan item tersimpan.").first());
    },
  },

  // 5ac3 -- outlet on journal lines
  {
    card: "5ac3",
    name: "normal",
    path: "/kelola/akuntansi/jurnal-manual/baru",
    prepare: async (page) => {
      await visible(heading(page, "Jurnal manual baru"));
      await visible(page.getByRole("combobox", { name: "Outlet baris 1" }));
    },
  },
  {
    card: "5ac3",
    name: "loading",
    path: "/kelola/akuntansi/jurnal-manual/baru?mock=slow",
    loading: true,
    prepare: async () => {},
  },
  {
    card: "5ac3",
    name: "empty",
    path: "/kelola/akuntansi/jurnal-manual/baru?mock=empty",
    prepare: async (page) => {
      await page.waitForLoadState("networkidle").catch(() => {});
    },
  },
  {
    // ?mock=error would fail the legal-entity list too; fail only the account
    // list and reach the form from the journal list (as the e2e spec does).
    card: "5ac3",
    name: "error",
    path: "/kelola/akuntansi/jurnal-manual",
    prepare: async (page) => {
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.evaluate(() =>
        window.__legendMock.failNext(
          "GET /api/accounting/legal-entities/:legalEntityId/accounts",
          { status: 404, code: "NOT_FOUND" },
        ),
      );
      await page.getByRole("link", { name: "Jurnal manual baru" }).click();
      await visible(page.getByText("Data jurnal belum bisa dimuat"));
    },
  },
  {
    // Unbalanced journal: "Selisih Rp ..." and "Simpan draf" disabled.
    card: "5ac3",
    name: "validation",
    path: "/kelola/akuntansi/jurnal-manual/baru",
    prepare: async (page) => {
      await visible(heading(page, "Jurnal manual baru"));
      await page.getByLabel("Keterangan").fill("Uji 5ac3 tidak seimbang");
      await pick(page, "Akun baris 1", /6109/);
      await page.getByLabel("Debit baris 1").fill("500000");
      await pick(page, "Akun baris 2", /1103/);
      await page.getByLabel("Kredit baris 2").fill("400000");
      await visible(page.getByText(/Selisih Rp/));
    },
  },
  {
    // Balanced journal with one outlet line saved: the detail page.
    card: "5ac3",
    name: "success",
    path: "/kelola/akuntansi/jurnal-manual/baru",
    prepare: async (page) => {
      await visible(heading(page, "Jurnal manual baru"));
      await fillBalancedJournal(page);
      await visible(page.getByText("Seimbang", { exact: true }).first());
      await page.getByRole("button", { name: "Simpan draf" }).click();
      await page.waitForURL(/jurnal-manual\/[0-9a-f-]{36}/, {
        timeout: COLD,
      });
      await page.waitForLoadState("networkidle").catch(() => {});
    },
  },
  {
    card: "5ac3",
    name: "recurring",
    path: "/kelola/akuntansi/jurnal-berulang",
    dialog: true,
    prepare: async (page) => {
      await page.getByRole("button", { name: "Tambah templat" }).click();
      await visible(
        dialogOf(page).getByRole("combobox", { name: "Outlet baris 1" }),
      );
    },
  },

  // s7szu -- receipt-run alert on the edge status screen
  {
    card: "s7szu",
    name: "normal",
    path: "/operasional/koneksi",
    prepare: edgeReady,
  },
  {
    card: "s7szu",
    name: "loading",
    path: "/operasional/koneksi?mock=slow",
    loading: true,
    prepare: async () => {},
  },
  {
    card: "s7szu",
    name: "error",
    path: "/operasional/koneksi?mock=error",
    prepare: async (page) => {
      await edgeSettled(page);
      await page.waitForLoadState("networkidle").catch(() => {});
    },
  },
  {
    card: "s7szu",
    name: "alert",
    path: "/operasional/koneksi",
    prepare: async (page) => {
      await edgeReady(page);
      await raiseReceiptRunAlert(page);
    },
  },
  {
    // The restore procedure expanded (collapsible guide for the tech admin).
    card: "s7szu",
    name: "alert-open",
    path: "/operasional/koneksi",
    prepare: async (page) => {
      await edgeReady(page);
      await raiseReceiptRunAlert(page);
      await receiptAlert(page)
        .getByText("Petunjuk untuk administrator teknis")
        .click();
      await visible(receiptAlert(page).getByText("edge_nodes.instance_id"));
    },
  },
  {
    card: "s7szu",
    name: "recovered",
    path: "/operasional/koneksi",
    prepare: async (page) => {
      await edgeReady(page);
      await raiseReceiptRunAlert(page);
      await setReceiptRunAlert(page, false);
      await page.getByRole("button", { name: "Perbarui status" }).click();
      await visible(
        page.getByText(
          "Status berhasil diperbarui. Tidak ada peringatan rotasi nomor struk pada node ini.",
        ),
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
      ? `\nAll ${states.length * VIEWPORTS.length} checks passed. Output: design/screens/ui-bo-config/`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
