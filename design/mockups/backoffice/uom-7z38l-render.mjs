import { chromium } from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
for (const [device, width, height] of [['desktop', 1280, 1000], ['mobile', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  for (const state of ['normal', 'add', 'edit', 'invalid', 'duplicate', 'reserved', 'empty', 'error', 'loading', 'success']) {
    await page.goto(`${pathToFileURL(path.join(dir, 'uom-7z38l.html')).href}?state=${state}`);
    await page.evaluate(() => document.fonts.ready);
    const size = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth }));
    if (size.scrollWidth > size.viewport) throw new Error(`${state} ${device}: horizontal overflow`);
    await page.screenshot({ path: path.join(dir, `uom-7z38l-${state}-${device}.png`), fullPage: true });
    console.log(state, device, JSON.stringify(size));
  }
  await page.close();
}
await browser.close();
