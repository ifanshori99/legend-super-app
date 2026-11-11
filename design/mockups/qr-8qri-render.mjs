import { chromium } from '../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath } from 'node:url';
const dir = new URL('./', import.meta.url);
const browser = await chromium.launch({headless:true});
for (const screen of ['normal','pembayaran','kosong','error','loading']) {
 const page = await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('requestfailed',r=>errors.push(r.url()));
 await page.goto(new URL(`qr-8qri-shell.html?layar=${screen}`,dir).href); await page.evaluate(()=>document.fonts.ready);
 const check=await page.evaluate(()=>({width:document.documentElement.scrollWidth,missing:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src),font:document.fonts.check('16px Jakarta')}));
 await page.screenshot({path:fileURLToPath(new URL(`qr-8qri-${screen}-mobile.png`,dir))});
 console.log(JSON.stringify({screen,errors,...check})); if(errors.length||check.missing.length||check.width!==390||!check.font) throw Error(`Gagal ${screen}`); await page.close();
}
await browser.close();
