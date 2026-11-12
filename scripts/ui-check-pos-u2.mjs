#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate / addInitScript callbacks */
// UI check for the POS extra screens (sub-539-u2, docs/briefs/sub-539-u2.md,
// beads legend-2fo, 0ixe, shabi, 5w6, p7lx, pspy, 7mlf, kfkt, hn5q, 6om3,
// 1uk9). Modeled on scripts/ui-check-pos-u1.mjs (pos-cashier-captain).
//
// For every screen/state below, in light and dark, at 390x844 and 1280x800:
// open the page in mock mode, drive it to the state, run axe (wcag2a, wcag2aa,
// wcag21aa, wcag22aa), fail on serious/critical violations or horizontal
// scroll, and save a full-page screenshot to
// design/screenshots/pos-u2/<screen>-<state>-<light|dark>-<390|1280>.png.
//
//   UI_CHECK_URL=http://localhost:3225 heavy node scripts/ui-check-pos-u2.mjs
//   UI_CHECK_URL=... node scripts/ui-check-pos-u2.mjs koreksi shift-hitungan-batas
//   UI_CHECK_URL=... node scripts/ui-check-pos-u2.mjs i5 --theme=dark
//
// A subset argument is a screen ("koreksi"), a screen-state ("koreksi-diskon"),
// a card ("2fo", "pspy", ...) or a group ("i1" ... "i7"). Flags:
//   --theme=light|dark   only that theme
//
// UI_CHECK_URL must be a web server started with VITE_API_MOCK=true (the one
// playwright.mock.config.ts starts). Never point it at a real deployment.
//
// Session: no login in mock mode. No `legend-mock-role` cookie = role "all",
// which holds the POS, kelola and approval permissions. Each state gets a fresh
// browser context, so the in-browser mock store starts clean. The theme is the
// `legend-theme` localStorage key (packages/shared/src/theme), set before load.
//
// How a state is forced (read from the code, not guessed):
//   - ?demo=<seed>   POS kasir engine (features/ws04-pos-kasir/demo-seed.ts,
//                    shift-extra-types.ts), correction mock (belum-dapur,
//                    ws04-pos-correction/demo.ts), charge mock (selisih-*),
//                    public e-receipt mock (invalid | error | kuitansi).
//   - ?mock=empty|error|slow   shared scenarios (lib/mock/control.ts).
//   - localStorage["legend-display-mock"]   customer display demo state.
//   - window.__legendMock.failNext(id)   one endpoint fails (failOnBoot); used
//                    where the screen has its own error block next to data.
//
// The browser runs in Asia/Jakarta so times match the mockups.
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
const OUT_DIR = join(ROOT, "design/screenshots/pos-u2");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const MOBILE = { label: "390", width: 390, height: 844 };
const DESKTOP = { label: "1280", width: 1280, height: 800 };
const VIEWPORTS = [MOBILE, DESKTOP];
const THEMES = ["light", "dark"];
const THEME_KEY = "legend-theme"; // THEME_STORAGE_KEY in packages/shared/src/theme
const COLD_TIMEOUT = 45_000; // Vite compiles a route on its first request.

// Demo ids (features/ws04-pos-kasir/demo-seed.ts). The typed POS endpoints
// validate their path with the real schema (ULID); the payment route also takes
// the uuid. The charge mock answers to any uuid.
const ORDER_ULID = "01JBQ9C0000000000000000048"; // Meja A12, POS-0048, DP Rp100.000
const ORDER_UUID = "0b0b0048-0000-4000-8000-000000000048";
const MISSING_ORDER_ULID = "01JBQ9C0000000000000000999"; // engine answers 404
const SHIFT_ID = "0c0c0001-0000-4000-8000-000000000001"; // S-008, counted Rp2.230.000
const CHARGE_ID = "0d0d0048-0000-4000-8000-0000000000c1";
const RECEIPT_TOKEN = "demo-token";

// Endpoint ids (`${method} ${path}`) for failOnBoot.
const EP_ORDER_EVENTS = "GET /api/outlets/:outletId/pos/orders/:orderId/events";

// ---- screens -----------------------------------------------------------------
// Fields: `card` (bead short name) + `group` (i1..i7), `screen` + `state` name
// the png, `path` is opened after `seed` (optional, runs on its own URL first),
// `prepare` drives the state and must end with something that proves it.
// `viewports` / `themes` narrow the matrix; `noHydration` skips the hydration
// wait (loading states never settle); `localStorage` is written before load;
// `failOnBoot` lists endpoint ids that fail from the first call.
const SCREENS = [];

function add(screen) {
  SCREENS.push({ viewports: VIEWPORTS, themes: THEMES, ...screen });
}

// ---- I1 legend-2fo: koreksi + struk ------------------------------------------
// Route /pos/pesanan/$orderId/koreksi?mode=diskon|void|refund|struk. The demo
// order is open (awaiting payment) with all four lines already fired to the
// kitchen; `?demo=belum-dapur` holds the first line (void before kitchen);
// `?demo=lunas` makes it paid for refund and struk.
const KOREKSI = `/pos/pesanan/${ORDER_ULID}/koreksi`;
const K = { card: "2fo", group: "i1", screen: "koreksi" };

add({
  ...K,
  state: "diskon",
  path: `${KOREKSI}?mode=diskon`,
  prepare: async (p) => {
    await expectHeading(p, "Diskon pesanan");
    await fillField(p, /Persen diskon/, "15");
    await expectText(p, /Diskon usulan/);
    // Above the 10% mock threshold: pill, notice, and the primary action.
    await expectText(p, /Perlu persetujuan/);
    await expectButton(p, /Minta persetujuan/);
  },
});
add({
  ...K,
  state: "void-sebelum",
  path: `${KOREKSI}?mode=void&demo=belum-dapur`,
  prepare: async (p) => {
    await expectHeading(p, "Void item");
    await expectText(p, "Item belum masuk dapur");
  },
});
add({
  ...K,
  state: "void-sesudah",
  path: `${KOREKSI}?mode=void`,
  prepare: async (p) => {
    await expectHeading(p, "Void item");
    await expectText(p, "Item sudah masuk dapur");
    await expectText(p, "Sudah dikirim ke dapur");
  },
});
add({
  ...K,
  state: "refund",
  path: `${KOREKSI}?mode=refund&demo=lunas`,
  prepare: async (p) => {
    await expectHeading(p, "Refund manual");
    await fillField(p, /Nominal refund/, "48000");
    await fillField(p, /Alasan tertulis/, "Item gagal setelah dibayar");
    await expectText(p, /Perlu persetujuan/);
  },
});
add({
  ...K,
  state: "override",
  path: `${KOREKSI}?mode=diskon`,
  // "Minta persetujuan" opens the supervisor approval dialog (PIN).
  prepare: async (p) => {
    await expectHeading(p, "Diskon pesanan");
    await fillField(p, /Persen diskon/, "15");
    await clickControl(p, /Minta persetujuan/);
    await p
      .getByRole("dialog")
      .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
    await expectText(p, "Persetujuan diskon");
    await expectText(p, /Supervisor penyetuju/);
    await p
      .getByLabel(/PIN/)
      .filter({ visible: true })
      .first()
      .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  },
});
add({
  ...K,
  state: "struk",
  path: `${KOREKSI}?mode=struk&demo=lunas`,
  prepare: async (p) => {
    await expectHeading(p, "Struk pesanan");
    await expectText(p, /Pratinjau cetak/);
  },
});
add({
  ...K,
  state: "kosong",
  path: `/pos/pesanan/${MISSING_ORDER_ULID}/koreksi?mode=diskon`,
  prepare: (p) => expectText(p, "Pilih pesanan terlebih dahulu"),
});
add({
  ...K,
  state: "error",
  path: `${KOREKSI}?mode=diskon&mock=error`,
  prepare: async (p) => {
    await expectText(p, "Data tidak dapat dimuat");
    await expectButton(p, /Coba lagi/);
  },
});
add({
  ...K,
  state: "loading",
  path: `${KOREKSI}?mode=diskon&mock=slow`,
  noHydration: true,
  prepare: (p) => expectBusy(p),
});

// ---- I2 legend-0ixe: pemberitahuan dapur; legend-shabi: tagih selisih --------
const PESANAN = `/pos/pesanan/${ORDER_ULID}`;
const N = { card: "0ixe", group: "i2", screen: "pesanan" };

add({
  ...N,
  state: "notice",
  path: PESANAN,
  prepare: async (p) => {
    await expectHeading(p, /^Pesanan #/);
    await expectText(p, "Item dibatalkan di dapur");
    await expectText(p, /Pembatalan dapur belum mengubah tagihan/);
    await expectLink(p, /Ajukan void item/);
  },
});
add({
  ...N,
  state: "kosong",
  // ?mock=empty: the order itself is not scenario-dependent, the event log is
  // empty.
  path: `${PESANAN}?mock=empty`,
  prepare: (p) => expectText(p, "Tidak ada pemberitahuan dapur"),
});
add({
  ...N,
  state: "memuat",
  path: `${PESANAN}?mock=slow`,
  noHydration: true,
  prepare: (p) => expectBusy(p),
});
add({
  ...N,
  state: "gagal",
  // Only the kitchen log fails; the order and its bill stay readable.
  path: PESANAN,
  failOnBoot: [EP_ORDER_EVENTS],
  prepare: async (p) => {
    await expectText(p, "Pemberitahuan dapur tidak dapat dimuat");
    await expectButton(p, /Coba lagi/);
  },
});
add({
  ...N,
  state: "gagal-halaman",
  path: `${PESANAN}?mock=error`,
  prepare: async (p) => {
    await expectText(p, "Pesanan belum bisa dimuat");
    await expectButton(p, /Coba lagi/);
  },
});

const CHARGE = `/pos/tagih-selisih/${CHARGE_ID}`;
const C = { card: "shabi", group: "i2", screen: "tagih-selisih" };

add({
  ...C,
  state: "normal",
  path: CHARGE,
  prepare: async (p) => {
    await expectHeading(p, "Tagih selisih");
    await expectText(p, "Belum lunas");
    await expectButton(p, /Tagih selisih · Tunai/);
  },
});
add({
  ...C,
  state: "memproses",
  path: CHARGE,
  // Slow scenario only after the charge is loaded, so the collect call hangs.
  prepare: async (p) => {
    await expectButton(p, /Tagih selisih · Tunai/);
    await setScenario(p, "slow");
    await clickControl(p, /Tagih selisih · Tunai/);
    await expectText(p, "Mencatat penagihan…");
  },
});
add({
  ...C,
  state: "belum-pasti",
  // The first collect is recorded but answers 504: the status is unknown and
  // only "Periksa status" is offered, never a second collect.
  path: `${CHARGE}?demo=selisih-belum-pasti`,
  prepare: async (p) => {
    await clickControl(p, /Tagih selisih · Tunai/);
    await expectText(p, "Status penagihan belum dapat dipastikan");
    await expectButton(p, /Periksa status/);
  },
});
add({
  ...C,
  state: "lunas",
  path: `${CHARGE}?demo=selisih-lunas`,
  prepare: async (p) => {
    await expectHeading(p, "Tagih selisih");
    await expectText(p, "Lunas");
  },
});
add({
  ...C,
  state: "sukses",
  path: CHARGE,
  prepare: async (p) => {
    await clickControl(p, /Tagih selisih · Tunai/);
    await expectText(p, "Penagihan tercatat");
  },
});
add({
  ...C,
  state: "memuat",
  path: `${CHARGE}?mock=slow`,
  noHydration: true,
  prepare: (p) => expectBusy(p),
});
add({
  ...C,
  state: "gagal",
  path: `${CHARGE}?mock=error`,
  prepare: async (p) => {
    await expectText(p, "Tagihan selisih belum bisa dimuat");
    await expectButton(p, /Coba lagi/);
  },
});

// ---- I3 legend-5w6: QRIS di layar pelanggan ----------------------------------
// /pos/customer-display. The demo state is localStorage["legend-display-mock"]
// (features/ws04-display/mock.ts); the default is a live bill awaiting QRIS.
const DISPLAY = "/pos/customer-display";
const D = { card: "5w6", group: "i3", screen: "display" };
const demoDisplay = (state) => ({ "legend-display-mock": state });

add({
  ...D,
  state: "normal",
  path: DISPLAY,
  localStorage: demoDisplay("awaiting_payment"),
  prepare: async (p) => {
    await expectText(p, /Bayar dengan QRIS|Pindai untuk membayar/);
    await expectText(p, /Berlaku \d+:\d{2} lagi/);
  },
});
add({
  ...D,
  state: "loading",
  path: DISPLAY,
  localStorage: demoDisplay("awaiting_loading"),
  prepare: (p) => expectText(p, "Menyiapkan kode pembayaran"),
});
add({
  ...D,
  state: "expired",
  path: DISPLAY,
  localStorage: demoDisplay("awaiting_expired"),
  prepare: async (p) => {
    await expectHeading(p, "Kode QRIS kedaluwarsa");
    await expectText(p, /Jangan gunakan kode sebelumnya/);
  },
});
add({
  ...D,
  state: "success",
  path: DISPLAY,
  localStorage: demoDisplay("paid"),
  prepare: (p) => expectHeading(p, "Pembayaran terkonfirmasi"),
});
add({
  ...D,
  state: "empty",
  path: DISPLAY,
  localStorage: demoDisplay("idle"),
  prepare: (p) => expectText(p, "Selamat datang"),
});
add({
  ...D,
  state: "error",
  // A bill is on screen, then the terminal stops answering: the stale QRIS is
  // replaced by "QRIS belum dapat ditampilkan" on the next poll (every 5 s).
  path: DISPLAY,
  localStorage: demoDisplay("awaiting_payment"),
  prepare: async (p) => {
    await expectText(p, /Berlaku \d+:\d{2} lagi/);
    await setScenario(p, "error");
    await p
      .getByText("QRIS belum dapat ditampilkan")
      .filter({ visible: true })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
  },
});

// ---- I4 legend-p7lx: DP menutup seluruh tagihan ------------------------------
add({
  card: "p7lx",
  group: "i4",
  screen: "bayar",
  state: "dp-lunas",
  path: `/pos/bayar/${ORDER_UUID}?demo=dp-lunas`,
  prepare: async (p) => {
    await expectText(p, "Tidak ada pembayaran tambahan");
    await expectText(p, /DP reservasi/);
  },
});

// ---- I5 legend-pspy + legend-7mlf: shift --------------------------------------
// Cashier: /pos/shift (+ /tutup). Supervisor: /pos/supervisor/shift/$shiftId.
// Seeds (shift-extra-types.ts): hitungan-batas (3 counts), tutup-paksa,
// tutup-paksa-menunggu, tutup-paksa-siap, hitungan-usang, shift-sendiri (3
// counts, viewer is the cashier), perangkat-gagal, kas-kosong and kas-gagal (1
// count; no held cash out / the held list fails). The supervisor screen seeds
// the awaiting-approval shift itself.
const SUPERVISOR = `/pos/supervisor/shift/${SHIFT_ID}`;
const P = { card: "pspy", group: "i5" };
const M = { card: "7mlf", group: "i5", screen: "shift" };

add({
  ...P,
  screen: "shift",
  state: "kas-tercatat",
  path: "/pos/shift?demo=shift-aktif",
  prepare: async (p) => {
    await clickControl(p, /Kas keluar/);
    await fillField(p, /Nominal tunai/, "200000");
    await fillField(p, /Alasan kas keluar/, "Pembelian bahan dapur");
    await clickControl(p, /Simpan kas keluar/);
    await expectText(p, "Kas keluar tercatat");
    await expectText(p, /Jangan catat ulang transaksi ini/);
  },
});
add({
  ...P,
  screen: "supervisor",
  state: "kas-ditahan",
  path: SUPERVISOR,
  prepare: async (p) => {
    await expectText(p, "Kas keluar perlu ditinjau");
    await expectText(p, /Perlu persetujuan/);
    await expectText(p, /Selisih buku/);
  },
});
add({
  ...P,
  screen: "supervisor",
  state: "kas-kosong",
  path: `${SUPERVISOR}?demo=kas-kosong`,
  prepare: (p) => expectText(p, "Tidak ada kas keluar yang ditahan"),
});
add({
  ...P,
  screen: "supervisor",
  state: "kas-memuat",
  path: `${SUPERVISOR}?mock=slow`,
  noHydration: true,
  prepare: (p) => expectBusy(p),
});
add({
  ...P,
  screen: "supervisor",
  state: "kas-gagal",
  path: `${SUPERVISOR}?demo=kas-gagal`,
  prepare: async (p) => {
    await expectText(p, "Pergerakan kas belum dapat dimuat");
    await expectButton(p, /Coba lagi/);
  },
});
add({
  ...P,
  screen: "supervisor",
  state: "gagal-halaman",
  path: `${SUPERVISOR}?mock=error`,
  prepare: (p) => expectButton(p, /Coba lagi/),
});

add({
  ...M,
  state: "hitungan-terkirim",
  path: "/pos/shift?demo=kas-kosong",
  prepare: async (p) => {
    await expectText(p, "Hitungan kas terkirim");
    await expectText(p, "Supervisor perlu meninjau");
  },
});
add({
  ...M,
  state: "hitungan-batas",
  path: "/pos/shift?demo=hitungan-batas",
  prepare: async (p) => {
    await expectText(p, "Batas hitungan tercapai");
    await expectText(p, "Hitungan baru tidak dapat dikirim");
  },
});
add({
  ...M,
  state: "perangkat-gagal",
  path: "/pos/shift?demo=perangkat-gagal",
  prepare: async (p) => {
    await expectText(p, "Terminal tidak dapat diverifikasi");
    await expectButton(p, /Coba lagi/);
  },
});
add({
  ...M,
  state: "memuat",
  path: "/pos/shift?demo=shift-aktif&mock=slow",
  noHydration: true,
  prepare: (p) => expectBusy(p),
});

// Supervisor force close: the held-cash-out gate shows "Tutup paksa shift" once
// the cashier used all three counts; the button opens the force-close screen.
async function openForceClose(p) {
  await expectText(p, "Kas keluar perlu ditinjau");
  await clickControl(p, /Tutup paksa shift/);
}
add({
  ...M,
  screen: "supervisor",
  state: "tutup-paksa",
  path: `${SUPERVISOR}?demo=tutup-paksa`,
  prepare: async (p) => {
    await openForceClose(p);
    await expectHeading(p, "Penutupan paksa shift");
    await expectText(p, "Hitung ulang uang di laci");
    // The mockup shows the supervisor's own count (Rp2.230.000).
    await fillField(p, /Pecahan lain/, "2230000");
    await expectText(p, /2\.230\.000/);
  },
});
add({
  ...M,
  screen: "supervisor",
  state: "tutup-paksa-menunggu",
  path: `${SUPERVISOR}?demo=tutup-paksa-menunggu`,
  prepare: async (p) => {
    await openForceClose(p);
    await expectHeading(p, "Menunggu persetujuan");
    await expectText(p, "Menunggu supervisor lain");
  },
});
add({
  ...M,
  screen: "supervisor",
  state: "tutup-paksa-siap",
  path: `${SUPERVISOR}?demo=tutup-paksa-siap`,
  prepare: async (p) => {
    await openForceClose(p);
    await expectHeading(p, "Siap tutup paksa");
    await expectText(p, "Persetujuan diterima");
  },
});
add({
  ...M,
  screen: "supervisor",
  state: "hitungan-usang",
  path: `${SUPERVISOR}?demo=hitungan-usang`,
  prepare: async (p) => {
    await openForceClose(p);
    await expectHeading(p, "Hitungan perlu diperbarui");
    await expectText(p, "Hitungan sebelumnya tidak dapat digunakan");
  },
});
add({
  ...M,
  screen: "supervisor",
  state: "shift-sendiri",
  path: `${SUPERVISOR}?demo=shift-sendiri`,
  prepare: async (p) => {
    await openForceClose(p);
    await expectText(p, "Anda tidak dapat menyetujui shift sendiri");
  },
});

// ---- I6 legend-kfkt + legend-hn5q: refund (kelola > Pembayaran > Refund) ------
// /kelola/pembayaran, tab "Refund". Mock rows (ws05-payment-admin/mock.ts):
// POS-0148 ditolak, POS-0149 gagal final, POS-0150 coba ulang, POS-0151 hasil
// belum pasti, POS-0152 karantina; the pending row is the first fixture refund.
const PAYMENTS = "/kelola/pembayaran";
const R = { group: "i6", screen: "refund" };

async function openRefundsTab(p) {
  await p
    .getByRole("tab", { name: /^Refund$/ })
    .filter({ visible: true })
    .first()
    .click();
}
/** Opens the follow-up dialog of the row that shows `marker` (text). */
async function reviewRefund(p, marker) {
  await openRefundsTab(p);
  const label = p
    .getByText(textMatcher(marker))
    .filter({ visible: true })
    .first();
  await label.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await label
    .locator("xpath=ancestor::*[.//button[contains(., 'Tinjau')]][1]")
    .getByRole("button", { name: /Tinjau/ })
    .first()
    .click();
  await p
    .getByRole("dialog")
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
async function filterQuarantine(p) {
  await openRefundsTab(p);
  await p
    .getByRole("combobox", { name: /Filter status refund/ })
    .filter({ visible: true })
    .first()
    .click();
  await p.getByRole("option", { name: "Karantina" }).click();
}

add({
  ...R,
  card: "kfkt",
  state: "pending",
  path: PAYMENTS,
  prepare: async (p) => {
    await reviewRefund(p, /Menunggu (approval|persetujuan)/);
    await expectText(p, "Tinjau permintaan");
  },
});
add({
  ...R,
  card: "kfkt",
  state: "rejected",
  path: PAYMENTS,
  prepare: async (p) => {
    await reviewRefund(p, "POS-0148");
    await expectText(p, "Pengajuan tidak disetujui");
  },
});
add({
  ...R,
  card: "kfkt",
  state: "failed",
  path: PAYMENTS,
  prepare: async (p) => {
    await reviewRefund(p, "POS-0149");
    await expectText(p, "Periksa kegagalan pembayaran");
  },
});
add({
  ...R,
  card: "kfkt",
  state: "retry",
  path: PAYMENTS,
  prepare: async (p) => {
    await reviewRefund(p, "POS-0150");
    await expectText(p, "Pengiriman dapat dicoba lagi");
    await expectButton(p, /Coba lagi/);
  },
});
add({
  ...R,
  card: "kfkt",
  state: "unknown",
  path: PAYMENTS,
  prepare: async (p) => {
    await reviewRefund(p, "POS-0151");
    await expectText(p, "Periksa status sebelum mencoba lagi");
    // Money rule: a maybe-sent payout is only looked up, never sent again.
    await expectButton(p, /Periksa status/);
    await expectNoButton(p, /^Coba lagi$/);
  },
});
add({
  ...R,
  card: "kfkt",
  state: "empty",
  path: `${PAYMENTS}?mock=empty`,
  prepare: async (p) => {
    await openRefundsTab(p);
    await expectText(p, "Belum ada refund");
  },
});
add({
  ...R,
  card: "kfkt",
  state: "loading",
  // Hydrated first (the tab needs a click); the refund list then loads slowly.
  path: `${PAYMENTS}?mock=slow`,
  prepare: async (p) => {
    await openRefundsTab(p);
    await expectBusy(p);
  },
});
add({
  ...R,
  card: "kfkt",
  state: "error",
  path: `${PAYMENTS}?mock=error`,
  prepare: async (p) => {
    await openRefundsTab(p);
    await expectButton(p, /Coba lagi/);
  },
});
add({
  ...R,
  card: "hn5q",
  state: "karantina",
  path: PAYMENTS,
  prepare: async (p) => {
    await filterQuarantine(p);
    await expectText(p, "POS-0152");
    await reviewRefund(p, "POS-0152");
    await expectText(p, "Pengiriman refund ditahan");
    await expectButton(p, /Tinjau pelepasan/);
  },
});
add({
  ...R,
  card: "hn5q",
  state: "konfirmasi",
  path: PAYMENTS,
  prepare: async (p) => {
    await reviewRefund(p, "POS-0152");
    await clickControl(p, /Tinjau pelepasan/);
    await expectText(p, "Tinjau pelepasan karantina");
    await expectText(p, "Periksa penyedia pembayaran");
  },
});
add({
  ...R,
  card: "hn5q",
  state: "dilepas",
  path: PAYMENTS,
  prepare: async (p) => {
    await reviewRefund(p, "POS-0152");
    await clickControl(p, /Tinjau pelepasan/);
    await fillField(
      p,
      /Alasan pelepasan/,
      "Status penyedia diperiksa, belum ada pengembalian.",
    );
    await clickControl(p, /^Lepas karantina$/);
    await expectText(p, /Karantina dilepas/);
  },
});
add({
  ...R,
  card: "hn5q",
  state: "buka-ulang",
  path: PAYMENTS,
  prepare: async (p) => {
    await reviewRefund(p, "POS-0152");
    await clickControl(p, /Tinjau buka ulang/);
    // The mockup's panel heading "Kembalikan refund untuk ditinjau" is not
    // rendered by the dialog (reopen.heading is unused): reported, not waited on.
    await expectText(p, "Periksa juga status penyedia");
  },
});
add({
  ...R,
  card: "hn5q",
  state: "kosong",
  path: `${PAYMENTS}?mock=empty`,
  // With no refunds at all the list is empty before the quarantine filter.
  prepare: async (p) => {
    await openRefundsTab(p);
    await expectText(p, "Belum ada refund");
  },
});

// ---- I7 legend-6om3: kotak persetujuan; legend-1uk9: e-struk publik ------------
// /kelola/persetujuan: S-008 is the cashier's shift close (the owner is the
// approver and sees the difference), S-009 is the owner's own (requester: the
// figure is hidden, the row says "Lihat status").
const INBOX = "/kelola/persetujuan";
const A = { card: "6om3", group: "i7", screen: "persetujuan" };

add({
  ...A,
  state: "normal",
  path: INBOX,
  prepare: async (p) => {
    await expectText(p, /Tutup shift kasir/);
    await expectText(p, /Selisih kas/);
  },
});
add({
  ...A,
  state: "peminta",
  path: INBOX,
  prepare: async (p) => {
    await expectText(p, /Tutup shift kasir/);
    // Own request (S-009), not the cashier's S-008 that the owner approves.
    const own = p
      .getByText(/S-009/)
      .filter({ visible: true })
      .first()
      .locator("xpath=ancestor::*[.//*[contains(., 'Lihat status')]][1]")
      .locator('button, a')
      .filter({ hasText: /Lihat status/ })
      .first();
    await own.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
    await own.click();
    await p
      .getByRole("dialog")
      .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  },
});
add({
  ...A,
  state: "empty",
  path: `${INBOX}?mock=empty`,
  prepare: (p) => expectText(p, "Tidak ada permintaan menunggu"),
});
add({
  ...A,
  state: "loading",
  path: `${INBOX}?mock=slow`,
  noHydration: true,
  prepare: (p) => expectBusy(p),
});
add({
  ...A,
  state: "error",
  path: `${INBOX}?mock=error`,
  prepare: async (p) => {
    await expectText(p, "Kotak Approval tidak bisa dimuat");
    await expectButton(p, /Coba lagi/);
  },
});

const RECEIPT = `/r/${RECEIPT_TOKEN}`;
const S = { card: "1uk9", group: "i7", screen: "struk-publik" };

add({
  ...S,
  state: "normal",
  path: RECEIPT,
  prepare: async (p) => {
    await expectHeading(p, "Struk elektronik");
    await expectText(p, /POS01-000048/);
  },
});
add({
  ...S,
  state: "kuitansi",
  path: `${RECEIPT}?demo=kuitansi`,
  prepare: (p) => expectHeading(p, "Kuitansi"),
});
add({
  ...S,
  state: "memuat",
  path: `${RECEIPT}?mock=slow`,
  noHydration: true,
  prepare: (p) => expectBusy(p),
});
add({
  ...S,
  state: "gagal",
  path: `${RECEIPT}?demo=error`,
  prepare: async (p) => {
    await expectText(p, "Struk belum dapat dimuat");
    await expectButton(p, /Coba lagi/);
  },
});
add({
  ...S,
  state: "tidak-tersedia",
  path: `${RECEIPT}?demo=invalid`,
  prepare: (p) => expectText(p, "Tautan struk tidak tersedia"),
});

// ---- helpers -----------------------------------------------------------------

function textMatcher(text) {
  return typeof text === "string" ? new RegExp(escapeRegExp(text)) : text;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// All waits target visible elements only: POS screens render both a desktop and
// a mobile variant of some blocks, and one of them is display:none.
async function expectText(page, text, timeout = COLD_TIMEOUT) {
  await page
    .getByText(textMatcher(text))
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout });
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
/**
 * Waits for finite animations (dialog fade/zoom) to end: axe must not sample
 * the contrast of a half-transparent dialog. Looping skeleton pulses are left.
 */
async function settle(page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    );
  });
  await page.waitForTimeout(100);
}
async function expectLink(page, name) {
  await page
    .getByRole("link", { name })
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
/** The button must not be on screen (the money rule: no second payout/collect). */
async function expectNoButton(page, name) {
  const count = await page
    .getByRole("button", { name })
    .filter({ visible: true })
    .count();
  if (count > 0) throw new Error(`unexpected visible button: ${name}`);
}
async function expectBusy(page) {
  await page
    .locator('[aria-busy="true"]')
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
/** Clicks a button/radio/tab/link by its visible text. */
async function clickControl(page, name) {
  const control = page
    .locator('button, [role="radio"], [role="tab"], [role="switch"], a')
    .filter({ hasText: name })
    .filter({ visible: true })
    .first();
  await control.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await control.click();
}
/** Fills the input whose label matches. */
async function fillField(page, label, value) {
  const field = page.getByLabel(label).filter({ visible: true }).first();
  await field.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await field.fill(value);
}
/** window.__legendMock is installed when the mock runtime boots. */
async function setScenario(page, scenario) {
  await page.waitForFunction(() => Boolean(window.__legendMock), undefined, {
    timeout: COLD_TIMEOUT,
  });
  await page.evaluate(
    (value) => window.__legendMock.setScenario(value),
    scenario,
  );
}

/**
 * Before any script of the page runs: theme and per-screen localStorage, and
 * endpoints that fail from their first call. The failures are queued the moment
 * the mock runtime assigns `window.__legendMock` (a setter), so they are in
 * place before the first request; six per endpoint outlast the query retries.
 */
async function prepareContext(page, theme, screen) {
  await page.addInitScript(
    ({ themeKey, themeValue, entries, failIds }) => {
      try {
        localStorage.setItem(themeKey, themeValue);
        for (const [key, value] of Object.entries(entries))
          localStorage.setItem(key, value);
      } catch {
        // storage blocked: the page still loads in its default theme
      }
      if (failIds.length === 0) return;
      let control;
      Object.defineProperty(window, "__legendMock", {
        configurable: true,
        get: () => control,
        set: (value) => {
          control = value;
          for (const id of failIds)
            for (let i = 0; i < 6; i += 1)
              value.failNext(id, {
                status: 503,
                code: "SERVICE_UNAVAILABLE",
              });
        },
      });
    },
    {
      themeKey: THEME_KEY,
      themeValue: theme,
      entries: screen.localStorage ?? {},
      failIds: screen.failOnBoot ?? [],
    },
  );
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
  const exact = `${screen.screen}-${screen.state}`;
  if (only.size === 0) return true;
  return (
    only.has(screen.screen) ||
    only.has(exact) ||
    only.has(screen.card) ||
    only.has(screen.group)
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
  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const only = new Set(args.filter((arg) => !arg.startsWith("--")));
  const themeFlag = flags
    .find((flag) => flag.startsWith("--theme="))
    ?.slice("--theme=".length);
  if (themeFlag !== undefined && !THEMES.includes(themeFlag)) {
    console.error(`--theme must be one of: ${THEMES.join(", ")}`);
    process.exit(2);
  }
  const themes = themeFlag ? [themeFlag] : THEMES;

  const screens = SCREENS.filter((s) => matchesSubset(s, only));
  if (screens.length === 0) {
    console.error(`No screen matches: ${[...only].join(", ")}`);
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(OUT_DIR, { recursive: true });
  let browser = await chromium.launch();
  const failures = [];
  let total = 0;
  try {
    for (const screen of screens) {
      for (const theme of themes.filter((t) => screen.themes.includes(t))) {
        for (const viewport of screen.viewports) {
          total += 1;
          const id = `${screen.screen}-${screen.state}-${theme}-${viewport.label}`;
          // A crashed/closed browser must fail one state, not the whole run.
          if (!browser.isConnected()) browser = await chromium.launch();
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            locale: "id-ID",
            timezoneId: "Asia/Jakarta",
            colorScheme: theme,
          });
          const page = await context.newPage();
          try {
            await prepareContext(page, theme, screen);
            if (screen.seed) await screen.seed(page, baseUrl);
            await page.goto(`${baseUrl}${screen.path}`, {
              waitUntil: "domcontentloaded",
            });
            // Loading states are skeleton screenshots: hydration is not awaited.
            if (!screen.noHydration) await waitForHydration(page);
            await screen.prepare(page);
            await settle(page);
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
            await page.evaluate(() => window.scrollTo(0, 0));
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
            await context.close().catch(() => {});
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(
    failures.length === 0
      ? `\nAll ${total} checks passed.`
      : `\n${failures.length} of ${total} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
