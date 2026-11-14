/* global window, document, localStorage -- used only inside page.evaluate callbacks */
// Screenshot + axe + overflow check untuk layar alert panik staf (legend-alovk).
// Jalan: UI_CHECK_URL=http://localhost:3225 heavy node design/screens/panic-alert/shots.mjs
//        ONLY=incoming,mine ... (subset keadaan)
// UI_CHECK_URL harus server web dengan VITE_API_MOCK=true (soket palsu:
// apps/web/src/features/facility-staff/panic-mock-socket.ts). Jangan arahkan ke
// deployment asli. Output: docs/screenshots/panic-alert/<state>-<lebar>.png dan
// axe.json (jumlah serious/critical, overflow 320, langkah gagal).
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const OUT = join(root, 'docs', 'screenshots', 'panic-alert');
const BASE = (process.env.UI_CHECK_URL || 'http://localhost:3225').replace(/\/$/, '');
const PATH = '/fasilitas/darurat';
const STORAGE_KEY = 'legend.mock.panic';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const COLD = 45_000; // Vite compile route pertama.
const VIEWPORTS = {
  1280: { width: 1280, height: 900 },
  390: { width: 390, height: 844 },
  320: { width: 320, height: 640 },
};
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- axe
let AxeBuilder = null;
try {
  const mod = require('@axe-core/playwright');
  AxeBuilder = mod.AxeBuilder ?? mod.default;
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

// ---------------------------------------------------------------- keadaan
const ackButtons = (page) => page.getByRole('button', { name: /^Saya tangani/ });

/**
 * `scenario` = nilai localStorage (nama skenario soket palsu). `ready` menunggu
 * keadaan tampil; `act` (opsional) menggerakkan layar setelah siap, lalu `after` menunggu hasilnya.
 */
const STATES = [
  {
    name: 'incoming',
    scenario: 'incoming',
    ready: (p) => p.getByText('Segera ke lokasi').first().waitFor({ timeout: COLD }),
    overflow320: true,
  },
  {
    name: 'multiple',
    scenario: 'multiple',
    // Tiga alert masuk di ~0,8 s, 2,5 s, 4,2 s: tunggu tiga kartu.
    ready: async (p) => {
      await p.waitForFunction(
        () =>
          [...document.querySelectorAll('button')].filter((b) => /^Saya tangani/.test(b.textContent?.trim() ?? ''))
            .length >= 3,
        null,
        { timeout: COLD },
      );
    },
    overflow320: true,
  },
  {
    name: 'mine',
    scenario: 'incoming',
    ready: (p) => ackButtons(p).first().waitFor({ timeout: COLD }),
    act: (p) => ackButtons(p).first().click(),
    // Teks "Anda menuju" juga ada di footer; tunggu bagian settled milik sendiri.
    after: (p) => p.locator('[data-slot="panic-settled"] [data-ack="mine"]').first().waitFor({ timeout: 15_000 }),
  },
  {
    // Tanggapan ke API palsu dijawab "sudah diambil rekan lain".
    name: 'acknowledged',
    scenario: 'acknowledged',
    ready: (p) => ackButtons(p).first().waitFor({ timeout: COLD }),
    act: (p) => ackButtons(p).first().click(),
    after: (p) => p.getByText(/Sudah ditangani rekan lain/).first().waitFor({ timeout: 15_000 }),
  },
  {
    name: 'reconnecting',
    scenario: 'reconnecting',
    // Putus di ~2,5 s; spanduk koneksi tampil sambil alert terakhir tetap ada.
    ready: (p) => p.getByText(/Koneksi terputus, mencoba menyambung/).first().waitFor({ timeout: COLD }),
  },
  {
    name: 'unreachable',
    scenario: 'unreachable',
    // Percobaan ulang berturut-turut sampai ~8 s baru jatuh ke "tidak terjangkau".
    ready: (p) => p.getByText('Alert panik tidak dapat diterima').first().waitFor({ timeout: 30_000 }),
  },
  {
    name: 'revoked',
    scenario: 'revoked',
    ready: (p) => p.getByText('Akses dicabut').first().waitFor({ timeout: COLD }),
  },
  {
    name: 'idle',
    scenario: 'idle',
    ready: (p) => p.getByText('Terhubung ke outlet').first().waitFor({ timeout: COLD }),
  },
];

const ONLY = (process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const want = (name) => ONLY.length === 0 || ONLY.includes(name);

// ---------------------------------------------------------------- hasil
const axeOut = {};
const overflow = {};
const failures = [];

/** Konteks baru per keadaan/lebar: localStorage kosong, tema terang. */
async function openState(browser, state, width) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[width] });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem('legend-theme', 'light');
    } catch {}
  });
  // Atur skenario lalu muat ulang supaya soket baru membacanya.
  await page.goto(BASE + PATH, { waitUntil: 'load' });
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [STORAGE_KEY, state.scenario]);
  await page.reload({ waitUntil: 'load' });
  await state.ready(page);
  if (state.act) {
    await state.act(page);
    await state.after(page);
  }
  await page.waitForTimeout(500); // animasi masuk selesai
  return { ctx, page };
}

async function measureOverflow(page, name) {
  const r = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  overflow[name] = { ...r, overflow: r.scrollWidth > r.clientWidth };
  console.log(`overflow320 ${name}: scrollWidth=${r.scrollWidth} clientWidth=${r.clientWidth} ${overflow[name].overflow ? 'OVERFLOW' : 'ok'}`);
}

async function capture(browser, state, width) {
  const key = `${state.name}-${width}`;
  let ctx;
  try {
    const opened = await openState(browser, state, width);
    ctx = opened.ctx;
    if (width === 320) {
      await measureOverflow(opened.page, state.name);
    } else {
      await opened.page.screenshot({ path: join(OUT, `${key}.png`) });
      const res = await runAxe(opened.page);
      if (res) {
        axeOut[key] = res;
        console.log(`axe ${key}: serious=${res.serious} critical=${res.critical}`);
      }
    }
  } catch (e) {
    const msg = `${key}: ${e.message.split('\n')[0]}`;
    console.error(`GAGAL ${msg}`);
    failures.push(msg);
  } finally {
    await ctx?.close();
  }
}

// ---------------------------------------------------------------- jalan
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const state of STATES) {
    if (!want(state.name)) continue;
    for (const width of [1280, 390]) await capture(browser, state, width);
    if (state.overflow320) await capture(browser, state, 320);
  }
} finally {
  await browser.close();
  const totals = Object.values(axeOut).reduce(
    (t, r) => ({ serious: t.serious + r.serious, critical: t.critical + r.critical }),
    { serious: 0, critical: 0 },
  );
  const summary = {
    base: BASE,
    path: PATH,
    totals,
    axe: axeOut,
    overflow320: overflow,
    failures,
  };
  writeFileSync(join(OUT, 'axe.json'), JSON.stringify(summary, null, 2));
  console.log(
    `ditulis ${join(OUT, 'axe.json')}: serious=${totals.serious} critical=${totals.critical}, ${failures.length} gagal`,
  );
  if (failures.length > 0 || totals.serious > 0 || totals.critical > 0) process.exitCode = 1;
}
