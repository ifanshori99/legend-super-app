// Static design exports only; no application or payment requests.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
const folder = new URL('./', import.meta.url);
const browser = await chromium.launch({ headless: true });
const audit = [];
for (const direction of ['a', 'b']) {
  for (const [name, screen, width, height] of [
    ['menu-mobile', 'menu', 390, direction === 'a' ? 960 : 844],
    ['detail-mobile', 'detail', 390, direction === 'a' ? 960 : 844],
    ['checkout-mobile', 'checkout', 390, 844],
    ['pembayaran-berhasil-mobile', 'success', 390, 844],
    ['menu-desktop', 'menu', 1440, 900],
    ...(direction === 'b' ? [['kode-kasir-mobile', 'cashier', 390, 844]] : []),
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL(`source.html?arah=${direction}&layar=${screen}`, folder).href);
    await page.evaluate(() => document.fonts.ready);
    const checks = await page.evaluate(() => {
      const app = document.querySelector('.app');
      const viewport = { width: innerWidth, height: innerHeight };
      const textOutside = [];
      const hiddenByFooter = [];
      const footer = document.querySelector('.fixed-bottom, .floating');
      const footerBox = footer?.getBoundingClientRect();
      const walker = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim() || !node.parentElement.checkVisibility()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight) textOutside.push(node.textContent.trim());
          if (footerBox?.height && rect.bottom > footerBox.top && rect.top < footerBox.bottom && rect.right > footerBox.left && rect.left < footerBox.right && !footer.contains(node)) hiddenByFooter.push(node.textContent.trim());
        }
      }
      return { viewport, documentWidth: document.documentElement.scrollWidth, textOutside: [...new Set(textOutside)], hiddenByFooter: [...new Set(hiddenByFooter)] };
    });
    const filename = `arah-${direction}-${name}.png`;
    await page.screenshot({ path: fileURLToPath(new URL(filename, folder)), fullPage: false });
    audit.push({ filename, errors, ...checks });
    await page.close();
  }
}
await browser.close();
await writeFile(new URL('verification.json', folder), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify(audit, null, 2));
