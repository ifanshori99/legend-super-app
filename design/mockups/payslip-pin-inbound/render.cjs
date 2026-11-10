/* Static design exports only. Run from the worktree with:
 * heavy node design/mockups/payslip-pin-inbound/render.cjs
 * No server, app build, WhatsApp request, or backend is used.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const directory = __dirname;
const screens = [
  ['lupa-pin', ['Lupa PIN?', 'Lewat WhatsApp', 'Lihat cara minta bantuan']],
  ['menunggu-whatsapp', ['Kirim lewat WhatsApp', 'Buka WhatsApp', 'Salin kode', 'Salin nomor tujuan', 'Menunggu pesan Anda']],
  ['kode-disalin', ['Kode disalin', 'Salin nomor tujuan', 'Tempel dan kirim lewat WhatsApp']],
  ['terverifikasi', ['Nomor berhasil diverifikasi', 'Sekarang buat PIN slip gaji yang baru.', 'Buat PIN baru']],
  ['kode-kedaluwarsa', ['Kode sudah kedaluwarsa', 'Buat kode baru', '00:00']],
  ['nomor-tidak-cocok', ['Nomor WhatsApp tidak cocok', 'Coba dari nomor terdaftar', '4821']],
  ['terlalu-banyak-percobaan', ['Terlalu banyak percobaan', '09:59', 'Lihat cara minta bantuan']],
  ['nomor-belum-terdaftar', ['Nomor WhatsApp belum terdaftar', 'Lihat cara minta bantuan', 'Kembali ke slip gaji']],
  ['bantuan-hr', ['Minta bantuan HR atau supervisor', 'Minta reset PIN', 'Buka slip gaji lagi', 'Kembali ke slip gaji']],
  ['buat-pin-baru', ['Buat PIN slip gaji', 'PIN baru', 'Ulangi PIN baru', 'Simpan PIN']],
];

function resolvePlaywright() {
  const roots = [
    path.resolve(directory, '../../..'),
    path.resolve(directory, '../../../../payslip-pin-ui'),
    path.resolve(directory, '../../../../..'),
  ];
  for (const root of roots) {
    try { return require(require.resolve('playwright', { paths: [root] })); } catch {}
    const pnpmRoot = path.join(root, 'node_modules/.pnpm');
    if (!fs.existsSync(pnpmRoot)) continue;
    for (const item of fs.readdirSync(pnpmRoot).filter((name) => /^playwright@/.test(name)).sort().reverse()) {
      const candidate = path.join(pnpmRoot, item, 'node_modules/playwright');
      if (fs.existsSync(path.join(candidate, 'package.json'))) return require(candidate);
    }
  }
  throw new Error('Playwright was not found in this worktree, the payslip reference worktree, or the main repository.');
}

function pngSize(file) {
  const png = fs.readFileSync(file);
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid PNG: ${file}`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
}

async function inspect(page, key, expected) {
  return page.evaluate(({ key, expected }) => {
    const normalise = (text) => text.replace(/\s+/g, ' ').trim();
    const bodyText = normalise(document.body.innerText);
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const label = (element) => normalise(element.innerText || element.getAttribute('aria-label') || element.tagName).slice(0, 100);
    const rectOf = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const horizontalOverflow = [...document.querySelectorAll('body *')].filter(visible).filter((element) => {
      const { left, right } = element.getBoundingClientRect();
      return left < -1 || right > innerWidth + 1;
    }).map((element) => ({ label: label(element), rect: rectOf(element) }));
    const clipped = [...document.querySelectorAll('p,h1,h2,h3,h4,button,a,code')].filter(visible).filter((element) => {
      const style = getComputedStyle(element);
      return ['hidden', 'clip'].includes(style.overflow) && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
    }).map((element) => label(element));
    const controls = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible).map((element) => ({ label: label(element), ...rectOf(element) }));
    const fontFaces = [...document.fonts].map((font) => ({ family: font.family, status: font.status }));
    const missingCopy = expected.filter((copy) => !bodyText.includes(normalise(copy)));
    const wrongLegacyCopy = [
      'Kami mengirim kode 6 angka', 'Masukkan 6 angka dari pesan WhatsApp', 'Kode sudah dikirim ke WhatsApp Anda',
    ].filter((copy) => bodyText.includes(copy));
    const activeWhatsAppOnFailure = ['kode-kedaluwarsa', 'terlalu-banyak-percobaan', 'nomor-belum-terdaftar'].includes(key)
      && controls.some((control) => control.label === 'Buka WhatsApp');
    const inputCount = document.querySelectorAll('input').length;
    const activeWaLinks = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((href) => /wa\.me|api\.whatsapp\.com/.test(href));
    const badInputs = key !== 'buat-pin-baru' && inputCount > 0;

    const parse = (color) => {
      const values = color.match(/[\d.]+/g)?.map(Number);
      if (!values || values.length < 3) return [0, 0, 0, 0];
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const composite = (front, back) => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      return [0, 1, 2].map((index) => alpha ? (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha : 0).concat(alpha);
    };
    const background = (element) => {
      const lineage = [];
      for (let node = element; node; node = node.parentElement) lineage.push(node);
      return lineage.reverse().reduce((color, node) => composite(parse(getComputedStyle(node).backgroundColor), color), [255, 255, 255, 1]);
    };
    const luminance = (color) => color.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const ratio = (front, back) => {
      const values = [luminance(front), luminance(back)].sort((a, b) => b - a);
      return (values[0] + .05) / (values[1] + .05);
    };
    // Only direct text nodes are measured, avoiding duplicate ancestor checks.
    // In the success modal the dimmed/inert background is intentionally excluded.
    const modal = document.querySelector('dialog[open], [role="dialog"]');
    const contrast = [...(modal || document.body).querySelectorAll('*')].filter(visible).filter((element) =>
      [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()),
    ).map((element) => {
      const style = getComputedStyle(element);
      const back = background(element);
      const front = composite(parse(style.color), back);
      const fontSize = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      const required = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700) ? 3 : 4.5;
      return { label: label(element), foreground: style.color, background: back.slice(0, 3).map(Math.round), fontSize, weight, ratio: Number(ratio(front, back).toFixed(2)), required };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      fontFaces,
      localJakartaLoaded: fontFaces.some((font) => /jakarta/i.test(font.family) && font.status === 'loaded'),
      missingCopy, wrongLegacyCopy, activeWhatsAppOnFailure, activeWaLinks, inputCount, badInputs,
      horizontalOverflow, clipped,
      undersizedControls: controls.filter((control) => control.width < 24 || control.height < 24),
      controls,
      contrast,
      contrastFailures: contrast.filter((sample) => sample.ratio + .01 < sample.required),
    };
  }, { key, expected });
}

async function inspectFooterPixels(page, fullPng, footerPng, footerBox) {
  return page.evaluate(async ({ full, footer, box }) => {
    const load = (source) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('PNG pixel decode failed'));
      image.src = source;
    });
    const images = await Promise.all([load(full), load(footer)]);
    const canvas = document.createElement('canvas');
    canvas.width = images[1].width;
    canvas.height = images[1].height;
    const context = canvas.getContext('2d');
    context.drawImage(images[0], Math.round(box.x), Math.round(box.y), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(images[1], 0, 0);
    const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let differingPixels = 0;
    for (let index = 0; index < actual.length; index += 4) {
      if ([0, 1, 2].some((channel) => Math.abs(actual[index + channel] - expected[index + channel]) > 20)) differingPixels += 1;
    }
    const totalPixels = canvas.width * canvas.height;
    return { width: canvas.width, height: canvas.height, differingPixels, totalPixels, passed: differingPixels / totalPixels <= .005 };
  }, { full: `data:image/png;base64,${fullPng.toString('base64')}`, footer: `data:image/png;base64,${footerPng.toString('base64')}`, box: footerBox });
}

async function main() {
  if (!fs.existsSync(path.join(directory, 'index.html'))) throw new Error('index.html is not ready. No screenshots were generated.');
  const { chromium } = resolvePlaywright();
  const chromePath = process.env.MOCKUP_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chromePath) ? { executablePath: chromePath } : {}) });
  const results = [];
  try {
    for (const [key, expected] of screens) {
      let page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // This source is self-contained. Any outgoing HTTP request is an export failure.
      const networkRequests = [];
      await page.route(/^https?:/, (route) => { networkRequests.push(route.request().url()); return route.abort(); });
      const url = pathToFileURL(path.join(directory, 'index.html'));
      url.searchParams.set('screen', key);
      await page.goto(url.href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      // Include the full long state while keeping the 390px mobile width.
      // Resizing before capture keeps the fixed bottom navigation below the content.
      let height = 844;
      const modalViewport = key === 'terverifikasi';
      for (let attempt = 0; !modalViewport && attempt < 3; attempt += 1) {
        const contentHeight = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
        if (contentHeight <= height) break;
        height = contentHeight;
        await page.setViewportSize({ width: 390, height });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      // A fresh page at the final viewport avoids reusing resized compositor
      // layers; Chrome can otherwise reuse the old fixed-nav tile incorrectly.
      await page.close();
      page = await browser.newPage({ viewport: { width: 390, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route(/^https?:/, (route) => { networkRequests.push(route.request().url()); return route.abort(); });
      await page.goto(url.href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForTimeout(150);
      const checks = await inspect(page, key, expected);
      const file = `${key}-mobile.png`;
      let footerPng;
      let footerBox;
      if (!modalViewport) {
        footerBox = await page.locator('.bottom-nav').boundingBox();
        footerPng = await page.locator('.bottom-nav').screenshot({ animations: 'disabled' });
      }
      const fullPng = await page.screenshot({ path: path.join(directory, file), fullPage: false, animations: 'disabled' });
      const footerPixels = modalViewport ? { passed: true, excluded: 'Navigation intentionally covered by modal backdrop.' } : await inspectFooterPixels(page, fullPng, footerPng, footerBox);
      const size = pngSize(path.join(directory, file));
      const failures = [];
      if (size.width !== 390 || size.height !== height || size.bytes === 0) failures.push('PNG dimensions/content');
      if (!checks.localJakartaLoaded) failures.push('Local Jakarta font did not load');
      if (checks.document.width !== 390 || checks.horizontalOverflow.length) failures.push('Horizontal overflow');
      if (!modalViewport && checks.document.height > height) failures.push('Vertical content cropped');
      if (checks.clipped.length) failures.push('Text clipped by overflow');
      if (checks.missingCopy.length) failures.push('Required copy missing');
      if (checks.wrongLegacyCopy.length || checks.badInputs) failures.push('Legacy OTP UI');
      if (checks.activeWhatsAppOnFailure) failures.push('Invalid WhatsApp action on terminal failure');
      if (checks.activeWaLinks.length) failures.push('Active external WhatsApp link in static mockup');
      if (checks.undersizedControls.length) failures.push('Control target below 24px');
      if (checks.contrastFailures.length) failures.push('Text contrast below AA');
      if (!footerPixels.passed) failures.push('Fixed navigation pixels differ from isolated navigation capture');
      if (errors.length || networkRequests.length) failures.push('Script error or external network request');
      results.push({ screen: key, file, png: size, passed: failures.length === 0, failures, errors, networkRequests, footerPixels, backgroundIntentionallyCropped: modalViewport, ...checks });
      console.log(`${key}: ${size.width}x${size.height}, ${failures.length ? `FAIL ${failures.join('; ')}` : 'PASS'}`);
      await page.close();
    }
  } finally { await browser.close(); }
  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Static design export. No app, WhatsApp, backend, keyboard flow, or real verification integration tested.',
    screenshotCount: results.length,
    width: 390,
    passed: results.length === 10 && results.every((result) => result.passed),
    results,
  };
  fs.writeFileSync(path.join(directory, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
