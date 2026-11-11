import { chromium } from '../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath } from 'node:url';
const dir = new URL('./', import.meta.url);
const browser = await chromium.launch({headless:true});
for (const state of ['menu','kosong','memuat','gagal','detail','detail-tanpa-foto','detail-error']) {
  const page = await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
  const errors=[]; page.on('pageerror', e=>errors.push(e.message)); page.on('requestfailed', r=>errors.push(r.url()));
  await page.goto(new URL(`qr-tct6-menu.html?layar=${state}`,dir).href);
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:fileURLToPath(new URL(`qr-tct6-${state}-mobile.png`,dir))});
  const checks=await page.evaluate(()=>({width:document.documentElement.scrollWidth,font:document.fonts.check('16px Jakarta'),missing:[...document.images].filter(i=>!i.complete||!i.naturalWidth).length}));
  console.log(JSON.stringify({state,errors,...checks}));
  if(errors.length||checks.width!==390||!checks.font||checks.missing) throw new Error(`Verification failed: ${state}`);
  await page.close();
}
await browser.close();
