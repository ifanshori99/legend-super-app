// Screenshot + axe + overflow + print-page check untuk ui-mixed-q36.
// Jalan: LEGEND_MOCK_PORT=3247 node design/screens/ui-mixed-q36/shots.mjs
// Butuh mock server hidup. Output: PNG, axe.json di folder ini.
// Dua bagian: (1) keadaan halaman lewat ?mock= (normal/loading/empty/error),
// (2) alur interaktif (split, notifikasi, dialog payroll, sarapan tiket) yang meniru
// e2e/legend-wwyyk.mock.spec.ts dan e2e/legend-wpqs.mock.spec.ts.
import { chromium, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const BASE = `http://localhost:${process.env.LEGEND_MOCK_PORT || 3247}`;
const require = createRequire(import.meta.url);
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const SCENARIO_KEY = 'legend-mock-scenario';
const COLD = 30_000;
const VIEWPORTS = {
  1280: { width: 1280, height: 800 },
  390: { width: 390, height: 844 },
  320: { width: 320, height: 640 },
};

// ---------------------------------------------------------------- axe
let AxeBuilder = null;
try {
  AxeBuilder = require('@axe-core/playwright').AxeBuilder ?? require('@axe-core/playwright').default;
} catch {}
let axeSourcePath = null;
if (!AxeBuilder) {
  try {
    axeSourcePath = require.resolve('axe-core/axe.min.js');
  } catch {
    const store = join(root, 'node_modules', '.pnpm');
    const dir = existsSync(store) && readdirSync(store).find((d) => d.startsWith('axe-core@'));
    if (dir) axeSourcePath = join(store, dir, 'node_modules', 'axe-core', 'axe.min.js');
  }
  if (!axeSourcePath || !existsSync(axeSourcePath)) {
    console.warn('axe tidak ditemukan: audit axe dilewati');
    axeSourcePath = null;
  }
}

async function runAxe(page) {
  let violations;
  if (AxeBuilder) {
    violations = (await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations;
  } else if (axeSourcePath) {
    await page.addScriptTag({ content: readFileSync(axeSourcePath, 'utf8') });
    violations = await page.evaluate(
      async (tags) => (await window.axe.run(document, { runOnly: { type: 'tag', values: tags } })).violations,
      TAGS,
    );
  } else {
    return null;
  }
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  return {
    serious: bad.filter((v) => v.impact === 'serious').length,
    critical: bad.filter((v) => v.impact === 'critical').length,
    rules: bad.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0]?.target })),
  };
}

// ---------------------------------------------------------------- ONLY
// ONLY=split,tiket:flow,payroll-policies  -> hanya layar itu; ":flow" / ":pages" membatasi bagian.
const ONLY = (process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const want = (name, kind) => ONLY.length === 0 || ONLY.some((e) => e === name || e === `${name}:${kind}`);

// ---------------------------------------------------------------- hasil
const axeOut = {};
const overflow = {};
const printPages = {};
const failures = [];
const succeeded = new Set();

/** Konteks baru = localStorage kosong; init script juga hapus key skenario sebelum app jalan. */
async function newPage(browser, width, inits = []) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[width] });
  const page = await ctx.newPage();
  await page.addInitScript((k) => {
    try {
      localStorage.removeItem(k);
      localStorage.setItem('legend-theme', 'light');
    } catch {}
  }, SCENARIO_KEY);
  for (const { fn, arg } of inits) await page.addInitScript(fn, arg);
  return { ctx, page };
}

/** Sama dengan failFirstCall di e2e/mock-fail-next.ts: antre gagal sebelum app boot. */
const failFirstInit = (endpointId, failure) => ({
  fn: ({ endpointId, failure }) => {
    let control;
    Object.defineProperty(window, '__legendMock', {
      configurable: true,
      get: () => control,
      set: (value) => {
        control = value;
        value.failNext(endpointId, failure);
      },
    });
  },
  arg: { endpointId, failure },
});
const failNextCall = (page, endpointId, failure) =>
  page.evaluate(({ endpointId, failure }) => window.__legendMock.failNext(endpointId, failure), { endpointId, failure });

async function measureOverflow(page, key) {
  const r = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  overflow[key] = { ...r, overflow: r.scrollWidth > r.innerWidth };
  console.log(`overflow320 ${key}: scrollWidth=${r.scrollWidth} innerWidth=${r.innerWidth} ${r.overflow ? 'OVERFLOW' : 'ok'}`);
}

/**
 * Tangkap satu keadaan: PNG fullPage + axe; di 320 hanya ukur overflow.
 * `fullPage: false` = hanya viewport (untuk bilah `fixed` yang melayang di tangkapan fullPage).
 */
async function snap(page, screen, state, w, { fullPage = true } = {}) {
  const key = `${screen}-${state}-${w}`;
  if (w === 320) return measureOverflow(page, `${screen}-${state}`);
  await page.screenshot({ path: join(here, `${key}.png`), fullPage });
  const res = await runAxe(page);
  if (res) {
    axeOut[key] = res;
    console.log(`axe ${screen} ${state} ${w}: serious=${res.serious} critical=${res.critical}`);
  }
}

/**
 * Alur interaktif: tiap lebar = halaman baru; `start` menyiapkan, lalu tiap langkah
 * dijalankan berurutan dan ditangkap. Satu langkah gagal = alur lebar itu berhenti.
 */
async function flow(browser, { screen, widths = [1280, 390], inits = [], start, steps }) {
  if (!want(screen, 'flow')) return;
  for (const w of widths) {
    const { ctx, page } = await newPage(browser, w, inits);
    try {
      await start(page, w);
      for (const step of steps) {
        try {
          await step.run(page, w);
          await page.waitForTimeout(400);
          // `shot` = atur gulir sebelum tangkap; `fullPage: false` = viewport saja.
          if (step.shot) {
            await step.shot(page, w);
            await page.waitForTimeout(200);
          }
          await snap(page, screen, step.state, w, { fullPage: step.fullPage ?? true });
          succeeded.add(`${screen} ${step.state} ${w}`);
        } catch (e) {
          const msg = `${screen} ${step.state} ${w}: ${e.message.split('\n')[0]}`;
          console.error(`GAGAL ${msg}`);
          if (process.env.VERBOSE) console.error(e.message.slice(0, 1500));
          failures.push(msg);
          break;
        }
      }
    } catch (e) {
      const msg = `${screen} start ${w}: ${e.message.split('\n')[0]}`;
      console.error(`GAGAL ${msg}`);
      failures.push(msg);
    } finally {
      await ctx.close();
    }
  }
}

// ---------------------------------------------------------------- bagian 1: keadaan halaman
function withQuery(path, query) {
  if (!query) return path;
  return path + (path.includes('?') ? '&' : '?') + query;
}

const PAGES = [
  { name: 'payroll-policies', path: '/kelola/payroll/pengaturan?tab=policies' },
  { name: 'payroll-thr', path: '/kelola/payroll/pengaturan?tab=thr' },
  { name: 'notifikasi', path: '/kelola/notifikasi?tab=preferences' },
  {
    name: 'tiket',
    path: '/member/fasilitas/01JBQ7Z8K3M4N5P6Q7R8S9T0VX',
    // Sarapan ada di bawah: gulir ke sana lalu tangkap (fullPage tetap).
    afterNormal: async (page) => {
      await page.getByTestId('breakfast-section').scrollIntoViewIfNeeded({ timeout: 10_000 });
    },
  },
  {
    name: 'label-prep',
    path: '/operasional/label-prep',
    print: true,
    // Pilih baris (garis kiri tebal): baris ke-2 bila ada, supaya bukan pilihan bawaan.
    afterNormal: async (page) => {
      const rows = page.locator('[data-slot="prep-label"] button');
      await rows.first().waitFor({ timeout: 10_000 });
      await rows.nth((await rows.count()) > 1 ? 1 : 0).click();
      await page.waitForTimeout(300);
    },
  },
];
const STATES = [
  { name: 'normal', query: '' },
  { name: 'loading', query: 'mock=slow' },
  { name: 'empty', query: 'mock=empty' },
  { name: 'error', query: 'mock=error' },
];

async function openPage(page, url, state) {
  if (state.name === 'loading') {
    await page.goto(url, { waitUntil: 'commit' }); // ambil sebelum 3 s
    await page.waitForTimeout(600);
  } else {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);
  }
}

function countPdfPages(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
}

async function pageStates(browser) {
  for (const screen of PAGES) {
    if (!want(screen.name, 'pages')) continue;
    for (const state of STATES) {
      const url = BASE + withQuery(screen.path, state.query);
      for (const w of [1280, 390]) {
        const { ctx, page } = await newPage(browser, w);
        try {
          await openPage(page, url, state);
          if (state.name === 'normal' && screen.afterNormal) await screen.afterNormal(page);
          await snap(page, screen.name, state.name, w);
          succeeded.add(`${screen.name} ${state.name} ${w}`);
          if (screen.print && w === 1280) {
            await page.emulateMedia({ media: 'print' });
            const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
            printPages[`${screen.name}-${state.name}`] = countPdfPages(pdf);
            console.log(`print ${screen.name} ${state.name}: ${printPages[`${screen.name}-${state.name}`]} halaman`);
          }
        } catch (e) {
          const msg = `${screen.name} ${state.name} ${w}: ${e.message.split('\n')[0]}`;
          console.error(`GAGAL ${msg}`);
          failures.push(msg);
        } finally {
          await ctx.close();
        }
      }
      if (state.name === 'normal') {
        const { ctx, page } = await newPage(browser, 320);
        try {
          await openPage(page, url, state);
          if (screen.afterNormal) await screen.afterNormal(page);
          await measureOverflow(page, `${screen.name}-normal`);
        } catch (e) {
          failures.push(`overflow ${screen.name}: ${e.message.split('\n')[0]}`);
        } finally {
          await ctx.close();
        }
      }
    }
  }
}

// ---------------------------------------------------------------- bagian 2a: split bill
const freeTable = `v1.${'C'.repeat(40)}.${'D'.repeat(43)}`;
const CLAIM_ENDPOINT = 'POST /api/table-sessions/:sessionId/splits/:splitId/claim';
const claimOf = (page, state) =>
  page.locator(`[data-testid^="split-claim-"][data-claim-state="${state}"]`);

async function joinTable(page) {
  await page.goto(`${BASE}/t/${freeTable}`);
  const save = page.getByRole('button', { name: 'Simpan' });
  await expect(async () => {
    await page.getByRole('button', { name: /Pilih jumlah tamu/ }).click();
    await expect(save).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: COLD });
  await save.click();
  await expect(page.getByRole('button', { name: /Pilih jumlah tamu/ })).toHaveCount(0);
}

/**
 * Bagi tagihan jadi dua, mulai bayar bagian 1 dengan QRIS lalu BERHENTI sebelum lunas
 * (mock butuh 4 s): rahasia pembayar sudah tersimpan, jadi /bill menampilkan klaim
 * "belum-bayar". Hanya bagian milik tamu yang punya rahasia yang menampilkan klaim.
 */
async function splitAndStartPay(page) {
  await joinTable(page);
  await page.getByRole('button', { name: 'Lihat detail Espresso' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('radio', { name: /Dingin/ }).click();
  await sheet.getByRole('radio', { name: 'Normal' }).click();
  await sheet.getByRole('button', { name: /^Tambah · / }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('link', { name: 'Lihat keranjang' }).click();
  await page.getByRole('button', { name: 'Bagi tagihan' }).click();
  await page.getByRole('button', { name: 'Buat pembagian' }).click();
  await expect(page.getByText('Bagian 1')).toBeVisible();
  await page.getByRole('button', { name: 'Bayar bagian ini' }).first().click();
  const pay = page.getByRole('dialog');
  await pay.getByRole('radio', { name: /QRIS/ }).click();
  await pay.getByRole('button', { name: 'Lanjut bayar' }).click();
  await page.waitForTimeout(1000);
}

const claimButton = (page) => claimOf(page, 'siap').getByRole('button', { name: 'Klaim bagian saya' });

const splitSteps = [
  {
    state: 'belum-bayar',
    run: async (p) => {
      await p.goto(`${BASE}/t/${freeTable}/bill`);
      await expect(claimOf(p, 'belum-bayar')).toHaveCount(1, { timeout: 3_000 });
    },
  },
  {
    // Pelunasan mock hanya jalan di halaman bayar: kembali ke sana, tunggu lunas, buka /bill lagi.
    state: 'siap',
    run: async (p) => {
      await p.goBack();
      await expect(p.getByText('Pembayaran berhasil', { exact: true })).toBeVisible({ timeout: 15_000 });
      await p.goto(`${BASE}/t/${freeTable}/bill`);
      await expect(claimOf(p, 'siap')).toHaveCount(1, { timeout: COLD });
    },
  },
  {
    state: 'error',
    run: async (p) => {
      await failNextCall(p, CLAIM_ENDPOINT, { status: 500, code: 'INTERNAL_ERROR' });
      await claimButton(p).click();
      await expect(claimOf(p, 'error')).toHaveCount(1);
    },
  },
  {
    state: 'berhasil',
    run: async (p) => {
      await claimOf(p, 'error').getByRole('button', { name: 'Coba klaim lagi' }).click();
      await expect(claimOf(p, 'berhasil')).toHaveCount(1);
    },
  },
  {
    // Jam mock maju: klaim tersimpan dimundurkan melewati 24 jam, lalu muat ulang.
    state: 'kedaluwarsa',
    run: async (p) => {
      await p.evaluate(() => {
        const past = new Date(Date.now() - 60_000).toISOString();
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (!k?.startsWith('legend-qr-split-claim:')) continue;
          const v = JSON.parse(sessionStorage.getItem(k));
          sessionStorage.setItem(k, JSON.stringify({ ...v, claimableUntil: past }));
        }
      });
      await p.reload();
      await expect(claimOf(p, 'kedaluwarsa')).toHaveCount(1, { timeout: COLD });
    },
  },
  {
    // Token sudah pernah keluar: minta lagi -> server jawab "claimed".
    state: 'sudah-diklaim',
    run: async (p) => {
      await p.reload();
      await expect(claimOf(p, 'siap')).toHaveCount(1, { timeout: COLD });
      await claimButton(p).click();
      await expect(claimOf(p, 'sudah-diklaim')).toHaveCount(1);
    },
  },
];

/**
 * Bilah klaim `fixed` menutupi bawah (dan dia sendiri elemen split-claim): tangkap viewport,
 * "Bagian 2" tepat di bawah header supaya Bagian 2 sampai kartu "Bagian Anda" (status klaim)
 * utuh di atas bilah.
 */
const splitShot = async (p) => {
  await p.getByText('Bagian 2', { exact: true }).first().evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -88);
  });
};
for (const step of splitSteps) {
  step.shot = splitShot;
  step.fullPage = false;
}

// ---------------------------------------------------------------- bagian 2b: notifikasi
const PREF_ENDPOINT = 'PUT /api/notifications/preferences';
const notifSteps = [
  {
    state: 'validasi',
    run: async (p) => {
      // Tab Preferensi dibuka lewat ?tab=preferences; bila belum tersentuh, mulai dulu.
      const start = p.getByRole('button', { name: 'Atur preferensi' });
      const quiet = p.getByRole('switch', { name: 'Aktifkan jam tenang' });
      await expect(start.or(quiet).first()).toBeVisible({ timeout: COLD });
      if (await start.isVisible()) await start.click();
      await expect(async () => {
        if ((await quiet.getAttribute('aria-checked')) !== 'true') await quiet.click();
        await expect(p.getByLabel(/^Mulai/)).toBeVisible({ timeout: 1_500 });
      }).toPass({ timeout: COLD });
      await p.getByLabel(/^Mulai/).fill('22:00');
      await p.getByLabel(/^Selesai/).fill('22:00');
      await p.getByLabel(/^Selesai/).blur();
      await expect(p.getByText('Jam mulai dan selesai tidak boleh sama.')).toBeVisible();
    },
  },
  {
    state: 'simpan-gagal',
    run: async (p) => {
      await p.getByLabel(/^Selesai/).fill('06:00');
      await failNextCall(p, PREF_ENDPOINT, { status: 500, code: 'INTERNAL_ERROR' });
      await p.getByRole('button', { name: 'Simpan preferensi' }).click();
      await expect(p.getByText('Preferensi belum tersimpan.')).toBeVisible();
    },
  },
  {
    state: 'sukses',
    run: async (p) => {
      await p.getByRole('button', { name: 'Simpan preferensi' }).click();
      await expect(p.getByText('Preferensi notifikasi tersimpan.')).toBeVisible();
    },
  },
];

// ---------------------------------------------------------------- bagian 2c: dialog payroll
const ENTITIES_ENDPOINT = 'GET /api/org/legal-entities';

/** Klik sebelum hydrate hilang: ulangi sampai dialog muncul (pola e2e). */
async function openDialog(page, button) {
  const dialog = page.getByRole('dialog');
  await expect(async () => {
    await page.getByRole('button', { name: button }).first().click();
    await expect(dialog).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: COLD });
  return dialog;
}
async function ensureEntity(dialog, page) {
  const field = dialog.getByRole('combobox', { name: /Badan usaha/ });
  await expect(field).toBeEnabled();
  if ((await field.innerText()).includes('Pilih badan usaha')) {
    await field.click();
    await page.getByRole('option').first().click();
  }
  await expect(field).not.toContainText('Pilih badan usaha');
}
/** Gulir dialog dan semua turunannya yang bisa digulir ke atas: judul + banner utuh. */
const dialogToTop = (dialog) =>
  dialog.evaluate((root) => {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.scrollHeight > el.clientHeight) el.scrollTop = 0;
    }
  });
/** Gulir ke field bergalat pertama (tengah) supaya pesan galatnya tampak. */
const toFirstInvalid = (dialog) =>
  dialog.locator('[aria-invalid="true"]').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
const saveButton = (dialog) => dialog.getByRole('button', { name: /^Simpan|^Buat/ }).last();

async function fillPolicy(dialog) {
  await dialog.getByLabel('Nama kebijakan').fill('Karyawan bulanan');
  await dialog.getByLabel('Kode kelompok').fill('TETAP');
  await dialog.getByLabel('Nama kelompok').fill('Karyawan tetap');
  await dialog.getByLabel('Tanggal potong absensi').fill('25');
  await dialog.getByLabel(/^Tanggal bayar/).first().fill('28');
}
async function fillThr(dialog) {
  await dialog.getByLabel('Nama jadwal').fill('THR Idul Fitri 2027');
  await dialog.getByLabel('Nama hari libur').fill('Idul Fitri');
  await dialog.getByLabel('Tanggal libur').fill('2027-03-10');
  await dialog.getByLabel('Tanggal bayar').fill('2027-03-03');
  await dialog.getByLabel('Tanggal acuan masa kerja').fill('2027-03-03');
}

/** Empat keadaan dialog: normal, validasi, simpan-gagal, sukses. */
function dialogSteps({ button, fill, postPath, toast, normalAfterSave = false }) {
  let dialog;
  return [
    {
      state: 'dialog-normal',
      run: async (p) => {
        dialog = await openDialog(p, button);
        await ensureEntity(dialog, p);
      },
      shot: () => dialogToTop(dialog),
    },
    {
      // Simpan tanpa mengisi apa pun.
      state: 'dialog-validasi',
      run: async () => {
        await saveButton(dialog).click();
        await expect(dialog.locator('[aria-invalid="true"]').first()).toBeVisible();
      },
      shot: () => toFirstInvalid(dialog),
    },
    {
      state: 'dialog-simpan-gagal',
      run: async (p) => {
        await fill(dialog);
        await failNextCall(p, postPath, { status: 500, code: 'INTERNAL_ERROR' });
        await saveButton(dialog).click();
        await expect(dialog.getByText(/Belum berhasil disimpan|Gagal menyimpan/)).toBeVisible();
      },
      shot: () => dialogToTop(dialog),
    },
    {
      state: 'dialog-sukses',
      run: async (p) => {
        // ?mock=empty memaksa GET kosong walau data sudah tersimpan (artefak mock, bukan bug
        // app: query daftar sudah di-invalidate). Kembali ke skenario normal sebelum simpan
        // supaya refetch sesudah sukses menampilkan data yang baru dibuat.
        if (normalAfterSave) await p.evaluate(() => window.__legendMock.setScenario('normal'));
        await saveButton(dialog).click();
        await expect(dialog).toBeHidden();
        await expect(p.getByText(toast)).toBeVisible();
      },
    },
  ];
}

function entityFailStep(button, state = 'dialog-entitas-gagal') {
  return [
    {
      state,
      run: async (p) => {
        const dialog = await openDialog(p, button);
        await expect(dialog.getByText('Daftar badan usaha tidak dapat dimuat')).toBeVisible();
      },
    },
  ];
}

// ---------------------------------------------------------------- bagian 2d: sarapan tiket
const TICKET = '/member/fasilitas/01JBQ7Z8K3M4N5P6Q7R8S9T0VX';
const submitBreakfast = (p) => p.getByRole('button', { name: 'Pesan sarapan' });
/** Menu mulai kosong: tambah satu porsi (subtotal harus berubah), seperti e2e/legend-ijv8. */
async function addDish(p) {
  const subtotal = p.getByTestId('breakfast-subtotal');
  const before = await subtotal.innerText();
  await p.getByRole('button', { name: /^Tambah / }).first().click();
  await expect(subtotal).not.toHaveText(before);
}
const breakfastSteps = [
  {
    state: 'breakfast-normal',
    run: async (p) => {
      await expect(p.getByTestId('breakfast-form')).toBeVisible({ timeout: COLD });
      await p.getByTestId('breakfast-section').scrollIntoViewIfNeeded();
    },
  },
  {
    // Kirim tanpa memilih meja (antar ke meja, meja kosong).
    state: 'breakfast-validasi',
    run: async (p) => {
      await addDish(p);
      await submitBreakfast(p).click();
      await expect(p.getByText('Pilih nomor meja untuk pengantaran.')).toBeVisible();
    },
  },
  {
    state: 'breakfast-sukses',
    run: async (p) => {
      await p.getByRole('combobox', { name: /Nomor meja/ }).click();
      await p.getByRole('option').first().click();
      await submitBreakfast(p).click();
      await expect(p.getByTestId('breakfast-success')).toBeVisible({ timeout: 15_000 });
    },
    // Viewport saja, awal kartu sukses di bawah header (tidak memotong judul kartu).
    fullPage: false,
    shot: (p) =>
      p.getByTestId('breakfast-success').evaluate((el) => {
        el.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -96);
      }),
  },
];

// ---------------------------------------------------------------- jalan
mkdirSync(here, { recursive: true });
const browser = await chromium.launch();
try {
  await pageStates(browser);

  // split: 390 tangkap, 320 hanya ukur overflow di tiap keadaan.
  for (const widths of [[390], [320]]) {
    await flow(browser, {
      screen: 'split',
      widths,
      start: splitAndStartPay,
      steps: splitSteps,
    });
  }

  await flow(browser, {
    screen: 'notifikasi',
    start: (p) => p.goto(`${BASE}/kelola/notifikasi?tab=preferences`),
    steps: notifSteps,
  });

  const payroll = [
    {
      screen: 'payroll-policies',
      path: '/kelola/payroll/pengaturan?mock=empty',
      button: 'Kebijakan baru',
      fill: fillPolicy,
      postPath: 'POST /api/hris/payroll/policies',
      toast: 'Kebijakan payroll dibuat.',
      normalAfterSave: true,
    },
    {
      screen: 'payroll-thr',
      path: '/kelola/payroll/pengaturan?tab=thr&mock=empty',
      button: 'Jadwal THR baru',
      fill: fillThr,
      postPath: 'POST /api/hris/payroll/thr-schedules',
      toast: 'Jadwal THR dibuat.',
      normalAfterSave: true,
    },
  ];
  for (const cfg of payroll) {
    if (!want(cfg.screen, 'flow')) continue;
    const start = async (p) => {
      await p.goto(BASE + cfg.path);
      await expect(p.getByRole('button', { name: cfg.button }).first()).toBeVisible({ timeout: COLD });
    };
    await flow(browser, { screen: cfg.screen, start, steps: dialogSteps(cfg) });
    await flow(browser, {
      screen: cfg.screen,
      inits: [failFirstInit(ENTITIES_ENDPOINT, { status: 409, code: 'CONFLICT' })],
      start,
      steps: entityFailStep(cfg.button),
    });
  }

  await flow(browser, {
    screen: 'tiket',
    start: (p) => p.goto(BASE + TICKET),
    steps: breakfastSteps,
  });
} finally {
  await browser.close();
  // Gabung dengan hasil lari sebelumnya (mis. lari ONLY=...), jangan menimpa.
  let old = {};
  try {
    old = JSON.parse(readFileSync(join(here, 'axe.json'), 'utf8'));
  } catch {}
  const keptFailures = (old.failures ?? []).filter((f) => !succeeded.has(f.split(': ')[0]));
  const merged = {
    axe: { ...(old.axe ?? {}), ...axeOut },
    overflow320: { ...(old.overflow320 ?? {}), ...overflow },
    printPages: { ...(old.printPages ?? {}), ...printPages },
    failures: [...keptFailures.filter((f) => !failures.some((n) => n.split(': ')[0] === f.split(': ')[0])), ...failures],
  };
  writeFileSync(join(here, 'axe.json'), JSON.stringify(merged, null, 2));
  failures.splice(0, failures.length, ...merged.failures);
  console.log(`ditulis axe.json; ${failures.length} langkah gagal`);
  for (const f of failures) console.log(`  - ${f}`);
}
