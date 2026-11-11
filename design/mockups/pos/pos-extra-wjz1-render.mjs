import { chromium } from '../../../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir=path.resolve('design/mockups/pos');
const browser=await chromium.launch({headless:true});
for(const width of [1280,1440,390]){
 const page=await browser.newPage({viewport:{width,height:width===390?844:800}});
 for(const state of ['normal','kosong','loading','error','sukses','validasi']){
  await page.goto(pathToFileURL(path.join(dir,'pos-extra-wjz1-label-prep.html')).href+'?screen='+state);
  await page.locator('.screen.active').waitFor();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw new Error(`${state} ${width}: horizontal overflow`);
  await page.screenshot({path:path.join(dir,`pos-extra-wjz1-label-prep-${state}-${width}.png`),fullPage:true});
 }
 if(width===1280){await page.goto(pathToFileURL(path.join(dir,'pos-extra-wjz1-label-prep.html')).href+'?screen=normal');await page.pdf({path:'/tmp/legend-wjz1-label.pdf',format:'A4',printBackground:true});}
 await page.close();
}
await browser.close();
console.log('18 screenshots rendered; no horizontal overflow.');
