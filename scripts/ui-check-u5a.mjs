#!/usr/bin/env node
/* global window, document, getComputedStyle -- used only inside page.evaluate callbacks */
// UI check for sub-brief docs/briefs/sub-539-u5a.md (6 screens):
//   restore  -- /platform/tenant/<archived tenant>: restore window (nb4iy)
//   owner    -- same page: tenant Owner section (be0lx)
//   domain   -- /kelola/pengaturan/domain: custom domain TXT verification (az8z5)
//   verifikasi -- /verifikasi: second factor + backup code sign-in (sw980)
//   keamanan -- /kelola/keamanan: MFA panel backup codes (sw980)
//   satuan   -- /kelola/inventori/satuan: unit editor (7z38l)
//   pemetaan -- /kelola/akuntansi/pemetaan: account-role mapping (fzvh)
//
// For every state below, at 1280x800 and 390x844: open the real page in mock
// mode, drive it to the state, take a screenshot to
// docs/qa/539-u5a/<screen>-<state>-<1280|390>.png (full page; viewport only for
// dialog states) and run axe (wcag2a, wcag2aa, wcag21aa, wcag22aa). Every state
// also fails on horizontal overflow. A summary of all violations goes to
// docs/qa/539-u5a/axe.json (merged with earlier runs).
//
//   BASE_URL=http://localhost:3157 node scripts/ui-check-u5a.mjs
//   node scripts/ui-check-u5a.mjs satuan restore-confirm   (subset)
//
// A subset argument is a screen ("satuan") or a screen-state ("satuan-add").
// BASE_URL defaults to http://localhost:3157 and must be a web server started
// with VITE_API_MOCK=true. Never point it at a real deployment. Each state gets
// a fresh browser context, so the in-browser mock store starts clean.
//
// Not reachable in mock mode (skipped): restore expired/empty/blocked and
// outlet restore (no mock data), domain empty (listDomains ignores ?mock=empty),
// MFA recovery low/depleted, UOM and mapping read-only role (no role holds view
// without manage in the mock roles), mapping loading of a single entity.
// KNOWN GAP: no mock handler exists yet for the restore-window, restore, owner
// assign/replace endpoints (grep registerMock found none), so the restore-* and
// owner-* states that need them fail with "Mock belum terdaftar" until added.
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs/qa/539-u5a");
const FOCUS_DIR = join(OUT_DIR, "focus");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "1280", width: 1280, height: 800 },
  { label: "390", width: 390, height: 844 },
];
const ROLE_COOKIE = "legend-mock-role";
const COLD = 60_000; // Vite compiles a route on its first request.
// "Bubur Pak Haji": the archived sample tenant (fixedId(17) in ws01-platform-tenants/mock.ts).
const ARCHIVED_TENANT = "7e7a0000-0000-4000-8000-000000000011";
const TENANT_PATH = `/platform/tenant/${ARCHIVED_TENANT}`;
const OWNER_USER_ID = "7e7a0000-0000-4000-8000-0000000000aa";

const visible = (locator, timeout = COLD) =>
  locator.waitFor({ state: "visible", timeout });
const heading = (page, name) => page.getByRole("heading", { name });
const dialogOf = (page) => page.getByRole("dialog");
// Focus crops (state.focus): the card that holds `content`, or the innermost div
// that holds all of `contents` (last match in document order is the deepest).
const shellOf = (page, content) =>
  page.locator('[data-slot="card-shell"]').filter({ has: content }).last();
const innermost = (page, ...contents) =>
  contents.reduce((l, c) => l.filter({ has: c }), page.locator("div")).last();
const settle = async (page) => {
  await page.waitForLoadState("networkidle").catch(() => {});
};

// Init script (runs before the app): queues one 422 for `match` the moment the
// app installs window.__legendMock, so the very first read fails. 4xx is not retried.
const failFirst = (match) => {
  let control;
  Object.defineProperty(window, "__legendMock", {
    configurable: true,
    get: () => control,
    set: (value) => {
      control = value;
      value.failNext(match, { status: 422, code: "VALIDATION_ERROR" });
    },
  });
};

// ---- restore (nb4iy) -------------------------------------------------------
const RESTORE_WINDOW_GET = "GET /api/platform/tenants/:tenantId/restore-window";
const restoreReady = (page) =>
  visible(page.getByRole("button", { name: "Tinjau pemulihan" }));
async function restoreConfirm(page) {
  await restoreReady(page);
  await page.getByRole("button", { name: "Tinjau pemulihan" }).click();
  await visible(heading(page, "Pulihkan tenant?"));
}

// ---- owner (be0lx) ---------------------------------------------------------
const ownerEmpty = (page) =>
  visible(heading(page, "Owner saat ini belum bisa ditampilkan"));
const ownerSection = (page) =>
  page.locator("section").filter({ has: heading(page, "Owner tenant") });
async function ownerOpenAssign(page) {
  await ownerEmpty(page);
  await ownerSection(page)
    .getByRole("button", { name: "Tetapkan Owner" })
    .click();
  await visible(
    page.getByText("Pilih akun yang akan menjadi Owner tenant ini."),
  );
}
async function ownerFill(page) {
  const form = ownerSection(page).locator("form");
  await form.locator("input").first().fill(OWNER_USER_ID);
  await form
    .locator("textarea")
    .fill("Penetapan Owner pertama untuk uji tampilan.");
  await form.locator('input[inputmode="numeric"]').fill("123456");
}
async function ownerAssign(page) {
  await ownerOpenAssign(page);
  await ownerFill(page);
  await ownerSection(page)
    .locator("form")
    .getByRole("button", { name: "Tetapkan Owner" })
    .click();
  await visible(page.getByText("Owner berhasil ditetapkan."));
}

// ---- domain (az8z5) --------------------------------------------------------
const domainReady = (page) =>
  visible(page.getByRole("button", { name: "Cek verifikasi" }).first());
async function domainOpenAdd(page) {
  await domainReady(page);
  await page.getByRole("button", { name: "Tambah domain" }).first().click();
  await visible(page.getByText("Tambah domain kustom"));
  await visible(page.getByLabel("Nama domain"));
}
async function domainSubmit(page, hostname) {
  await domainOpenAdd(page);
  await page.getByLabel("Nama domain").fill(hostname);
  await page.getByRole("button", { name: "Lanjutkan" }).click();
}

// ---- verifikasi / keamanan (sw980) -----------------------------------------
const verifyReady = (page) => visible(heading(page, "Verifikasi dua langkah"));
async function openRecoveryLogin(page) {
  await verifyReady(page);
  await page.getByRole("button", { name: "Pakai kode cadangan" }).click();
  await visible(heading(page, "Masukkan kode cadangan"));
}
async function submitRecoveryCode(page, code) {
  await openRecoveryLogin(page);
  await page.locator('input[maxlength="11"]').fill(code);
  await page.getByRole("button", { name: "Verifikasi kode" }).click();
}
async function enrollToCodes(page) {
  await visible(heading(page, "Daftarkan faktor kedua dulu"));
  await page.locator('input[inputmode="numeric"]').fill("123456");
  await page.getByRole("button", { name: "Verifikasi dan aktifkan" }).click();
  await visible(page.getByText("Simpan kode cadangan Anda"));
}
const panelReady = (page) =>
  visible(page.getByText(/dari 10 kode cadangan tersisa/));
async function panelOpenRegenerate(page) {
  await panelReady(page);
  await page.getByRole("button", { name: "Buat ulang kode" }).click();
  await visible(heading(dialogOf(page), "Buat ulang kode cadangan?"));
}

// ---- satuan (7z38l) --------------------------------------------------------
const unitsReady = (page) => visible(page.getByText("Kilogram").first());
const addUnitButton = (page) =>
  page.getByRole("button", { name: "Tambah satuan" }).first();
async function unitOpenAdd(page) {
  await unitsReady(page);
  await addUnitButton(page).click();
  await visible(heading(dialogOf(page), "Tambah satuan"));
}
async function unitSubmit(page, name, code) {
  const dialog = dialogOf(page);
  await dialog.getByLabel("Nama satuan").fill(name);
  await dialog.getByLabel("Kode satuan").fill(code);
  await dialog.getByRole("button", { name: "Simpan satuan" }).click();
}
async function unitCreate(page, name, code) {
  await unitOpenAdd(page);
  await unitSubmit(page, name, code);
  await visible(page.getByText("Satuan berhasil disimpan."));
}
async function unitOpenRename(page) {
  await unitCreate(page, "Bungkus", "bks");
  await page.getByRole("button", { name: "Ubah nama satuan Bungkus" }).click();
  await visible(heading(dialogOf(page), "Ubah nama satuan"));
}

// ---- pemetaan (fzvh) -------------------------------------------------------
const mappingReady = (page) => visible(page.getByText("Peran dan akun"));
const ROLE_LABELS = [
  "Bank operasional",
  "Kas outlet",
  "Kas kecil",
  "Persediaan bahan baku",
  "Piutang usaha",
];
/** Pick another account on the first role that offers one; returns its label. */
async function changeOneRole(page) {
  await mappingReady(page);
  for (const label of ROLE_LABELS) {
    const select = page.getByLabel(`Akun untuk ${label}`);
    if ((await select.count()) === 0) continue;
    const current = await select.inputValue();
    const values = await select
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value));
    const target = values.find((value) => value && value !== current);
    if (target) {
      await select.selectOption(target);
      return label;
    }
  }
  throw new Error("No mapping role offers an alternative account");
}
const MAPPING_PUT =
  "PUT /api/accounting/legal-entities/:legalEntityId/account-mappings";

// `path` may carry ?mock=. `dialog`: the state is a dialog, shoot the viewport
// only. `role`: legend-mock-role cookie. `loading`: capture before data arrives
// (?mock=slow, 3 s latency). `prepare` drives the page to the state and ends
// with something visible that proves it is on screen. `focus` (optional): (page) =>
// Locator; after the full screenshot, a crop of it goes to docs/qa/539-u5a/focus/.
const STATES = [
  // restore -- archived tenant (nb4iy)
  { card: "restore", name: "normal", path: TENANT_PATH, prepare: restoreReady },
  {
    card: "restore",
    name: "loading",
    path: `${TENANT_PATH}?mock=slow`,
    loading: true,
    prepare: async () => {},
  },
  {
    card: "restore",
    name: "error",
    path: TENANT_PATH,
    // ?mock=error would fail the tenant page too; fail the window read only.
    failFirst: RESTORE_WINDOW_GET,
    prepare: (page) => visible(page.getByText("Data belum tersedia")),
  },
  {
    card: "restore",
    name: "confirm",
    focus: (page) => shellOf(page, heading(page, "Pulihkan tenant?")),
    path: TENANT_PATH,
    prepare: restoreConfirm,
  },
  {
    card: "restore",
    name: "validation",
    path: TENANT_PATH,
    prepare: async (page) => {
      await restoreConfirm(page);
      await page.getByRole("button", { name: "Pulihkan tenant" }).click();
      await visible(
        page.getByText("Isi alasan 10–500 karakter sebelum melanjutkan."),
      );
    },
  },
  {
    card: "restore",
    name: "success",
    // No focus crop: the panel re-renders after the refetch, so a locator
    // detaches mid-scroll. The review crop is cut from the full shot.
    path: TENANT_PATH,
    prepare: async (page) => {
      await restoreConfirm(page);
      await page
        .locator("textarea")
        .fill(
          "Diarsipkan karena salah klik, dipulihkan atas permintaan owner.",
        );
      await page.getByRole("button", { name: "Pulihkan tenant" }).click();
      await visible(page.getByText("Tenant berhasil dipulihkan."));
    },
  },

  // owner -- tenant Owner section (be0lx)
  {
    card: "owner",
    name: "empty",
    path: TENANT_PATH,
    focus: (page) => ownerSection(page),
    prepare: ownerEmpty,
  },
  {
    card: "owner",
    name: "assign",
    focus: (page) => ownerSection(page),
    path: TENANT_PATH,
    prepare: ownerOpenAssign,
  },
  {
    card: "owner",
    name: "validation",
    path: TENANT_PATH,
    prepare: async (page) => {
      await ownerOpenAssign(page);
      await ownerSection(page)
        .locator("form")
        .getByRole("button", { name: "Tetapkan Owner" })
        .click();
      await visible(page.getByText("Pilih akun Owner."));
    },
  },
  {
    card: "owner",
    name: "success",
    path: TENANT_PATH,
    prepare: ownerAssign,
  },
  {
    card: "owner",
    name: "replace",
    path: TENANT_PATH,
    prepare: async (page) => {
      await ownerAssign(page);
      await ownerSection(page)
        .getByRole("button", { name: "Ganti Owner" })
        .click();
      await visible(page.getByText(/^Owner saat ini: /));
    },
  },

  // domain -- custom domain verification (az8z5)
  {
    card: "domain",
    name: "pending",
    path: "/kelola/pengaturan/domain",
    prepare: domainReady,
  },
  {
    card: "domain",
    name: "loading",
    path: "/kelola/pengaturan/domain?mock=slow",
    loading: true,
    prepare: async () => {},
  },
  {
    card: "domain",
    name: "error",
    path: "/kelola/pengaturan/domain?mock=error",
    prepare: settle,
  },
  {
    card: "domain",
    name: "add",
    path: "/kelola/pengaturan/domain",
    prepare: domainOpenAdd,
  },
  {
    card: "domain",
    name: "invalid",
    path: "/kelola/pengaturan/domain",
    prepare: async (page) => {
      await domainOpenAdd(page);
      await page.getByRole("button", { name: "Lanjutkan" }).click();
      await visible(page.getByText("Masukkan nama domain."));
    },
  },
  {
    card: "domain",
    name: "reserved",
    path: "/kelola/pengaturan/domain",
    prepare: async (page) => {
      await domainSubmit(page, "toko.platform.example");
      await visible(page.getByText(/dicadangkan dan tidak dapat digunakan/));
    },
  },
  {
    card: "domain",
    name: "taken",
    path: "/kelola/pengaturan/domain",
    prepare: async (page) => {
      await domainSubmit(page, "toko.contoh.example");
      await visible(page.getByText(/sudah digunakan\. Pilih domain lain/));
    },
  },
  {
    card: "domain",
    name: "added",
    focus: (page) => shellOf(page, heading(page, "pesan.contoh.id")),
    path: "/kelola/pengaturan/domain",
    prepare: async (page) => {
      await domainSubmit(page, "pesan.contoh.id");
      await visible(heading(page, "pesan.contoh.id"));
    },
  },
  {
    card: "domain",
    name: "failed",
    focus: (page) =>
      innermost(
        page,
        page.getByText("Verifikasi belum berhasil."),
        page.getByRole("button", { name: "Cek verifikasi" }),
      ),
    path: "/kelola/pengaturan/domain",
    prepare: async (page) => {
      await domainReady(page);
      // The seeded failing domain is the last pending card.
      await page.getByRole("button", { name: "Cek verifikasi" }).last().click();
      await visible(page.getByText("Verifikasi belum berhasil."));
    },
  },
  {
    card: "domain",
    name: "success",
    path: "/kelola/pengaturan/domain",
    prepare: async (page) => {
      await domainReady(page);
      await page
        .getByRole("button", { name: "Cek verifikasi" })
        .first()
        .click();
      await visible(page.getByText("Domain terverifikasi."));
    },
  },

  // verifikasi -- second factor and backup code sign-in (sw980)
  {
    card: "verifikasi",
    name: "totp",
    path: "/verifikasi",
    prepare: verifyReady,
  },
  {
    card: "verifikasi",
    name: "loading",
    path: "/verifikasi?mock=slow",
    loading: true,
    prepare: async () => {},
  },
  {
    card: "verifikasi",
    name: "error",
    path: "/verifikasi?mock=error",
    prepare: settle,
  },
  {
    card: "verifikasi",
    name: "invalid",
    path: "/verifikasi",
    prepare: async (page) => {
      await verifyReady(page);
      await page.locator('input[inputmode="numeric"]').fill("000000");
      await page
        .getByRole("button", { name: "Verifikasi", exact: true })
        .click();
      await visible(page.getByText(/Kode salah atau sudah kedaluwarsa/));
    },
  },
  {
    card: "verifikasi",
    name: "recovery",
    focus: (page) =>
      page
        .locator('[data-slot="card"]')
        .filter({ has: heading(page, "Masukkan kode cadangan") })
        .last(),
    path: "/verifikasi",
    prepare: openRecoveryLogin,
  },
  {
    card: "verifikasi",
    name: "recovery-incomplete",
    path: "/verifikasi",
    prepare: async (page) => {
      await submitRecoveryCode(page, "ABC");
      await visible(page.getByText(/Masukkan kode cadangan 10 karakter/));
    },
  },
  {
    card: "verifikasi",
    name: "recovery-invalid",
    path: "/verifikasi",
    prepare: async (page) => {
      await submitRecoveryCode(page, "ZZZZZ-ZZZZZ");
      await visible(page.getByText(/Kode tidak valid atau sudah digunakan/));
    },
  },
  {
    card: "verifikasi",
    name: "recovery-success",
    path: "/verifikasi",
    prepare: async (page) => {
      await submitRecoveryCode(page, "ABCDE-FGHJK");
      await visible(
        heading(page, "Verifikasi berhasil").or(
          page.getByText("Verifikasi berhasil", { exact: true }),
        ),
      );
    },
  },
  {
    // No second factor yet: enrol, then the backup codes are shown once.
    card: "verifikasi",
    name: "enroll",
    path: "/verifikasi?mock=empty",
    prepare: async (page) => {
      await visible(heading(page, "Daftarkan faktor kedua dulu"));
      await visible(page.getByText("Kunci setup"));
    },
  },
  {
    card: "verifikasi",
    name: "enroll-codes",
    path: "/verifikasi?mock=empty",
    prepare: enrollToCodes,
  },

  // keamanan -- MFA panel, backup code status (sw980)
  {
    card: "keamanan",
    name: "normal",
    path: "/kelola/keamanan",
    prepare: panelReady,
  },
  {
    card: "keamanan",
    name: "loading",
    path: "/kelola/keamanan?mock=slow",
    loading: true,
    prepare: async () => {},
  },
  {
    card: "keamanan",
    name: "empty",
    path: "/kelola/keamanan?mock=empty",
    prepare: (page) => visible(page.getByText("Kode cadangan belum tersedia")),
  },
  {
    card: "keamanan",
    name: "error",
    path: "/kelola/keamanan?mock=error",
    prepare: settle,
  },
  {
    card: "keamanan",
    name: "regenerate",
    path: "/kelola/keamanan",
    dialog: true,
    prepare: panelOpenRegenerate,
  },
  {
    card: "keamanan",
    name: "regenerate-error",
    path: "/kelola/keamanan",
    dialog: true,
    prepare: async (page) => {
      await panelOpenRegenerate(page);
      await page.evaluate(() =>
        window.__legendMock.failNext("*", {
          status: 500,
          code: "INTERNAL_ERROR",
        }),
      );
      await dialogOf(page)
        .getByRole("button", { name: "Buat kode baru" })
        .click();
      await visible(dialogOf(page).getByRole("alert"));
    },
  },
  {
    card: "keamanan",
    name: "codes",
    focus: dialogOf,
    path: "/kelola/keamanan",
    dialog: true,
    prepare: async (page) => {
      await panelOpenRegenerate(page);
      await dialogOf(page)
        .getByRole("button", { name: "Buat kode baru" })
        .click();
      await visible(
        page.getByRole("button", { name: "Saya sudah menyimpan kode" }),
      );
    },
  },

  // satuan -- unit editor (7z38l)
  {
    card: "satuan",
    name: "normal",
    focus: (page) =>
      page
        .locator("section")
        .filter({ has: heading(page, "Daftar satuan") })
        .last(),
    path: "/kelola/inventori/satuan",
    prepare: unitsReady,
  },
  {
    card: "satuan",
    name: "loading",
    path: "/kelola/inventori/satuan?mock=slow",
    loading: true,
    prepare: async () => {},
  },
  {
    card: "satuan",
    name: "empty",
    path: "/kelola/inventori/satuan?mock=empty",
    prepare: (page) =>
      visible(page.getByText("Belum ada satuan untuk ditampilkan")),
  },
  {
    card: "satuan",
    name: "error",
    path: "/kelola/inventori/satuan?mock=error",
    prepare: (page) =>
      visible(page.getByText("Daftar satuan belum bisa dimuat")),
  },
  {
    card: "satuan",
    name: "add",
    focus: dialogOf,
    path: "/kelola/inventori/satuan",
    dialog: true,
    prepare: unitOpenAdd,
  },
  {
    card: "satuan",
    name: "invalid",
    path: "/kelola/inventori/satuan",
    dialog: true,
    prepare: async (page) => {
      await unitOpenAdd(page);
      await dialogOf(page)
        .getByRole("button", { name: "Simpan satuan" })
        .click();
      await visible(dialogOf(page).getByText("Masukkan nama satuan."));
    },
  },
  {
    card: "satuan",
    name: "reserved",
    path: "/kelola/inventori/satuan",
    dialog: true,
    prepare: async (page) => {
      await unitOpenAdd(page);
      await unitSubmit(page, "Kilo", "kg");
      await visible(
        dialogOf(page).getByText(
          /Kode ini (digunakan satuan bawaan|sudah digunakan tenant)/,
        ),
      );
    },
  },
  {
    card: "satuan",
    name: "success",
    path: "/kelola/inventori/satuan",
    prepare: async (page) => {
      await unitCreate(page, "Bungkus", "bks");
      await visible(page.getByText("Bungkus", { exact: true }).first());
    },
  },
  {
    card: "satuan",
    name: "duplicate",
    path: "/kelola/inventori/satuan",
    dialog: true,
    prepare: async (page) => {
      await unitCreate(page, "Bungkus", "bks");
      await addUnitButton(page).click();
      await visible(heading(dialogOf(page), "Tambah satuan"));
      await unitSubmit(page, "Bungkus dua", "bks");
      await visible(
        dialogOf(page).getByText("Kode ini sudah digunakan tenant."),
      );
    },
  },
  {
    card: "satuan",
    name: "edit",
    path: "/kelola/inventori/satuan",
    dialog: true,
    prepare: unitOpenRename,
  },
  {
    card: "satuan",
    name: "renamed",
    path: "/kelola/inventori/satuan",
    prepare: async (page) => {
      await unitOpenRename(page);
      await dialogOf(page).getByLabel("Nama satuan").fill("Bungkus Besar");
      await dialogOf(page)
        .getByRole("button", { name: "Simpan satuan" })
        .click();
      await visible(page.getByText("Nama satuan berhasil disimpan."));
    },
  },

  // pemetaan -- account-role mapping (fzvh)
  {
    card: "pemetaan",
    name: "normal",
    focus: (page) => shellOf(page, heading(page, "Peran dan akun")),
    path: "/kelola/akuntansi/pemetaan",
    prepare: mappingReady,
  },
  {
    card: "pemetaan",
    name: "loading",
    path: "/kelola/akuntansi/pemetaan?mock=slow",
    loading: true,
    prepare: async () => {},
  },
  {
    // ?mock=empty: no mappings (and maybe no entity); either empty card shows.
    card: "pemetaan",
    name: "empty",
    path: "/kelola/akuntansi/pemetaan?mock=empty",
    prepare: (page) =>
      visible(
        page
          .getByText("Belum ada badan usaha")
          .or(page.getByText("Pemetaan belum lengkap.")),
      ),
  },
  {
    card: "pemetaan",
    name: "error",
    path: "/kelola/akuntansi/pemetaan?mock=error",
    prepare: (page) => visible(page.getByText("Pemetaan belum dapat dimuat.")),
  },
  {
    // A role left without an account: the "belum lengkap" banner.
    card: "pemetaan",
    name: "incomplete",
    path: "/kelola/akuntansi/pemetaan",
    prepare: async (page) => {
      await mappingReady(page);
      await page.getByLabel("Akun untuk Kas outlet").selectOption("");
      await visible(page.getByText("Pemetaan belum lengkap."));
    },
  },
  {
    card: "pemetaan",
    name: "success",
    path: "/kelola/akuntansi/pemetaan",
    prepare: async (page) => {
      await changeOneRole(page);
      await page.getByRole("button", { name: "Simpan pemetaan" }).click();
      await visible(page.getByText("Pemetaan disimpan."));
    },
  },
  {
    // The API refuses the mapping (422): the row is flagged.
    card: "pemetaan",
    name: "validation",
    focus: (page) => shellOf(page, heading(page, "Peran dan akun")),
    path: "/kelola/akuntansi/pemetaan",
    prepare: async (page) => {
      await changeOneRole(page);
      await page.evaluate(
        (match) =>
          window.__legendMock.failNext(match, {
            status: 422,
            code: "VALIDATION_ERROR",
            message: "Role cash_on_hand: needs a asset account",
          }),
        MAPPING_PUT,
      );
      await page.getByRole("button", { name: "Simpan pemetaan" }).click();
      await visible(
        page.getByText("Jenis akun tidak sesuai dengan peran ini."),
      );
    },
  },
  {
    card: "pemetaan",
    name: "failed",
    path: "/kelola/akuntansi/pemetaan",
    prepare: async (page) => {
      await changeOneRole(page);
      await page.evaluate(
        (match) =>
          window.__legendMock.failNext(match, {
            status: 500,
            code: "INTERNAL_ERROR",
          }),
        MAPPING_PUT,
      );
      await page.getByRole("button", { name: "Simpan pemetaan" }).click();
      await visible(page.getByText(/Perubahan Anda masih ada di layar/));
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
  const baseUrl = (process.env.BASE_URL ?? "http://localhost:3157").replace(
    /\/+$/,
    "",
  );
  const filters = new Set(process.argv.slice(2));
  const states = STATES.filter((s) => matchesFilter(s, filters));
  if (states.length === 0) {
    console.error(`No state matches: ${[...filters].join(", ")}`);
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(FOCUS_DIR, { recursive: true });
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
          if (state.failFirst)
            await page.addInitScript(failFirst, state.failFirst);
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
          if (state.focus) {
            const target = state.focus(page);
            await target.scrollIntoViewIfNeeded();
            await target.screenshot({ path: join(FOCUS_DIR, `${id}.png`) });
          }
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
      ? `\nAll ${states.length * VIEWPORTS.length} checks passed. Output: docs/qa/539-u5a/`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
