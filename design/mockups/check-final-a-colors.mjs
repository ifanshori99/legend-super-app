// Static mockup text-pair audit. Not an application accessibility certification.
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const dir = new URL('./', import.meta.url);
const browser = await chromium.launch({ headless: true });
const results = [];
for (const screen of ['menu', 'awal', 'tamu', 'detail', 'checkout', 'qris', 'kasir', 'berhasil', 'habis', 'desktop']) {
  const page = await browser.newPage({ viewport: { width: screen === 'desktop' ? 1440 : 390, height: screen === 'desktop' ? 900 : screen === 'tamu' ? 960 : 844 } });
  await page.goto(new URL(screen === 'desktop' ? 'final-a-desktop.html' : `final-a-mobile.html?layar=${screen}`, dir).href);
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    function rgba(value) {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      const c = [...ctx.getImageData(0, 0, 1, 1).data]; return [...c.slice(0, 3), c[3] / 255];
    }
    const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    const lum = rgb => rgb.map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((a, x, i) => a + x * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
    const pairs = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!node.textContent.trim() || !parent.checkVisibility() || ['SCRIPT', 'STYLE'].includes(parent.tagName)) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if (![...range.getClientRects()].some(r => r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) continue;
      const chain = []; for (let p = parent; p; p = p.parentElement) chain.unshift(p);
      let backgrounds = [[255, 255, 255]], glass = false;
      for (const p of chain) {
        const style = getComputedStyle(p), bg = rgba(style.backgroundColor);
        if (style.backdropFilter !== 'none') { backgrounds = [[0, 0, 0], [255, 255, 255]]; glass = true; }
        backgrounds = backgrounds.map(x => blend(bg, x));
        if (bg[3] === 1) glass = false;
      }
      const fg = rgba(getComputedStyle(parent).color);
      const values = backgrounds.map(bg => ratio(blend(fg, bg), bg));
      const value = Math.min(...values);
      const key = `${getComputedStyle(parent).color}|${backgrounds.map(x => x.map(Math.round).join(',')).join(';')}`;
      const previous = pairs.get(key);
      if (!previous) pairs.set(key, { foreground: getComputedStyle(parent).color, backgrounds, minRatio: Number(value.toFixed(3)), glassExtremeCheck: glass, sample: node.textContent.trim().slice(0, 85) });
    }
    const all = [...pairs.values()];
    return { textPairs: all, minimum: Math.min(...all.map(x => x.minRatio)), failures: all.filter(x => x.minRatio < 4.5) };
  });
  results.push({ screen, ...result });
  await page.close();
}
await browser.close();
await writeFile(new URL('verification-final-a-colors.json', dir), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results.map(({ screen, minimum, textPairs, failures }) => ({ screen, minimum, pairCount: textPairs.length, failures })), null, 2));
if (results.some(x => x.failures.length)) process.exitCode = 1;
