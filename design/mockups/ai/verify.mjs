import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Run with heavy. A shared installed browser package may be used for this static
// design audit, without symlinking dependencies into the application checkout.
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../../..');
let modulePath = process.env.LEGEND_PLAYWRIGHT_MODULE;
if (!modulePath) {
  try { modulePath = createRequire(path.join(root, 'package.json')).resolve('@playwright/test'); }
  catch {
    const store = path.resolve(root, '../legend/node_modules/.pnpm');
    const installed = existsSync(store) && readdirSync(store).find(name => name.startsWith('@playwright+test@1.63.0'));
    if (installed) modulePath = path.join(store, installed, 'node_modules/@playwright/test/index.mjs');
  }
}
if (!modulePath) throw new Error('Set LEGEND_PLAYWRIGHT_MODULE to the installed Playwright module');
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ headless: true });
const states = ['empty', 'device', 'connected', 'failed', 'expired', 'detected', 'disabled'];
const base = pathToFileURL(path.join(dir, 'ai-settings.html')).href;
const results = [];
const runtimeErrors = [];
const externalRequests = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.route(/^https?:/, route => {
    externalRequests.push(route.request().url());
    return route.abort();
  });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const state of states) {
      await page.goto(`${base}?state=${state}`);
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth,
        content: document.documentElement.scrollWidth,
        fontLoaded: document.fonts.check('16px Jakarta'),
        heading: document.querySelector('h1')?.textContent,
        clipped: [...document.querySelectorAll('h1,h2,h3,p,label,button,input,summary,a')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
        }).map(el => ({ tag: el.tagName, text: el.textContent.slice(0, 80) })),
      }));
      assert.equal(geometry.heading?.trim(), 'Pengaturan AI');
      assert.ok(geometry.content <= width, `${state}/${width}: horizontal overflow`);
      assert.equal(geometry.clipped.length, 0, `${state}/${width}: clipped elements`);
      assert.equal(await page.locator('#custom-api-key').inputValue(), '', 'Stored key must never be prefilled');
      if (state === 'disabled') {
        const enabled = await page.locator('#settingsControls input:enabled, #settingsControls select:enabled, #settingsControls button:enabled').count();
        assert.equal(enabled, 0, 'Platform kill switch must disable every setting control');
      }
      if (state === 'device') {
        assert.equal(await page.locator('a[href="https://auth.openai.com/codex/device"]').count(), 1);
      }
      results.push({ state, width, ...geometry });
    }
  }

  await page.goto(`${base}?state=empty`);
  assert.equal(await page.locator('#connect-chatgpt').isDisabled(), true);
  await page.locator('#risk-consent').check();
  assert.equal(await page.locator('#connect-chatgpt').isEnabled(), true);
  await page.locator('#connect-chatgpt').click();
  assert.equal(await page.locator('a[href="https://auth.openai.com/codex/device"]').count(), 1);
  results.push({ check: 'Owner risk consent gates device login', pass: true });

  for (const state of ['empty', 'connected', 'device']) {
    await page.goto(`${base}?state=${state}&role=admin`);
    for (const id of ['connect-chatgpt', 'revoke-chatgpt']) {
      const control = page.locator(`#${id}`);
      if (await control.count()) assert.equal(await control.isDisabled(), true, `Admin cannot use ${id}`);
    }
  }
  results.push({ check: 'Admin cannot start or revoke owner login', pass: true });

  await page.goto(`${base}?state=connected`);
  await page.locator('#revoke-chatgpt').click();
  const dialog = page.locator('dialog[open]');
  assert.equal(await dialog.count(), 1, 'Revocation must require confirmation');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#revoke-chatgpt').count(), 1, 'Cancel preserves connection');
  results.push({ check: 'Revocation opens a cancellable native dialog', pass: true });

  await page.goto(`${base}?state=empty`);
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    outline: getComputedStyle(document.activeElement).outlineStyle,
  }));
  assert.notEqual(focus.tag, 'BODY');
  assert.notEqual(focus.outline, 'none');
  results.push({ check: 'Keyboard focus is visible', ...focus, pass: true });
  assert.equal(runtimeErrors.length, 0, JSON.stringify(runtimeErrors));
  assert.equal(externalRequests.length, 0, 'Static mockup must not call a provider');
  writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({
    scope: 'Static design only; no real OAuth, API, budget charge, or production behavior tested',
    browser: 'Chromium via Playwright 1.63.0', runtimeErrors, externalRequests, results,
  }, null, 2) + '\n');
  console.log(`PASS: ${results.length} layout/interaction checks; no runtime errors or external requests`);
} finally {
  await browser.close();
}
