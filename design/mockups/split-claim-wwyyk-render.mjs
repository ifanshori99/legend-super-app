import { chromium } from '../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
for(const state of ['belum-bayar','siap','sedang-klaim','berhasil','sudah-diklaim','kedaluwarsa','error']){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${pathToFileURL(path.join(dir,'split-claim-wwyyk.html')).href}?state=${state}`);await page.evaluate(()=>document.fonts.ready);
 const metrics=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,mainBottom:document.querySelector('#main').getBoundingClientRect().bottom,footerTop:document.querySelector('#footer').getBoundingClientRect().top}));
 if(metrics.width>metrics.viewport||metrics.mainBottom>metrics.footerTop||errors.length) throw new Error(`${state}: ${JSON.stringify({metrics,errors})}`);
 await page.screenshot({path:path.join(dir,`split-claim-wwyyk-${state}-mobile.png`)});console.log(state,JSON.stringify(metrics));
}
await browser.close();
