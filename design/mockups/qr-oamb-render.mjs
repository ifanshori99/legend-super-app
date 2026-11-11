import { chromium } from '../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath } from 'node:url';
const dir = new URL('./', import.meta.url);
const browser = await chromium.launch({ headless: true });
let failed = false;
for (const state of ['normal','empty','error','loading','confirm','rotated']) for (const [size,width,height] of [['mobile',390,844],['desktop',1280,900]]) {
 const page = await browser.newPage({ viewport:{width,height},deviceScaleFactor:1 });
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(new URL(`qr-oamb-sheet.html?state=${state}`,dir).href); await page.evaluate(()=>document.fonts.ready);
 const info=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,missing:[...document.images].filter(x=>!x.complete||!x.naturalWidth).map(x=>x.src),labels:document.querySelectorAll('.label').length, labelOverflow:[...document.querySelectorAll('.label')].filter(el=>{const a=el.getBoundingClientRect(),b=el.parentElement.getBoundingClientRect();return a.left < b.left || a.right > b.right}).length}));
 const path=fileURLToPath(new URL(`qr-oamb-${state}-${size}.png`,dir)); await page.screenshot({path,fullPage:true});
 console.log(JSON.stringify({state,size,...info,errors})); if(errors.length||info.scrollWidth>width||info.missing.length||info.labelOverflow) failed=true;
 await page.close();
}
await browser.close(); if(failed)process.exitCode=1;
