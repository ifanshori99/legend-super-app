// Static design exports only; no application or payment requests.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const folder = new URL('./', import.meta.url);
const states = [
  ['a', 'a-basi-kurang-24-jam'],
  ['b', 'b-ditahan-lebih-24-jam'],
  ['c', 'c-jam-mundur'],
  ['d', 'd-form-izin-owner'],
  ['e', 'e-promo-mati'],
];
const browser = await chromium.launch({ headless: true });
for (const [key, name] of states) {
  for (const [label, width, height] of [['mobile', 390, 844], ['desktop', 1440, 900]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(new URL(`source.html?s=${key}`, folder).href);
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page.screenshot({ path: fileURLToPath(new URL(`q61-${name}-${label}.png`, folder)) });
    console.log(name, label, overflow ? 'HORIZONTAL OVERFLOW' : 'ok');
    await page.close();
  }
}
await browser.close();
