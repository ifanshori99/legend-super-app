import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || require.resolve('playwright', {
  paths: [process.cwd(), path.resolve(process.cwd(), '../legend')],
}));
const dir = path.dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(path.join(dir, 'edc-reconciliation.html')).href;
const browser = await chromium.launch({
  executablePath: process.env.GHOSTEX_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const report = { scope: 'Standalone mockup only; no real payment or MFA tested', errors: [], checks: [] };
try {
  const page = await browser.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const state of ['list', 'detail', 'waiting', 'approved', 'declined', 'confirmation', 'empty', 'error', 'loading', 'save-error', 'success']) {
      await page.goto(`${url}?state=${state}`);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}/${state}: horizontal overflow`);
      if (state === 'waiting') {
        assert.equal(await page.locator('#resolve').isDisabled(), true);
        assert.equal(await page.locator('#charged').isDisabled(), true);
        assert.equal(await page.locator('#source').isDisabled(), true);
        await page.locator('#wait-refresh').click();
        assert.equal(await page.locator('#resolve').isDisabled(), true);
      }
      if (state === 'approved') assert.equal(await page.locator('[name=outcome][value=declined]').isDisabled(), true);
      if (state === 'declined') assert.equal(await page.locator('[name=outcome][value=approved]').isDisabled(), true);
      if (width !== 320 && ['detail', 'waiting', 'confirmation', 'empty', 'error', 'save-error', 'success'].includes(state)) {
        await page.screenshot({ path: path.join(dir, `${state}-${width === 1440 ? 'desktop' : 'mobile'}.png`), fullPage: !['confirmation', 'save-error'].includes(state) });
      }
      report.checks.push(`${width}px/${state}: fits`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}?state=detail`);
  await page.locator('#charged').fill('425001');
  await page.locator('#resolve').click();
  assert.equal(await page.locator('#confirm').isVisible(), false);
  assert.match(await page.locator('#validation').textContent(), /berbeda/);
  await page.locator('#charged').fill('425000');
  await page.locator('#resolve').click();
  await page.locator('#ack').check();
  await page.locator('#mfa').fill('000000');
  await page.locator('#confirm-submit').click();
  assert.equal(await page.locator('#confirm').isVisible(), true);
  assert.match(await page.locator('#mfa-error').textContent(), /tidak cocok/);
  await page.locator('#mfa').fill('123456');
  await page.locator('#confirm-submit').click();
  await page.locator('#confirm').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#live').textContent(), /Rekonsiliasi diselesaikan/);
  assert.match(await page.locator('#detail-badge').textContent(), /Approved/);
  assert.equal(await page.locator('#resolve').isDisabled(), true);
  await page.locator('#back').click();
  assert.equal(await page.locator('[data-id="EDC-1048"]').count(), 0);
  report.checks.push('Mismatched amount blocked; invalid MFA blocked; successful simulation removes resolved row and prevents repeat submission');
  await page.goto(`${url}?state=detail`);
  await page.locator('[name=outcome][value=declined]').check();
  await page.locator('#note').fill('Inquiry terminal menunjukkan declined. Bukti sudah diperiksa.');
  await page.locator('#resolve').click();
  assert.match(await page.locator('#confirm-outcome').textContent(), /Declined/);
  await page.locator('#ack').check();
  await page.locator('#mfa').fill('123456');
  await page.locator('#confirm-submit').click();
  await page.locator('#confirm').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#detail-badge').textContent(), /Declined/);
  report.checks.push('Declined simulation records declined outcome');
  await page.goto(`${url}?state=save-error`);
  await page.locator('#ack').check();
  await page.locator('#mfa').fill('123456');
  await page.locator('#confirm-submit').click();
  assert.equal(await page.locator('#confirm').isVisible(), true);
  assert.equal(await page.locator('#live').textContent(), '');
  report.checks.push('Save failure does not report success');
  assert.deepEqual(report.errors, []);
  report.result = 'PASS';
} finally {
  await browser.close();
  await fs.writeFile(path.join(dir, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`${report.result}: ${report.checks.length} checks, ${report.errors.length} browser errors`);
