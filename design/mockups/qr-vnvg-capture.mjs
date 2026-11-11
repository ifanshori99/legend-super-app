import { chromium } from '../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath } from 'node:url';
const browser=await chromium.launch({headless:true});
for (const state of ['member','poin','kosong','error','loading','sukses']) {
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(new URL(`qr-vnvg-member.html?layar=${state}`,import.meta.url).href);
 await page.evaluate(()=>document.fonts.ready);
 const check=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,font:document.fonts.check('16px Jakarta')}));
 await page.screenshot({path:fileURLToPath(new URL(`qr-vnvg-${state}-mobile.png`,import.meta.url)),fullPage:true});
 console.log(JSON.stringify({state,...check,errors}));
 if(check.width!==390 || !check.font || errors.length) throw Error(`Gagal: ${state}`);
 await page.close();
}
await browser.close();
