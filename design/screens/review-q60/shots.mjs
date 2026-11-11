// Screenshot review UI untuk oa0qk (sarapan bayar dulu). Mode mock web.
// Jalan: LEGEND_MOCK_PORT=3262 heavy node design/screens/review-q60/shots.mjs
// Butuh mock server hidup (lihat README.md). Output: PNG di folder ini.
import { chromium } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = `http://localhost:${process.env.LEGEND_MOCK_PORT || 3262}`;
// Tiket 'issued' (mulai 1 jam lagi): sesudah bayar, pesanan berstatus lunas dan menunggu jam dapur.
const TICKET = '/member/fasilitas/01JBQ7Z8K3M4N5P6Q7R8S9T0VW';
const FIXTURE_LINK = '/bayar/pl_pending_7b6d4c8fa1d3e5b7c9f0a2d4';
const VIEWPORTS = { 390: { width: 390, height: 844 }, 1280: { width: 1280, height: 800 } };
const COLD = 30_000;

const browser = await chromium.launch();
const notes = [];
try {
  for (const w of [390, 1280]) {
    const ctx = await browser.newContext({ viewport: VIEWPORTS[w] });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('legend-mock-scenario');
        localStorage.setItem('legend-theme', 'light');
      } catch {}
    });
    const shot = (name, opts = {}) => page.screenshot({ path: join(here, `${name}-${w}.png`), ...opts });

    await page.goto(BASE + TICKET);
    await page.getByTestId('breakfast-form').waitFor({ timeout: COLD });
    await page.getByTestId('breakfast-section').scrollIntoViewIfNeeded();
    // Menu mulai kosong: tambah satu porsi, pilih meja, pesan -> menunggu bayar.
    await page.getByRole('button', { name: /^Tambah / }).first().click();
    await page.getByRole('combobox', { name: /Nomor meja/ }).click();
    await page.getByRole('option').first().click();
    await page.getByRole('button', { name: 'Pesan sarapan' }).click();
    await page.getByTestId('breakfast-pay').waitFor({ timeout: 15_000 });
    await page.getByTestId('breakfast-success').evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -96);
    });
    await page.waitForTimeout(400);
    await shot('01-tiket-menunggu-bayar', { fullPage: false });

    // Tekan "Bayar": mock mengembalikan token pl_mock_*, app membuka /bayar/<token>.
    await page.getByTestId('breakfast-pay').click();
    await page.waitForURL(/\/bayar\//, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    notes.push(`${w}: after Bayar -> ${new URL(page.url()).pathname.slice(0, 20)}...`);
    await shot('02-bayar-sarapan');

    // Pilih QRIS: kode muncul (03). Mock menganggap lunas beberapa detik kemudian.
    await page.getByRole('radio', { name: /QRIS/ }).check({ force: true }).catch(() => page.getByText('QRIS', { exact: true }).click());
    await page.getByRole('button', { name: 'Lanjutkan pembayaran' }).click();
    await page.waitForTimeout(1500);
    await shot('03-bayar-kode-qris-sarapan');

    // Status lunas di halaman bayar, lalu kembali ke tiket lewat tombol (tanpa reload, state mock tetap).
    await page.getByText(/lunas|berhasil/i).first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await shot('05-bayar-lunas-sarapan');
    // Tombol Selesai memuat ulang halaman (state mock hilang); riwayat browser tidak.
    await page.goBack();
    await page.waitForURL(/\/member\/fasilitas\//, { timeout: 15_000 });
    await page.getByTestId('breakfast-section').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.getByTestId('breakfast-section').evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -96);
    });
    await page.waitForTimeout(400);
    notes.push(`${w}: ticket text: ${(await page.getByTestId('breakfast-section').innerText()).replace(/\s+/g, ' ').slice(0, 160)}`);
    await shot('04-tiket-lunas');
    await ctx.close();
  }
} finally {
  await browser.close();
  console.log(notes.join('\n'));
}
