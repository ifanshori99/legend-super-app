import { chromium } from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
for (const width of [1280,1440,390]) {
 const page=await browser.newPage({viewport:{width,height:844},deviceScaleFactor:1});
 for (const state of ['normal','loading','empty','error','validation','success','reminder']) {
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.join(dir,'pos-extra-ijv8-sarapan.html')).href+'?screen='+state);
  await page.evaluate(()=>document.fonts.ready);
  const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,heading:document.querySelector('h1').innerText}));
  if(errors.length||result.overflow)throw Error(JSON.stringify({width,state,errors,result}));
  await page.screenshot({path:path.join(dir,`pos-extra-ijv8-sarapan-${state}-${width}.png`),fullPage:true});
  console.log(width,state,JSON.stringify(result));
 }
 await page.close();
}
await browser.close();
